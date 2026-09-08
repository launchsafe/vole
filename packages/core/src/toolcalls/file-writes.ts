import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import type { DB } from '../db';
import { classifyPath, splitCommandSegments, syncPathClasses, tokenize, stripPrefixes } from './patterns';
import { widenUpsert, type UpsertSpec } from './upsert';
import { commandOf } from './net-ledgers';

/**
 * The file-write ledger (feature 29 + the t6 envelope columns it stamps):
 * EVERY write target — structured Edit/Write results AND the Bash redirect /
 * heredoc / tee / cp / mv / install / sed -i / patch targets the v1 ledger
 * declared out of scope. A target containing variables, globs or heredoc-
 * generated names is written with path = NULL: 'unresolved', never dropped and
 * never counted as zero. The parse is a shell-shaped heuristic, not a shell —
 * quoting edge cases degrade to unresolved, which is the honest answer.
 *
 * Two entry paths, like the net ledgers:
 *   1. BIND TIME (rich): collectors hold the raw arguments and pass them as
 *      `args`; targets resolve to real paths. Names and argument keys cover the
 *      vendors actually observed in the wild (claude_code, opencode, codex,
 *      grok). ponytail: name/key lists are extended when a new vendor shows up,
 *      not speculatively.
 *   2. FROM STORE (coarse): emitFileWrites(db) re-derives what the stored rows
 *      alone can prove — a structured write tool's name proves a write, a tee/
 *      cp/mv/… shape head proves a copy/redirect — with path left NULL
 *      ("target not recorded", never guessed) because the store never kept the
 *      arguments, only their digest.
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
      const iIdx = rest.findIndex((t) => /^-i/.test(t));
      if (iIdx >= 0) {
        let after = rest.slice(iIdx + 1);
        // macOS writes a SEPARATE (often empty) suffix argument: sed -i "" s/a/b/ f.
        if (rest[iIdx] === '-i' && (after[0] === '""' || after[0] === "''")) after = after.slice(1);
        // The first remaining operand is the script; everything after it is a file.
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

/** The structured write tools seen in real ledgers. apply_patch's input is a
 *  patch body, not an args object, so it gets its own path extraction. */
const STRUCTURED_WRITE_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write', 'edit', 'apply_patch', 'search_replace',
]);

/** File targets named by a patch body (opencode patchText, codex input string). */
function applyPatchTargets(text: string): string[] {
  const out: string[] = [];
  const re = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]!.trim());
  return out;
}

/** The structured write tools' targets (Edit/Write/MultiEdit/NotebookEdit +
 *  patch tools). Real sources name the file under file_path (claude_code),
 *  filePath (opencode), notebook_path (jupyter) or path. */
export function structuredWriteTargets(name: string, args: unknown): string[] {
  if (name === 'apply_patch') {
    if (typeof args === 'string') return applyPatchTargets(args);
    if (args && typeof args === 'object') {
      const a = args as Record<string, unknown>;
      for (const k of ['patchText', 'input', 'patch']) {
        if (typeof a[k] === 'string') return applyPatchTargets(a[k] as string);
      }
    }
    return [];
  }
  if (!args || typeof args !== 'object') return [];
  const a = args as Record<string, unknown>;
  for (const k of ['file_path', 'filePath', 'notebook_path', 'path']) {
    if (typeof a[k] === 'string') return [a[k] as string];
  }
  return [];
}

/** The shell-ish tools whose command string can name write targets. Exported
 *  for the collectors, which gate the `command` derivation channel on it. */
export const BASH_TOOLS = new Set(['Bash', 'bash', 'shell', 'exec_command', 'exec', 'run_terminal_command']);

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
  const command = commandOf(name, args);
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
    // The call itself is a write of a file we could not name: still a row,
    // path NULL — 'not recorded', never counted as zero.
    const targets = structuredWriteTargets(name, args);
    if (targets.length) targets.forEach((t, i) => emit(t, 'structured', i));
    else emit(null, 'structured', 0);
    return rows;
  }
  if (command && BASH_TOOLS.has(name)) {
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

// ── from-store emission (the coarse half, no collector changes required) ─────

/** Shape heads that prove a write on their own (the stored skeleton keeps the
 *  head; sed/patch without -i/-o are NOT provable, so they are absent). */
const COARSE_WRITE_HEADS: Record<string, string> = {
  tee: 'bash_redirect',
  dd: 'bash_redirect',
  cp: 'copy',
  mv: 'copy',
  install: 'copy',
  rsync: 'copy',
};

/**
 * Re-derive file-write rows from the stored tool_calls: every structured write
 * tool's name proves one write, every tee/cp/mv/… shape head proves a copy or
 * redirect — with path NULL, because the store holds the args digest, never
 * the args. Rows are emitted only for calls that have no row in file_writes
 * yet, so the pass is idempotent; a bind-time rich row (with the real path)
 * for the same call lands on the same `#0` key and widens it. Also syncs the
 * versioned path-class pack — the registry the ledger's path_class values are
 * entries of.
 */
export function emitFileWrites(db: DB): number {
  syncPathClasses(db);
  const presence = new Set(
    (db.prepare('SELECT DISTINCT tool_call_key AS k FROM file_writes').all() as { k: string }[]).map((r) => r.k),
  );
  const calls = db
    .prepare('SELECT tool_call_key AS key, name, shape, session_id, ts FROM tool_calls')
    .all() as { key: string; name: string; shape: string | null; session_id: string | null; ts: number }[];
  const rows: FileWriteRow[] = [];
  for (const c of calls) {
    if (presence.has(c.key)) continue;
    if (STRUCTURED_WRITE_TOOLS.has(c.name)) {
      rows.push({ ...coarseRow(c.key, c.session_id, c.ts), write_class: 'structured' });
    } else if (c.shape) {
      const wc = COARSE_WRITE_HEADS[c.shape.split(' ')[0] ?? ''];
      if (wc) rows.push({ ...coarseRow(c.key, c.session_id, c.ts), write_class: wc });
    }
  }
  return insertFileWrites(db, rows);
}

function coarseRow(
  key: string,
  session_id: string | null,
  ts: number,
): Omit<FileWriteRow, 'write_class'> {
  return {
    write_key: `${key}#0`,
    tool_call_key: key,
    session_id,
    path: null,          // the target is not recoverable from the store — NULL, never guessed
    path_class: null,
    change_risk_class: null,
    class_pattern_id: null,
    content_rev: null,
    escape_state: null,
    visibility_class: null,
    ts,
  };
}
