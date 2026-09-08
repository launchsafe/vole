import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import type { DB } from '../db';
import { classifyPath, splitCommandSegments, tokenize, stripPrefixes } from './patterns';
import { widenUpsert, type UpsertSpec } from './upsert';

/**
 * The file-write ledger (feature 29 + the t6 envelope columns it stamps):
 * EVERY write target — structured Edit/Write results AND the Bash redirect /
 * heredoc / tee / cp / mv / install / sed -i / patch targets the v1 ledger
 * declared out of scope. A target containing variables, globs or heredoc-
 * generated names is written with path = NULL: 'unresolved', never dropped and
 * never counted as zero. The parse is a shell-shaped heuristic, not a shell —
 * quoting edge cases degrade to unresolved, which is the honest answer.
 */

export interface FileWriteRow {
  write_key: string;
  tool_call_key: string | null;
  session_id: string | null;
  path: string | null;
  path_class: string | null;
  write_class: string;
  change_risk_class: string | null;
  class_pattern_id: string | null;
  content_rev: number | null;
  escape_state: string | null;
  visibility_class: string | null;
  ts: number | null;
}

/** A token we refuse to resolve to a concrete path (variable, glob, backtick). */
const UNRESOLVABLE = /[$*?`]/;

function expandTilde(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/' ) ? join(homedir(), p.slice(2)) : p;
}

interface Target {
  raw: string;
  write_class: string;
}

/** Write targets of one shell command, in order of appearance. */
export function bashWriteTargets(command: string): Target[] {
  const out: Target[] = [];
  for (const seg of splitCommandSegments(command)) {
    const heredoc = /<<-?\s*\S+/.test(seg); // heredoc-ness is a property of THIS segment
    const toks = stripPrefixes(tokenize(seg));
    if (!toks.length) continue;
    const head = toks[0]!.replace(/^["']|["']$/g, '');
    const operands = (i: number) => toks.slice(i).filter((t) => !t.startsWith('-'));
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      // >, >>, 2>, &> — the token itself or attached to the filename.
      const m = /^(?:\d)?>>?(.*)$|^(?:\&>)(.*)$/.exec(t);
      if (m && (m[1] !== undefined || m[2] !== undefined)) {
        const attached = m[1] || m[2];
        const target = attached || toks[i + 1];
        if (target && !target.startsWith('-')) {
          out.push({ raw: target, write_class: heredoc ? 'heredoc' : 'bash_redirect' });
        }
      }
    }
    if (head === 'tee') {
      for (const t of toks.slice(1)) {
        if (!t.startsWith('-') && !/^--?\w/.test(t)) out.push({ raw: t, write_class: 'bash_redirect' });
      }
    } else if (head === 'cp' || head === 'mv' || head === 'install') {
      const ops = toks.slice(1).filter((t) => !t.startsWith('-'));
      if (ops.length >= 2) out.push({ raw: ops[ops.length - 1]!, write_class: 'copy' });
    } else if (head === 'sed') {
      // sed -i [suffix] script file... — operands after the script.
      const rest = toks.slice(1);
      if (rest.some((t) => /^-i/.test(t))) {
        const after = rest.slice(rest.findIndex((t) => /^-i/.test(t)) + 1);
        // The first operand following the (optionally separate) -i suffix is the script.
        for (const t of after.slice(1)) {
          if (!t.startsWith('-')) out.push({ raw: t, write_class: 'bash_redirect' });
        }
      }
    } else if (head === 'patch') {
      const ops = toks.slice(1).filter((t) => !t.startsWith('-'));
      const file = ops[ops.length - 1];
      if (file) out.push({ raw: file, write_class: 'bash_redirect' });
    }
  }
  return out;
}

/** The structured write tools' targets (Edit/Write/MultiEdit/NotebookEdit). */
export function structuredWriteTarget(name: string, args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const p = a.file_path ?? a.notebook_path ?? a.path;
  return typeof p === 'string' ? p : null;
}

const STRUCTURED_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write', 'edit']);

export interface WriteContext {
  tool_call_key: string;
  session_id?: string | null;
  ts?: number | null;
  cwd?: string | null;
}

/** One tool call -> its file-write rows. Bash commands get every target,
 *  structured tools get their file_path. Unresolved targets keep NULL paths. */
export function fileWritesForCall(
  name: string,
  args: unknown,
  ctx: WriteContext,
): FileWriteRow[] {
  const rows: FileWriteRow[] = [];
  const command =
    typeof args === 'string'
      ? args
      : args && typeof args === 'object' && typeof (args as Record<string, unknown>).command === 'string'
        ? ((args as Record<string, unknown>).command as string)
        : null;
  const emit = (raw: string | null, writeClass: string, idx: number) => {
    let path: string | null = null;
    let visibility: string | null = null;
    if (raw && !UNRESOLVABLE.test(raw)) {
      const expanded = expandTilde(raw.replace(/^["']|["']$/g, ''));
      path = isAbsolute(expanded) ? expanded : ctx.cwd ? resolvePath(ctx.cwd, expanded) : null;
      // No cwd and a relative path: the target is knowable only as a string —
      // keep it unqualified rather than resolving against Vole's own cwd.
      if (path === null && !ctx.cwd && !isAbsolute(expanded)) path = expanded;
      if (path && ctx.cwd && !path.startsWith(ctx.cwd)) visibility = 'outside_repo';
    }
    const cls = path ? classifyPath(path) : null;
    rows.push({
      write_key: `${ctx.tool_call_key}#${idx}`,
      tool_call_key: ctx.tool_call_key,
      session_id: ctx.session_id ?? null,
      path,
      path_class: cls?.class ?? null,
      write_class: writeClass,
      change_risk_class: cls?.change_risk_class ?? null,
      class_pattern_id: cls?.pattern_id ?? null,
      content_rev: null, // stamped at insert — a count, never content
      escape_state: null, // local/committed/pushed is a later VCS-join fact, unknown at write time
      visibility_class: visibility,
      ts: ctx.ts ?? null,
    });
  };

  if (STRUCTURED_WRITE_TOOLS.has(name)) {
    const t = structuredWriteTarget(name, args);
    emit(t, 'structured', 0);
    return rows;
  }
  if (command && (name === 'Bash' || name === 'bash' || name === 'shell' || name === 'exec_command')) {
    bashWriteTargets(command).forEach((t, i) => emit(t.raw, t.write_class, i));
  }
  return rows;
}

const UPSERT: UpsertSpec = {
  table: 'file_writes',
  keyCols: ['write_key'],
  cols: [
    'tool_call_key', 'session_id', 'path', 'path_class', 'write_class',
    'change_risk_class', 'class_pattern_id', 'content_rev', 'escape_state',
    'visibility_class', 'ts',
  ],
  stamped: true,
};

/**
 * Bind write rows. content_rev is a per-(session, path) count of writes already
 * in the ledger + 1 — a count, never content. It is only computed for rows the
 * upsert actually inserts, so re-reading a source re-derives the same number.
 */
export function insertFileWrites(db: DB, rows: FileWriteRow[]): number {
  if (!rows.length) return 0;
  const countStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM file_writes WHERE session_id IS ? AND path IS ?',
  );
  let changed = 0;
  for (const r of rows) {
    const withRev: FileWriteRow = { ...r };
    if (r.path !== null && r.session_id != null) {
      const prev = countStmt.get(r.session_id, r.path) as { n: number };
      withRev.content_rev = prev.n + 1;
    }
    changed += widenUpsert(db, UPSERT, [withRev]);
  }
  return changed;
}

/** Convenience: distinct dirs of a set of paths (for the blast-radius counters). */
export function distinctDirs(paths: string[]): number {
  return new Set(paths.map(dirname)).size;
}
