import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../sqlite';
import type { DB } from '../db';
import type { Direction } from '../types';
import { paths } from '../paths';
import { asContent, classifyStatus, scanBuffer, packIdentity } from './engine';
import { fingerprintOf } from './keychain';
import { copilotSessionStorePaths } from './sinks';

/**
 * The structured readers (tier 4 deep): where the sink's store is a database,
 * the store is READ as a database instead of raw-byte scanned. Codex
 * thread_history gets the per-thread updated_at_ordinal watermark (the
 * monotone cursor the rollout JSONL files lack) and direction straight from
 * the vendor's own item_type — zero shape inference. Copilot's session-store
 * hands over a vendor-normalised file-to-tool ledger. Cursor/Antigravity/Devin
 * contribute content rows with NO model attribution: provider stays NULL and
 * the registry tags the gap rather than inventing an endpoint.
 *
 * Invariants: values are fingerprinted at the boundary and never stored;
 * every cursor lives in dlp_scan_state under the sink's own key; all rows
 * are source-of-record reads, never re-derived facts.
 */

export type FingerprintFn = (value: string, now: number) => string;

export interface StructuredOutcome {
  sink: string;
  storePresent: boolean;
  rowsScanned: number;
  newSightings: number;
  bytes: number;
  notes: string[];
}

/** The widening sighting upsert: occurrences grow, a stored fact is never rewritten. */
const SIGHTING_UPSERT = `
INSERT INTO secret_sightings
  (fingerprint, detector, sink_key, path, byte_offset, byte_length, direction, status,
   first_seen, last_seen, occurrences, provider)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
ON CONFLICT(fingerprint, sink_key) DO UPDATE SET
  last_seen    = excluded.last_seen,
  occurrences  = COALESCE(secret_sightings.occurrences, 1) + 1`;

function upsertSightings(
  db: DB, fp: FingerprintFn, now: number, sinkKey: string, path: string,
  items: { detector: string; value: string; byteOffset: number; byteLength: number; direction: Direction }[],
): number {
  const stmt = db.prepare(SIGHTING_UPSERT);
  const fresh = db.prepare('SELECT 1 FROM secret_sightings WHERE fingerprint = ? AND sink_key = ?');
  let added = 0;
  for (const s of items) {
    const f = fp(s.value, now);
    if (!fresh.get(f, sinkKey)) added++;
    stmt.run(f, s.detector, sinkKey, path, s.byteOffset, s.byteLength, s.direction,
      classifyStatus(path), now, now);
  }
  return added;
}

function scanStateUpsert(db: DB, sinkKey: string, bytes: number, now: number, extra: {
  cursorKind?: string; cursorText?: string; cursorInt?: number; completed?: number;
} = {}): void {
  db.prepare(`
    INSERT INTO dlp_scan_state
      (sink_key, bytes_scanned, bytes_skipped, bytes_unreadable, last_seen_at, completed,
       cursor_kind, cursor_text, cursor_int, backfill_done, pack_rev)
    VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(sink_key) DO UPDATE SET
      bytes_scanned = dlp_scan_state.bytes_scanned + excluded.bytes_scanned,
      last_seen_at  = excluded.last_seen_at,
      completed     = COALESCE(excluded.completed, dlp_scan_state.completed),
      cursor_kind   = COALESCE(excluded.cursor_kind, dlp_scan_state.cursor_kind),
      cursor_text   = COALESCE(excluded.cursor_text, dlp_scan_state.cursor_text),
      cursor_int    = MAX(COALESCE(dlp_scan_state.cursor_int, 0), COALESCE(excluded.cursor_int, 0))`)
    .run(sinkKey, bytes, now, extra.completed ?? 1, extra.cursorKind ?? null,
      extra.cursorText ?? null, extra.cursorInt ?? null, packIdentity().version);
}

/** Opens a source store read-only; null when absent or not a database we can open. */
function openSource(path: string): Database | null {
  if (!existsSync(path)) return null;
  try {
    return new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function tableExists(store: Database, name: string): boolean {
  return !!store
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

// ── Codex thread_history: the ordinal watermark ────────────────────────────

/**
 * Direction straight from the vendor's item_type — the "direction for free"
 * the rollout JSONL cannot give. Unknown types stay at_rest: a fact about
 * where the bytes sit, never a guess about who typed them.
 */
export function codexItemDirection(itemType: string | null): Direction {
  switch (itemType) {
    case 'userMessage': return 'human_pasted';
    case 'agentMessage':
    case 'commandExecution':
    case 'mcpToolCall':
    case 'reasoning':
    case 'subAgentActivity':
    case 'webSearch':
      return 'agent_typed';
    default: return 'at_rest';
  }
}

interface ThreadItemRow {
  thread_id: string;
  item_id: string;
  item_type: string | null;
  item_json: string | null;
  updated_at_ordinal: number | null;
}

/**
 * Scans ~/.codex/thread_history_1.sqlite with a per-thread updated_at_ordinal
 * watermark cursor: only rows with an ordinal above the stored cursor are
 * read, so polling is idempotent and covers turns whose rollout file rotated.
 */
export function scanCodexThreadHistory(db: DB, now: number, fp: FingerprintFn = fingerprintOf): StructuredOutcome {
  const out: StructuredOutcome = { sink: 'codex-thread-history', storePresent: false, rowsScanned: 0, newSightings: 0, bytes: 0, notes: [] };
  const storePath = join(paths.codexHome(), 'thread_history_1.sqlite');
  const store = openSource(storePath);
  if (!store) {
    // Absent store: recorded honestly (bytes_available NULL), never silently skipped.
    scanStateUpsert(db, 'codex-thread-history', 0, now, { cursorKind: 'store_absent', completed: 1 });
    out.notes.push('thread_history store absent on this machine');
    return out;
  }
  out.storePresent = true;
  try {
    if (!tableExists(store, 'thread_items')) {
      // New Codex build without the store yet: the sink reports availability as
      // unknown rather than pretending it scanned zero bytes of nothing.
      scanStateUpsert(db, 'codex-thread-history', 0, now, { cursorKind: 'table_absent', completed: 1 });
      out.notes.push('thread_items table absent (store present)');
      return out;
    }
    const threads = store.prepare('SELECT DISTINCT thread_id FROM thread_items').all() as { thread_id: string }[];
    const cursorRead = db.prepare('SELECT cursor_int FROM dlp_scan_state WHERE sink_key = ?');
    const seen = db.prepare('SELECT 1 FROM secret_sightings WHERE fingerprint = ? AND sink_key = ?');
    const upsert = db.prepare(SIGHTING_UPSERT);
    for (const { thread_id } of threads) {
      const sinkKey = `codex-thread-history:${thread_id}`;
      const cursor =
        (cursorRead.get(sinkKey) as { cursor_int: number | null } | undefined)?.cursor_int ?? 0;
      const rows = store.prepare(`
        SELECT item_id, item_type, item_json, updated_at_ordinal
          FROM thread_items
         WHERE thread_id = ? AND updated_at_ordinal > ?
         ORDER BY updated_at_ordinal`).all(thread_id, cursor) as unknown as ThreadItemRow[];
      let maxOrdinal = cursor;
      for (const r of rows) {
        out.rowsScanned++;
        const json = r.item_json ?? '';
        out.bytes += Buffer.byteLength(json, 'utf8');
        if (r.updated_at_ordinal !== null && r.updated_at_ordinal > maxOrdinal) maxOrdinal = r.updated_at_ordinal;
        const direction = codexItemDirection(r.item_type);
        const ref = `${storePath}#thread=${thread_id}/item=${r.item_id}`;
        for (const s of scanBuffer(asContent(json), 0)) {
          const f = fp(s.value, now);
          if (!seen.get(f, sinkKey)) out.newSightings++;
          upsert.run(f, s.detector, sinkKey, ref, s.byteOffset, s.byteLength, direction,
            classifyStatus(ref), now, now);
        }
      }
      // One cursor row per thread: the watermark is (thread_id, ordinal), and
      // a single global row could not represent threads updating independently.
      scanStateUpsert(db, sinkKey, Buffer.byteLength(rows.map((r) => r.item_json ?? '').join(''), 'utf8'), now, {
        cursorKind: 'updated_at_ordinal', cursorText: thread_id, cursorInt: maxOrdinal,
      });
    }
  } finally {
    store.close();
  }
  return out;
}

// ── Copilot's session store: the free file-to-tool ledger ─────────────────

interface CopilotSession {
  id: string;
  cwd: string | null;
  repository: string | null;
  agent_name?: string | null;
}

interface CopilotSessionFile {
  session_id: string;
  file_path: string;
  tool_name: string | null;
  turn_index?: number | null;
  first_seen_at?: number | string | null;
}

/** ms from whatever the vendor stored (s, ms or ISO); null when unknown. */
function toMs(v: number | string | null | undefined): number | null {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const p = Date.parse(v);
    return Number.isNaN(p) ? null : p;
  }
  return null;
}

/**
 * Opens the Copilot Chat session-store.db read-only: sessions join to
 * work_roots (the agent recorded its own repositories — no repo sweep
 * needed), session_files land in tool_calls with status_source
 * 'vendor_table', and the turns table is scanned for secrets with the
 * prompt/response columns carrying direction.
 */
export function scanCopilotSessionStore(db: DB, now: number, fp: FingerprintFn = fingerprintOf): StructuredOutcome {
  const out: StructuredOutcome = { sink: 'copilot-session-store', storePresent: false, rowsScanned: 0, newSightings: 0, bytes: 0, notes: [] };
  for (const storePath of copilotSessionStorePaths()) {
    const store = openSource(storePath);
    if (!store) continue;
    out.storePresent = true;
    try {
      if (tableExists(store, 'sessions')) {
        const sessions = store.prepare(
          'SELECT id, cwd, repository, agent_name FROM sessions',
        ).all() as unknown as CopilotSession[];
        const rootUpsert = db.prepare(`
          INSERT INTO work_roots (root_path, origin_slug, exists_now, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(root_path) DO UPDATE SET
            last_seen    = excluded.last_seen,
            exists_now   = excluded.exists_now,
            origin_slug  = COALESCE(work_roots.origin_slug, excluded.origin_slug)`);
        for (const s of sessions) {
          if (!s.cwd) continue;
          rootUpsert.run(s.cwd, s.repository ?? null, existsSync(s.cwd) ? 1 : 0, now, now);
        }
        if (tableExists(store, 'session_files')) {
          const files = store.prepare(
            'SELECT session_id, file_path, tool_name, turn_index, first_seen_at FROM session_files',
          ).all() as unknown as CopilotSessionFile[];
          const callUpsert = db.prepare(`
            INSERT INTO tool_calls
              (tool_call_key, tool, name, shape, args_digest, session_id, agent_id, ts,
               status, status_source, duration_ms, duration_kind, authority, raw_ref,
               first_seen, last_seen)
            VALUES (?, 'copilot_cli', ?, NULL, ?, ?, NULL, ?, NULL, 'vendor_table', NULL, NULL, NULL, ?, ?, ?)
            ON CONFLICT(tool_call_key) DO UPDATE SET last_seen = excluded.last_seen`);
          for (const f of files) {
            out.rowsScanned++;
            callUpsert.run(
              `copilot-session-files:${f.session_id}:${f.file_path}`,
              f.tool_name ?? 'file',
              `f:${fp(f.file_path, now)}`,
              f.session_id,
              toMs(f.first_seen_at) ?? now,
              storePath,
              now, now,
            );
          }
        } else {
          out.notes.push('session_files table absent');
        }
        // The prompts themselves: turn columns are scanned with direction from
        // the column's own name; a column we cannot classify stays at_rest.
        scanTurnsForSecrets(store, db, storePath, now, fp, out);
      } else {
        out.notes.push('sessions table absent');
      }
    } finally {
      store.close();
    }
    break; // first existing editor root wins; a second editor would double-count sessions
  }
  if (!out.storePresent) {
    scanStateUpsert(db, 'copilot-session-store', 0, now, { cursorKind: 'store_absent', completed: 1 });
    out.notes.push('session-store.db not found in any editor globalStorage root');
  }
  return out;
}

const PROMPT_COLUMN = /prompt|message|question|input/i;
const RESPONSE_COLUMN = /response|reply|answer|output/i;

function scanTurnsForSecrets(
  store: Database, db: DB, storePath: string, now: number, fp: FingerprintFn, out: StructuredOutcome,
): void {
  if (!tableExists(store, 'turns')) return;
  // ponytail: column type probing per row is not worth it — select the columns
  // whose names look like content and let the scan skip non-strings at runtime.
  const cols = (store.prepare('PRAGMA table_info(turns)').all() as unknown as { name: string }[])
    .map((c) => c.name);
  const contentCols = cols.filter((c) => PROMPT_COLUMN.test(c) || RESPONSE_COLUMN.test(c));
  if (!contentCols.length) return;
  const rows = store.prepare(
    `SELECT rowid, ${contentCols.map((c) => `"${c}"`).join(', ')} FROM turns LIMIT 20000`,
  ).all() as unknown as Record<string, unknown>[];
  const upsert = db.prepare(SIGHTING_UPSERT);
  const seen = db.prepare('SELECT 1 FROM secret_sightings WHERE fingerprint = ? AND sink_key = ?');
  for (const r of rows) {
    for (const c of contentCols) {
      const v = r[c];
      if (typeof v !== 'string' || v.length < 12) continue;
      out.bytes += Buffer.byteLength(v, 'utf8');
      out.rowsScanned++;
      const direction: Direction = PROMPT_COLUMN.test(c) ? 'human_pasted'
        : RESPONSE_COLUMN.test(c) ? 'agent_typed' : 'at_rest';
      const ref = `${storePath}#turns:rowid=${r.rowid}:${c}`;
      for (const s of scanBuffer(asContent(v), 0)) {
        const f = fp(s.value, now);
        if (!seen.get(f, 'copilot-session-store')) out.newSightings++;
        upsert.run(f, s.detector, 'copilot-session-store', ref, s.byteOffset, s.byteLength,
          direction, classifyStatus(ref), now, now);
      }
    }
  }
}

// ── Cursor: tracked_file_content + ai_code_hashes, no model attribution ───

/**
 * Cursor's ai-code-tracking.db: tracked_file_content.content is raw source the
 * extension persisted, ai_code_hashes is the path provenance for AI-written
 * code. Neither carries a model or an endpoint — provider stays NULL and the
 * registry tags 'no model attribution' so the blank column reads as a gap.
 */
export function scanCursorTracking(db: DB, now: number, fp: FingerprintFn = fingerprintOf): StructuredOutcome {
  const out: StructuredOutcome = { sink: 'cursor-tracking', storePresent: false, rowsScanned: 0, newSightings: 0, bytes: 0, notes: [] };
  const storePath = paths.cursorTrackingDb();
  const store = openSource(storePath);
  if (!store) {
    scanStateUpsert(db, 'cursor-tracking', 0, now, { cursorKind: 'store_absent', completed: 1 });
    out.notes.push('ai-code-tracking.db absent');
    return out;
  }
  out.storePresent = true;
  try {
    if (tableExists(store, 'tracked_file_content')) {
      const rows = store.prepare('SELECT rowid, * FROM tracked_file_content LIMIT 20000')
        .all() as unknown as Record<string, unknown>[];
      const upsert = db.prepare(SIGHTING_UPSERT);
      const seen = db.prepare('SELECT 1 FROM secret_sightings WHERE fingerprint = ? AND sink_key = ?');
      for (const r of rows) {
        for (const [k, v] of Object.entries(r)) {
          if (k === 'rowid' || typeof v !== 'string' || v.length < 12 || !/content/i.test(k)) continue;
          out.rowsScanned++;
          out.bytes += Buffer.byteLength(v, 'utf8');
          const ref = `${storePath}#tracked_file_content:rowid=${r.rowid}:${k}`;
          for (const s of scanBuffer(asContent(v), 0)) {
            const f = fp(s.value, now);
            if (!seen.get(f, 'cursor-tracking')) out.newSightings++;
            upsert.run(f, s.detector, 'cursor-tracking', ref, s.byteOffset, s.byteLength,
              'at_rest', classifyStatus(ref), now, now);
          }
        }
      }
    } else {
      out.notes.push('tracked_file_content table absent');
    }
    if (tableExists(store, 'ai_code_hashes')) {
      // Path provenance for AI-written code — the count is the denominator the
      // Data Exposure rows are read against; the hashes themselves are not ours to keep.
      const n = (store.prepare('SELECT COUNT(*) AS n FROM ai_code_hashes').get() as { n: number }).n;
      out.notes.push(`${n} ai_code_hashes row(s) — path provenance for AI-written code`);
    }
  } finally {
    store.close();
  }
  return out;
}

// ── Antigravity brain + Devin acp-messages: no model attribution ──────────

/** Antigravity brain/<id>/*.md: readable markdown plans, scanned as text. */
export function scanAntigravityBrain(db: DB, now: number, fp: FingerprintFn = fingerprintOf): StructuredOutcome {
  const out: StructuredOutcome = { sink: 'antigravity-brain', storePresent: false, rowsScanned: 0, newSightings: 0, bytes: 0, notes: [] };
  const brain = paths.antigravityBrain();
  if (!existsSync(brain)) {
    out.notes.push('brain directory absent');
    return out;
  }
  out.storePresent = true;
  const upsert = db.prepare(SIGHTING_UPSERT);
  const seen = db.prepare('SELECT 1 FROM secret_sightings WHERE fingerprint = ? AND sink_key = ?');
  let added = 0;
  for (const d of readdirSync(brain)) {
    const dir = join(brain, d);
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch { continue; }
    for (const f of entries) {
      const p = join(dir, f);
      try {
        const text = readFileSync(p, 'utf8');
        out.rowsScanned++;
        out.bytes += Buffer.byteLength(text, 'utf8');
        for (const s of scanBuffer(asContent(text), 0)) {
          const fpv = fp(s.value, now);
          if (!seen.get(fpv, `antigravity-brain:${d.slice(0, 8)}`)) added++;
          upsert.run(fpv, s.detector, `antigravity-brain:${d.slice(0, 8)}`, p, s.byteOffset,
            s.byteLength, 'at_rest', classifyStatus(p), now, now);
        }
      } catch { /* raced away */ }
    }
  }
  out.newSightings = added;
  return out;
}

/**
 * Devin acp-messages: per-thread sqlite files of unknown-but-textual shape, so
 * every table's string fields are scanned under a bounded row budget. No model,
 * no endpoint, no tokens — the ledger names the tool and the file, nothing else.
 */
export function scanDevinAcpMessages(db: DB, now: number, fp: FingerprintFn = fingerprintOf): StructuredOutcome {
  const out: StructuredOutcome = { sink: 'devin-acp-messages', storePresent: false, rowsScanned: 0, newSightings: 0, bytes: 0, notes: [] };
  const root = paths.devinAcpMessages();
  if (!existsSync(root)) {
    out.notes.push('acp-messages directory absent');
    return out;
  }
  out.storePresent = true;
  const upsert = db.prepare(SIGHTING_UPSERT);
  const seen = db.prepare('SELECT 1 FROM secret_sightings WHERE fingerprint = ? AND sink_key = ?');
  let added = 0;
  const ROW_BUDGET = 5000; // ponytail: bounded table scan — raise if Devin threads grow past this
  let files: string[] = [];
  try {
    files = readdirSync(root).filter((f) => /\.(db|sqlite|sqlite3)$/i.test(f));
  } catch { files = []; }
  for (const f of files) {
    const p = join(root, f);
    const store = openSource(p);
    if (!store) continue;
    try {
      const tables = (store.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      ).all() as { name: string }[]).slice(0, 50);
      for (const t of tables) {
        let rows: unknown[];
        try {
          rows = store.prepare(`SELECT rowid, * FROM "${t.name}" LIMIT ?`).all(ROW_BUDGET);
        } catch { continue; }
        for (const raw of rows) {
          const r = raw as Record<string, unknown>;
          for (const [k, v] of Object.entries(r)) {
            if (k === 'rowid' || typeof v !== 'string' || v.length < 16) continue;
            out.rowsScanned++;
            out.bytes += Buffer.byteLength(v, 'utf8');
            const ref = `${p}#${t.name}:rowid=${r.rowid}:${k}`;
            for (const s of scanBuffer(asContent(v), 0)) {
              const fpv = fp(s.value, now);
              if (!seen.get(fpv, 'devin-acp-messages')) added++;
              upsert.run(fpv, s.detector, 'devin-acp-messages', ref, s.byteOffset, s.byteLength,
                'at_rest', classifyStatus(ref), now, now);
            }
          }
        }
      }
    } finally {
      store.close();
    }
  }
  out.newSightings = added;
  return out;
}

/** Runs every structured sink. The scanner entry point the integrator registers. */
export function runStructuredSinks(db: DB, now = Date.now(), fp: FingerprintFn = fingerprintOf): {
  ok: boolean;
  notes: string[];
} {
  const outcomes = [
    scanCodexThreadHistory(db, now, fp),
    scanCopilotSessionStore(db, now, fp),
    scanCursorTracking(db, now, fp),
    scanAntigravityBrain(db, now, fp),
    scanDevinAcpMessages(db, now, fp),
  ];
  const notes = outcomes.flatMap((o) => {
    const head = `${o.sink}: ${o.storePresent ? `${o.rowsScanned} row(s), ${o.bytes} byte(s)` : 'store absent'}`;
    return [head, ...o.notes.map((n) => `  ${n}`)];
  });
  const sightings = outcomes.reduce((n, o) => n + o.newSightings, 0);
  if (sightings) notes.push(`${sightings} NEW structured sighting(s)`);
  // Structured sinks raise no anomalies of their own: severity lives with the
  // raw scanner's incidents, and the Leak Ledger groups by fingerprint.
  return { ok: true, notes };
}
