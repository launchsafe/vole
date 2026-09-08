import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { DB } from '../db';
import { paths } from '../paths';

/**
 * Shared substrate for the posture family: config readers (JSONC, a TOML subset),
 * the cross-poll JSON state file, and the small upsert helpers every module uses.
 * All path constants here are env-overridable the same way paths.ts is — the
 * foundation should absorb them (see integration notes); they live locally so
 * this batch owns no file outside its cluster.
 */

export const home = (): string => process.env.VOLE_HOME_OVERRIDE ?? homedir();

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export function readJson(file: string): unknown | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** JSONC: strip line + block comments and trailing commas — no new dependency. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      const quote = c;
      out += c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') { out += text[i]! + (text[i + 1] ?? ''); i += 2; continue; }
        out += text[i]!;
        i++;
      }
      out += text[i] ?? '';
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += c;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function readJsonc(file: string): unknown | undefined {
  try {
    return JSON.parse(stripJsonc(readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/** Host of a URL-shaped config value — the value itself never reaches the store. */
export function parseHost(value: string): string | null {
  try {
    const u = new URL(value);
    return u.host || null;
  } catch {
    return null;
  }
}

/** The TOML subset the agent configs actually use: [section] headers plus
 *  key = "string" | 'string' | boolean | [array, "of", strings] | bare words. */
export interface TomlDoc { sections: Map<string, Map<string, string | boolean | string[]>>; }

export function parseToml(text: string): TomlDoc {
  const doc: TomlDoc = { sections: new Map() };
  let current = '';
  const bare = new Map<string, string | boolean | string[]>();
  doc.sections.set('', bare);
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sec = line.match(/^\[+(.+?)\]+$/);
    if (sec) {
      current = sec[1]!;
      if (!doc.sections.has(current)) doc.sections.set(current, new Map());
      continue;
    }
    const kv = line.match(/^([\w.-]+)\s*=\s*(.+?)\s*$/);
    if (!kv) continue;
    const key = kv[1]!;
    let value = kv[2]!;
    const hash = value.search(/(?<!"[^"]*)#/); // trailing comment outside quotes
    if (hash > -1) value = value.slice(0, hash).trim();
    doc.sections.get(current)!.set(key, tomlValue(value));
  }
  return doc;
}

function tomlValue(raw: string): string | boolean | string[] {
  if (raw.startsWith('[')) {
    const inner = raw.slice(1, raw.lastIndexOf(']') ?? undefined);
    return [...inner.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '').filter(Boolean);
  }
  if (raw === 'true' || raw === 'false') return raw === 'true';
  return raw.replace(/^["']|["']$/g, '');
}

/** Enumerate a directory defensively: unreadable → { state }, never a bare empty list. */
export function tryReaddir(dir: string): { ok: true; entries: string[] } | { ok: false; code: string } {
  try {
    return { ok: true, entries: readdirSync(dir) };
  } catch (e) {
    return { ok: false, code: (e as NodeJS.ErrnoException).code ?? 'EUNKNOWN' };
  }
}

// ── The posture state file ─────────────────────────────────────────────────────
//
// Cross-poll memory for things the schema has no table for yet: the signing
// (path,size,mtime) cache, MCP instruction-block hashes, workspace-trust
// snapshots and the transcript scan cursor. It lives next to vole.db — the only
// tree Vole writes — and every key in it is source-derived, never now()-derived.

export interface PostureState {
  signing?: Record<string, { size: number; mtime: number; row: SigningRow }>;
  mcpInstructions?: Record<string, { block_sha: string; block_len: number; first_seen: number; last_seen: number; session_count: number }>;
  mcpInstructionFiles?: Record<string, string[]>; // file -> servers already counted from it
  workspaceTrust?: Record<string, { trusted: boolean | null; first_seen: number; last_seen: number }>;
  transcripts?: Record<string, string>; // file -> `${mtimeMs}:${size}` cursor
}

const statePath = (): string => join(dirname(paths.db()), 'posture-state.json');

export function loadState(): PostureState {
  return (readJson(statePath()) as PostureState) ?? {};
}

export function saveState(s: PostureState): void {
  const dir = dirname(statePath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(), JSON.stringify(s));
}

// ── Table helpers ──────────────────────────────────────────────────────────────

export interface SigningRow {
  surface_key: string;
  team_id: string | null;
  cdhash: string | null;
  signature_kind: string;
}

/** One lever card: observed value beside the hardened recommendation, never
 *  filling an absent key with the vendor's default ('not set' stays visible). */
export function upsertLever(
  db: DB, agent: string, lever: string, observed: string | null,
  hardened: string | null, sourceFile: string, now: number,
): void {
  db.prepare(`
    INSERT INTO posture_levers (agent, lever, observed_value, hardened_value, source_file, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, lever, source_file) DO UPDATE SET
      observed_value = excluded.observed_value,
      hardened_value  = COALESCE(posture_levers.hardened_value, excluded.hardened_value),
      last_seen       = excluded.last_seen`)
    .run(agent, lever, observed, hardened, sourceFile, now, now);
}

/** Monotone per-surface counter (surface_activity): a cumulative count that only grows. */
export function bumpCounter(
  db: DB, surfaceKey: string, kind: string, add: number, now: number,
): void {
  // Every counter row must name a registered surface (verify --surfaces
  // enforces the cross-ref), so the chokepoint registers any key that has
  // no row yet — a counter-ledger surface, never a census finding. DO
  // NOTHING on conflict: the census owns the rows it enumerated.
  db.prepare(`
    INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, first_seen, last_seen)
    VALUES (?, 'counter', ?, NULL, ?, ?, ?)
    ON CONFLICT(surface_key) DO NOTHING`)
    .run(surfaceKey, surfaceKey, 'counter-ledger surface: counts its writer’s events; no disk artifact backs it', now, now);
  db.prepare(`
    INSERT INTO surface_activity (surface_key, counter_kind, counter, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(surface_key, counter_kind) DO UPDATE SET
      counter   = MAX(counter, excluded.counter),
      last_seen = excluded.last_seen`)
    .run(surfaceKey, kind, add, now, now);
}

/** A four-state permission probe for any path this family tries to read. */
export function recordScanAccess(
  db: DB, root: string, launchContext: string, code: string | null, entries: number | null, now: number,
): void {
  const state = code === null ? 'ok' : (code === 'ENOENT' ? 'missing' : code === 'EPERM' || code === 'EACCES' ? 'eperm' : 'error');
  db.prepare(`
    INSERT INTO scan_access (root, launch_context, state, errno, entries, last_ok_ts, last_ok_entries, last_result, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(root, launch_context) DO UPDATE SET
      state            = excluded.state,
      errno            = excluded.errno,
      entries          = excluded.entries,
      last_ok_ts       = CASE WHEN excluded.state = 'ok' THEN excluded.last_ok_ts ELSE scan_access.last_ok_ts END,
      last_ok_entries  = CASE WHEN excluded.state = 'ok' THEN excluded.entries ELSE scan_access.last_ok_entries END,
      last_result      = excluded.last_result,
      last_seen        = excluded.last_seen`)
    .run(root, launchContext, state, code, entries, state === 'ok' ? now : null, state === 'ok' ? entries : null, state, now, now);
}

/** mtime+size identity — the cheap "did the file change" oracle. */
export function fileStamp(file: string): string | null {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

// ── The Claude transcript walker ───────────────────────────────────────────────
//
// The attachment-bearing half of the posture plane (hook runs, MCP instruction
// blocks, offered tool surfaces, per-turn permission snapshots) all read the same
// ~/.claude/projects/**/*.jsonl files, so they share ONE bounded, cursor-gated
// walk: a file is re-read only when its (mtime, size) changed, oldest-first so
// evidence closest to the vendor's 30-day deletion window is captured first
// (the same discipline as the DLP scanner).
//
// ponytail: 200 files per pass — bump when a backlog actually shows in the notes.

export interface TranscriptEvent {
  session: string;
  file: string;
  ts: number | null;
  line: Record<string, unknown>;
}

export function walkClaudeTranscripts(
  cb: (ev: TranscriptEvent) => void,
  state: PostureState,
  budgetFiles = 200,
): { read: number; skipped: number; total: number } {
  const dir = paths.claudeCodeProjects();
  const projects = tryReaddir(dir);
  if (!projects.ok) return { read: 0, skipped: 0, total: 0 };
  state.transcripts ??= {};
  const files: { file: string; mtime: number }[] = [];
  for (const slug of projects.entries) {
    const p = tryReaddir(join(dir, slug));
    if (!p.ok) continue;
    for (const f of p.entries) {
      if (!f.endsWith('.jsonl')) continue;
      const file = join(dir, slug, f);
      const st = statSync(file);
      files.push({ file, mtime: st.mtimeMs });
    }
  }
  files.sort((a, b) => a.mtime - b.mtime); // oldest first
  let read = 0;
  for (const { file, mtime } of files) {
    const stamp = `${mtime}:${statSync(file).size}`;
    if (state.transcripts[file] === stamp) continue;
    if (read >= budgetFiles) continue; // cursor NOT advanced: next pass picks it up
    state.transcripts[file] = stamp;
    read++;
    try {
      const session = file.slice(file.lastIndexOf('/') + 1).replace(/\.jsonl$/, '');
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : null;
        cb({ session, file, ts: Number.isFinite(ts as number) ? ts : null, line: obj });
      }
    } catch {
      /* unreadable transcript: the cursor still advances; re-read is not free */
    }
  }
  return { read, skipped: files.length - read, total: files.length };
}

/** Distinct project roots Vole has live evidence for — the .mcp.json universe. */
export function knownProjectRoots(db: DB): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT project FROM usage_events WHERE project IS NOT NULL AND source = 'live' LIMIT 200",
  ).all() as { project: string }[];
  const roots = new Set(rows.map((r) => r.project));
  for (const r of db.prepare('SELECT root_path FROM work_roots').all() as { root_path: string }[]) {
    roots.add(r.root_path);
  }
  return [...roots];
}
