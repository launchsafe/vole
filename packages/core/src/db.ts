import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { dirname } from 'node:path';
import { SCHEMA } from './schema';
import { paths } from './paths';
import { computeCost } from './pricing';
import type { Anomaly, Tool, UsageEvent } from './types';

export type DB = Database.Database;

let cached: DB | null = null;

/**
 * Origin of THIS collection: who and where the data was observed. Stamped on every row
 * at ingest so that when events from several machines/users share a store they remain
 * attributable. Rows collected before this column existed keep NULL — origin unknown.
 */
function origin(): { user: string | null; machine: string | null } {
  let user: string | null = null;
  try {
    user = userInfo().username || null;
  } catch {
    /* uid not resolvable (some container contexts) */
  }
  let machine: string | null = null;
  try {
    machine = hostname() || null;
  } catch {
    /* hostname lookup failed */
  }
  return { user, machine };
}

const ORIGIN = origin();

/**
 * Adds columns introduced after a given install already has a database. Fresh installs
 * get them from SCHEMA; this only fills the gaps in older files.
 */
function migrate(db: DB): void {
  for (const table of ['usage_events', 'anomalies'] as const) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    if (!cols.includes('user')) db.exec(`ALTER TABLE ${table} ADD COLUMN user TEXT`);
    if (!cols.includes('machine')) db.exec(`ALTER TABLE ${table} ADD COLUMN machine TEXT`);
  }
  const ue = (db.prepare('PRAGMA table_info(usage_events)').all() as { name: string }[]).map((c) => c.name);
  if (!ue.includes('tools')) db.exec('ALTER TABLE usage_events ADD COLUMN tools TEXT');
  if (!ue.includes('agent_id')) db.exec('ALTER TABLE usage_events ADD COLUMN agent_id TEXT');
  if (!ue.includes('context_window')) db.exec('ALTER TABLE usage_events ADD COLUMN context_window INTEGER');
}

export function openDb(file: string = paths.db()): DB {
  if (cached) return cached;
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  migrate(db);
  cached = db;
  return db;
}

/** Test helper: drop the module-level cache so a new path can be opened. */
export function resetDbCache(): void {
  cached?.close();
  cached = null;
}

const INSERT_EVENT = `
INSERT INTO usage_events (
  event_key, tool, model, session_id, project, git_branch, ts,
  input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
  cache_read_tokens, reasoning_tokens, total_tokens, cost_usd,
  confidence, is_error, stop_reason, source, raw_ref, user, machine,
  tools, agent_id, context_window
) VALUES (
  @event_key, @tool, @model, @session_id, @project, @git_branch, @ts,
  @input_tokens, @output_tokens, @cache_write_5m_tokens, @cache_write_1h_tokens,
  @cache_read_tokens, @reasoning_tokens, @total_tokens, @cost_usd,
  @confidence, @is_error, @stop_reason, @source, @raw_ref, @user, @machine,
  @tools, @agent_id, @context_window
)
ON CONFLICT(event_key) DO UPDATE SET
  input_tokens          = excluded.input_tokens,
  output_tokens         = excluded.output_tokens,
  cache_write_5m_tokens = excluded.cache_write_5m_tokens,
  cache_write_1h_tokens = excluded.cache_write_1h_tokens,
  cache_read_tokens     = excluded.cache_read_tokens,
  reasoning_tokens      = excluded.reasoning_tokens,
  total_tokens          = excluded.total_tokens,
  cost_usd              = excluded.cost_usd,
  is_error              = excluded.is_error,
  stop_reason           = excluded.stop_reason,
  tools                 = excluded.tools,
  context_window        = excluded.context_window,
  ts                    = excluded.ts
WHERE excluded.total_tokens > usage_events.total_tokens`;

/**
 * Idempotent by construction: `event_key` is UNIQUE. Re-scanning a file can never
 * double-count.
 *
 * The upsert exists for one case: Claude Code writes each assistant message to the
 * transcript several times as it streams, and the first copy is a placeholder with
 * `output_tokens: 0`. Incremental reads see the placeholder first, so `INSERT OR
 * IGNORE` would freeze the row at zero output. The `DO UPDATE ... WHERE
 * excluded.total_tokens > total_tokens` clause upgrades a stored row only when a later
 * copy carries strictly more tokens — never downgrades, so re-reading identical data
 * is still a no-op and no other collector is affected (their keys are immutable or
 * already delta-based).
 *
 * A row with an unparseable timestamp (`ts` NaN) is dropped rather than inserted: the
 * NOT NULL constraint would otherwise abort the whole transaction and lose every other
 * row from the same pass.
 *
 * @returns number of rows inserted or upgraded
 */
export function insertEvents(db: DB, events: UsageEvent[]): number {
  if (events.length === 0) return 0;
  const stmt = db.prepare(INSERT_EVENT);
  const run = db.transaction((rows: UsageEvent[]) => {
    let changed = 0;
    for (const r of rows) {
      if (!Number.isFinite(r.ts)) continue;
      changed += stmt.run({ ...r, ...ORIGIN }).changes;
    }
    return changed;
  });
  return run(events);
}

const INSERT_ANOMALY = `
INSERT OR IGNORE INTO anomalies (
  anomaly_key, rule, severity, tool, session_id, model,
  window_start, window_end, title, detail,
  observed, baseline, threshold, confidence, source, detected_at,
  user, machine
) VALUES (
  @anomaly_key, @rule, @severity, @tool, @session_id, @model,
  @window_start, @window_end, @title, @detail,
  @observed, @baseline, @threshold, @confidence, @source, @detected_at,
  @user, @machine
)`;

/** @returns the anomalies that were actually new (stable keys make re-runs return []). */
export function insertAnomalies(db: DB, rows: Anomaly[]): Anomaly[] {
  if (rows.length === 0) return [];
  const stmt = db.prepare(INSERT_ANOMALY);
  const run = db.transaction((rs: Anomaly[]) =>
    rs.filter((r) => stmt.run({ ...r, ...ORIGIN }).changes > 0),
  );
  return run(rows);
}

export interface CollectorState {
  source_path: string;
  tool: Tool;
  last_offset: number;
  last_mtime: number | null;
  last_scanned_at: number | null;
}

export function getState(db: DB, sourcePath: string): CollectorState | undefined {
  return db
    .prepare('SELECT * FROM collector_state WHERE source_path = ?')
    .get(sourcePath) as CollectorState | undefined;
}

export function setState(
  db: DB,
  sourcePath: string,
  tool: Tool,
  lastOffset: number,
  lastMtime: number,
): void {
  db.prepare(
    `INSERT INTO collector_state (source_path, tool, last_offset, last_mtime, last_scanned_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET
       last_offset = excluded.last_offset,
       last_mtime = excluded.last_mtime,
       last_scanned_at = excluded.last_scanned_at`,
  ).run(sourcePath, tool, lastOffset, lastMtime, Date.now());
}

/**
 * Prices rows that were stored before a rate existed for their model — a new model in
 * the built-in table, or one the user added to ~/.vole/pricing.json. The upsert only
 * rewrites a row when its tokens grow, so without this pass a rate change would apply
 * to future rows only. Codex rows are priced only when the breakdown covers the meter,
 * the same rule its collector applies; OpenCode carries its own figure and is skipped.
 *
 * @returns number of rows that gained a cost
 */
export function repriceUnpriced(db: DB): number {
  const rows = db
    .prepare(
      `SELECT id, tool, model, input_tokens, output_tokens, cache_write_5m_tokens,
              cache_write_1h_tokens, cache_read_tokens, total_tokens
       FROM usage_events
       WHERE cost_usd IS NULL AND confidence = 'exact' AND model IS NOT NULL
         AND input_tokens IS NOT NULL AND tool != 'opencode'`,
    )
    .all() as (Pick<UsageEvent, 'tool' | 'model' | 'input_tokens' | 'output_tokens' |
      'cache_write_5m_tokens' | 'cache_write_1h_tokens' | 'cache_read_tokens' | 'total_tokens'> & { id: number })[];
  const update = db.prepare('UPDATE usage_events SET cost_usd = ? WHERE id = ?');
  return db.transaction(() => {
    let n = 0;
    for (const r of rows) {
      if (r.tool === 'codex') {
        const attributed = (r.input_tokens ?? 0) + (r.cache_read_tokens ?? 0) + (r.output_tokens ?? 0);
        if (attributed !== r.total_tokens) continue;
      }
      const cost = computeCost(r.model, r);
      if (cost === null) continue;
      update.run(cost, r.id);
      n++;
    }
    return n;
  })();
}

/** Removes all demo rows. Live collected data is never touched. */
export function purgeSeed(db: DB): { events: number; anomalies: number } {
  const events = db.prepare("DELETE FROM usage_events WHERE source = 'seed'").run().changes;
  const anomalies = db.prepare("DELETE FROM anomalies WHERE source = 'seed'").run().changes;
  return { events, anomalies };
}
