import { Database } from './sqlite';
import { mkdirSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { SCHEMA } from './schema';
import { paths } from './paths';
import { computeCost } from './pricing';
import type { Anomaly, Tool, UsageEvent } from './types';

export type DB = Database;

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

// ── schema_migrations: a numbered, ledgered, forward-only path ──────────────
//
// PRAGMA user_version used to read 0 on every live store: the store could not say
// which schema it was, and upgrades were three hand-written PRAGMA table_info probes
// that silently no-op'd when they lost their nerve. This is the replacement: a
// forward-only list of steps, each applied inside one BEGIN IMMEDIATE with
// busy_timeout set, each stamped into a ledger table with its duration and row
// count. A step's `apply` must be idempotent — an old store converges by running
// everything pending, a fresh store runs the whole list once as no-ops that still
// get ledgered, so every store can answer "which schema am I".
//
// The ledger can only describe steps applied after it exists. A store that predates
// it gets one synthetic row — version 0, name 'pre-ledger', applied_at NULL — and
// NULL must render as 'unknown', never as a date.

export interface Migration {
  version: number;
  name: string;
  kind: 'ddl' | 'backfill';
  /** Idempotent by contract: an old store may apply it as a verified no-op. */
  apply: (db: DB) => number;
}

function addColumn(db: DB, table: string, column: string, ddl: string): number {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (cols.includes(column)) return 0;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  return 1;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'origin-user-machine-columns',
    kind: 'ddl',
    apply: (db) =>
      addColumn(db, 'usage_events', 'user', 'TEXT') +
      addColumn(db, 'usage_events', 'machine', 'TEXT') +
      addColumn(db, 'anomalies', 'user', 'TEXT') +
      addColumn(db, 'anomalies', 'machine', 'TEXT'),
  },
  {
    version: 2,
    name: 'tools-agent-context-columns',
    kind: 'ddl',
    apply: (db) =>
      addColumn(db, 'usage_events', 'tools', 'TEXT') +
      addColumn(db, 'usage_events', 'agent_id', 'TEXT') +
      addColumn(db, 'usage_events', 'context_window', 'INTEGER'),
  },
  {
    version: 3,
    name: 'codex-event-key-backfill',
    kind: 'backfill',
    // Declared and one-time: Codex event_keys were keyed on sessionId, which
    // sub-agent rollout files replay verbatim, so parent and child rows collided
    // on one key and rows were silently lost or had their totals mixed. Keys are
    // now rollout-file based. The old rows cannot be healed in place — a collided
    // row's totals may come from whichever file happened to win — and Codex
    // rollouts are re-read in full on every collection pass, so the rows are
    // deleted here and rebuilt from source on the next pass. Rows whose rollout
    // file no longer exists are gone for good, which is the honest horizon: they
    // cannot be re-proved from local evidence either way.
    apply: (db) => {
      const stale = db
        .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE tool='codex' AND event_key NOT LIKE '%/%'")
        .get() as { n: number };
      if (stale.n === 0) return 0;
      db.exec("DELETE FROM usage_events WHERE tool='codex' AND event_key NOT LIKE '%/%'");
      return stale.n;
    },
  },
  {
    version: 4,
    name: 'collector-runs-heartbeat',
    kind: 'ddl',
    // The table itself lives in SCHEMA (fresh installs get it directly); the step
    // exists so every evolving store gets a ledgered record of the same fact.
    apply: (db) => {
      const n = (
        db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='collector_runs'").get() as { n: number }
      ).n;
      if (n === 0) db.exec(COLLECTOR_RUNS_DDL);
      return 0;
    },
  },
  {
    version: 5,
    name: 'scan-state-cadence-lane',
    kind: 'ddl',
    // The discovery scanners (codesign per binary, /Applications walk, launchd
    // enumeration) are orders of magnitude more expensive than a poll and must
    // never ride the 5-second loop. scan_state is their lane: per-scanner
    // last-run facts, so a scanner runs at ITS cadence, not the poll's.
    apply: (db) => {
      const n = (
        db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='scan_state'").get() as { n: number }
      ).n;
      if (n === 0) db.exec(SCAN_STATE_DDL);
      return 0;
    },
  },
  {
    version: 6,
    name: 'claude-tools-backfill',
    kind: 'backfill',
    // Declared and one-time: the collector unions tool names across content-block
    // copies since the B5 fix, but incremental offsets never re-read lines already
    // consumed, so rows stored before that fix keep tools NULL forever — the
    // tokens-only-grow upsert cannot heal what it is never shown again. This step
    // re-reads each affected row's own transcript once and heals the union. Rows
    // whose transcript was pruned stay NULL: unhealable from local evidence, and
    // reported as such rather than invented.
    apply: (db) => {
      const rows = db
        .prepare(
          "SELECT id, event_key, raw_ref FROM usage_events WHERE tool = 'claude_code' AND tools IS NULL AND raw_ref IS NOT NULL",
        )
        .all() as { id: number; event_key: string; raw_ref: string }[];
      if (rows.length === 0) return 0;

      // One file read per affected transcript, one union map per file.
      const byFile = new Map<string, { id: number; messageId: string }[]>();
      for (const r of rows) {
        const list = byFile.get(r.raw_ref) ?? [];
        list.push({ id: r.id, messageId: r.event_key.slice('claude_code:'.length) });
        byFile.set(r.raw_ref, list);
      }

      const update = db.prepare('UPDATE usage_events SET tools = ? WHERE id = ?');
      let healed = 0;
      for (const [file, targets] of byFile) {
        let lines: string[];
        try {
          lines = readFileSync(file, 'utf8').split('\n');
        } catch {
          continue; // pruned or unreadable: the row keeps its honest NULL
        }
        const wanted = new Set(targets.map((t) => t.messageId));
        const union = new Map<string, string[]>();
        for (const line of lines) {
          if (!line) continue;
          let e: {
            type?: string;
            message?: { id?: string; content?: { type?: string; name?: string }[] | string };
          };
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          if (e.type !== 'assistant' || !e.message?.id || !wanted.has(e.message.id)) continue;
          const content = e.message.content;
          if (!Array.isArray(content)) continue;
          const u = union.get(e.message.id) ?? [];
          for (const c of content) {
            if (c?.type === 'tool_use' && c.name && !u.includes(c.name)) u.push(c.name);
          }
          union.set(e.message.id, u);
        }
        for (const t of targets) {
          const u = union.get(t.messageId);
          if (u?.length) healed += update.run(u.join(','), t.id).changes;
        }
      }
      return healed;
    },
  },
  {
    version: 7,
    name: 'v-incident-explained-view',
    kind: 'ddl',
    // The read-model contract: the incident shape (figures included) lives in the
    // STORE, not in two diverging SQL strings — both readers SELECT from the view,
    // so a column added once appears in TS, Swift and the parity diff together.
    apply: (db) => {
      db.exec(`
        CREATE VIEW IF NOT EXISTS v_incident_explained AS
        SELECT id, anomaly_key, rule, severity, tool, session_id, model,
               window_start, window_end, title, detail,
               observed, baseline, threshold, confidence, source, detected_at
        FROM anomalies`);
      return 0;
    },
  },
  {
    version: 8,
    name: 'ai-surfaces-registry',
    kind: 'ddl',
    // The Shadow AI spine: every AI surface on this machine — installed apps,
    // persistent gateways, CLIs — with first_seen/last_seen. A surface row proves
    // an artifact exists on disk, never that a human used it, and never a token
    // or a dollar (the evidence ladder and verify --surfaces keep that honest).
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_surfaces (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          surface_key TEXT    NOT NULL UNIQUE,
          kind        TEXT    NOT NULL,
          name        TEXT    NOT NULL,
          path        TEXT,
          evidence    TEXT,
          version     TEXT,
          extra       TEXT,
          first_seen  INTEGER NOT NULL,
          last_seen   INTEGER NOT NULL
        )`);
      return 0;
    },
  },
  {
    version: 9,
    name: 'finding-actions-triage',
    kind: 'ddl',
    // The triage layer: an append-only disposition ledger. Writes arrive through
    // the ~/.vole/inbox spool (the app never writes the store) and are drained
    // here by the collector — the same single-writer discipline as everything else.
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS finding_actions (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          anomaly_key  TEXT    NOT NULL,
          action       TEXT    NOT NULL,
          note         TEXT,
          until        INTEGER,
          actor        TEXT    NOT NULL DEFAULT 'app',
          created_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_fa_key ON finding_actions(anomaly_key, created_at);`);
      return 0;
    },
  },
  {
    version: 10,
    name: 'ai-surfaces-sanctioned-column',
    kind: 'ddl',
    // The policy join, materialized at scan time: NULL = no policy was loaded at
    // the last scan (the chip reads "no policy"), 1 = sanctioned, 0 = not in the
    // declaration. Sanctioned-ness is an admin DECISION, re-evaluated every scan.
    apply: (db) => addColumn(db, 'ai_surfaces', 'sanctioned', 'INTEGER'),
  },
  {
    version: 11,
    name: 'secret-sightings-and-scan-state',
    kind: 'ddl',
    // The Tier 4 substrate. secret_sightings NEVER holds a secret value: the
    // fingerprint is a Keychain-keyed HMAC, the location is a byte offset, and
    // the value can only be re-read from the source file at view time (the
    // just-in-time evidence viewer). dlp_scan_state carries per-sink cursors so
    // a scan engine with a byte budget resumes rather than restarts.
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS secret_sightings (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          fingerprint    TEXT    NOT NULL,
          detector       TEXT    NOT NULL,
          sink_key       TEXT    NOT NULL,
          path           TEXT    NOT NULL,
          byte_offset    INTEGER NOT NULL,
          byte_length    INTEGER NOT NULL,
          direction      TEXT    NOT NULL DEFAULT 'at_rest',
          status         TEXT    NOT NULL DEFAULT 'candidate',
          first_seen     INTEGER NOT NULL,
          last_seen     INTEGER NOT NULL,
          UNIQUE (fingerprint, sink_key)
        );
        CREATE INDEX IF NOT EXISTS idx_ss_fp ON secret_sightings(fingerprint);
        CREATE TABLE IF NOT EXISTS dlp_scan_state (
          sink_key       TEXT PRIMARY KEY,
          bytes_scanned  INTEGER NOT NULL DEFAULT 0,
          bytes_skipped  INTEGER,
          bytes_unreadable INTEGER,
          last_seen_at   INTEGER,
          completed      INTEGER NOT NULL DEFAULT 0
        );`);
      return 0;
    },
  },
  {
    version: 12,
    name: 'usage-events-duration-column',
    kind: 'ddl',
    // Generation speed needs real response durations. OpenCode carries
    // time.created -> time.completed per message (exact); other collectors leave
    // NULL — an honest unknown, never an invented zero, and the speed view
    // prints its coverage beside every figure.
    apply: (db) => addColumn(db, 'usage_events', 'duration_ms', 'INTEGER'),
  },
  {
    version: 13,
    name: 'duration-kind-provenance',
    kind: 'ddl',
    // Speed provenance: 'measured' = the source states the response span
    // (OpenCode); 'turn_scoped' = estimated from inter-event gaps, which include
    // queue time and permission prompts, so the derived speed is a LOWER bound.
    // NULL = no duration is known at all. A speed figure without its kind is a
    // benchmark, not a measurement.
    apply: (db) => addColumn(db, 'usage_events', 'duration_kind', "TEXT"),
  },
  {
    version: 14,
    name: 'duration-backfill-cursor-reset',
    kind: 'backfill',
    // Generation speed needs durations on stored rows, but claude-code reads by
    // offset and codex by (size, mtime) cursor — both skip everything already
    // consumed, so rows stored before duration capture would stay NULL forever.
    // One declared reset: the next pass re-reads every transcript and rollout
    // from the start; stable event_keys make it a no-op for tokens, and the
    // NULL-widening upsert heals duration_ms in place.
    apply: (db) => {
      const n = db
        .prepare("DELETE FROM collector_state WHERE tool IN ('claude_code', 'codex')")
        .run().changes;
      return n;
    },
  },
]
;

const SCAN_STATE_DDL = `
CREATE TABLE IF NOT EXISTS scan_state (
  scanner          TEXT PRIMARY KEY,
  cadence_ms       INTEGER NOT NULL,
  last_started_at  INTEGER,
  last_duration_ms INTEGER,
  ok               INTEGER,
  notes            TEXT
)`;

const COLLECTOR_RUNS_DDL = `
CREATE TABLE IF NOT EXISTS collector_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  tool        TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  files       INTEGER NOT NULL,
  parsed      INTEGER NOT NULL,
  inserted    INTEGER NOT NULL,
  source_state TEXT   NOT NULL DEFAULT 'ok',
  ok          INTEGER NOT NULL DEFAULT 1,
  notes       TEXT
);
CREATE INDEX IF NOT EXISTS idx_cr_tool_started ON collector_runs(tool, started_at);`;

export interface SchemaMigrationsRow {
  version: number;
  name: string;
  kind: string;
  applied_at: number | null;
  duration_ms: number | null;
  rows_changed: number | null;
}

function migrate(db: DB, fresh: boolean): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      kind        TEXT    NOT NULL,
      applied_at  INTEGER,
      duration_ms INTEGER,
      rows_changed INTEGER
    )`);

  const version = (
    db.prepare('PRAGMA user_version').get() as { user_version: number }
  ).user_version;

  // A store that predates the ledger cannot say when its early steps ran. The
  // synthetic row states exactly that: applied_at NULL is 'unknown, before the
  // ledger', never a date. A store created by this code knows its history and
  // gets no such row.
  if (version === 0 && !fresh) {
    db.prepare(
      "INSERT OR IGNORE INTO schema_migrations (version, name, kind, applied_at) VALUES (0, 'pre-ledger', 'ddl', NULL)",
    ).run();
  }

  const pending = MIGRATIONS.filter((m) => m.version > version);
  if (pending.length === 0) return;

  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, kind, applied_at, duration_ms, rows_changed) VALUES (?, ?, ?, ?, ?, ?)',
  );
  // One BEGIN IMMEDIATE for the whole batch: migrations are store-shape changes,
  // and a second writer must never observe a half-applied list.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const m of pending) {
      const started = Date.now();
      const rows = m.apply(db);
      record.run(m.version, m.name, m.kind, Date.now(), Date.now() - started, rows);
    }
    db.exec(`PRAGMA user_version = ${MIGRATIONS[MIGRATIONS.length - 1]!.version}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** The store's own schema facts — for Settings and the future version gate. */
export function schemaInfo(db: DB): { userVersion: number; ledger: SchemaMigrationsRow[] } {
  const userVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  const ledger = db
    .prepare('SELECT version, name, kind, applied_at, duration_ms, rows_changed FROM schema_migrations ORDER BY version')
    .all() as SchemaMigrationsRow[];
  return { userVersion, ledger };
}

export function openDb(file: string = paths.db()): DB {
  if (cached) return cached;
  const fresh = !existsSync(file);
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  // Two writers are an explicitly tolerated configuration (the app spawns the
  // embedded collector next to a possibly running `pnpm collect`), and SQLite's
  // default busy_timeout is 0 — any lock overlap would abort the whole pass or the
  // reader's first query with SQLITE_BUSY, which surfaces as missing data with no
  // error a user can see. Wait for the lock instead; every write here is a short
  // transaction, so 5s is generous.
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  migrate(db, fresh);
  // Version gate: a store written by a NEWER Vole has a user_version this binary
  // cannot understand. Writing to it would land NULL in every column this schema
  // does not know — indistinguishable downstream from "the source did not carry
  // this field" — so an older writer refuses loudly instead of being silently wrong.
  const storeVersion = (
    db.prepare('PRAGMA user_version').get() as { user_version: number }
  ).user_version;
  const known = MIGRATIONS[MIGRATIONS.length - 1]!.version;
  if (storeVersion > known) {
    cached = null;
    try {
      db.close();
    } catch {
      /* already closed */
    }
    throw new Error(
      `This Vole knows schema ${known} but the store at ${file} was written by schema ${storeVersion} ` +
        '(a newer Vole). Refusing to write it — update Vole, or point VOLE_DB at a store this version owns.',
    );
  }
  cached = db;
  return db;
}

/** Test helper: drop the module-level cache so a new path can be opened. */
export function resetDbCache(): void {
  cached?.close();
  cached = null;
}

/**
 * Read-only open for reader CLIs (top, pr, digest, statusline, mcp, verify).
 *
 * A reader must never create or migrate the store it is only supposed to report on:
 * `openDb()`'s mkdir + CREATE TABLE turned "ran the reader before the first collect"
 * into a silently-empty database — the exact failure verify was written to catch. A
 * missing store is an error with the command that fixes it, not a fresh empty file.
 *
 * No busy_timeout here: read-only WAL readers don't take write locks.
 */
export function openDbReadOnly(file: string = paths.db()): DB {
  if (!existsSync(file)) {
    console.error(
      `No Vole store at ${file} yet — a reader never creates one.\n` +
        `Run the collector first: pnpm collect --once`,
    );
    process.exit(1);
  }
  return new Database(file, { readonly: true, fileMustExist: true });
}

const INSERT_EVENT = `
INSERT INTO usage_events (
  event_key, tool, model, session_id, project, git_branch, ts,
  input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
  cache_read_tokens, reasoning_tokens, total_tokens, cost_usd,
  confidence, is_error, stop_reason, source, raw_ref, user, machine,
  tools, agent_id, context_window, duration_ms, duration_kind
) VALUES (
  @event_key, @tool, @model, @session_id, @project, @git_branch, @ts,
  @input_tokens, @output_tokens, @cache_write_5m_tokens, @cache_write_1h_tokens,
  @cache_read_tokens, @reasoning_tokens, @total_tokens, @cost_usd,
  @confidence, @is_error, @stop_reason, @source, @raw_ref, @user, @machine,
  @tools, @agent_id, @context_window, @duration_ms, @duration_kind
)
ON CONFLICT(event_key) DO UPDATE SET
  input_tokens          = CASE WHEN excluded.total_tokens > usage_events.total_tokens THEN excluded.input_tokens          ELSE usage_events.input_tokens END,
  output_tokens         = CASE WHEN excluded.total_tokens > usage_events.total_tokens THEN excluded.output_tokens         ELSE usage_events.output_tokens END,
  cache_write_5m_tokens = CASE WHEN excluded.total_tokens > usage_events.total_tokens THEN excluded.cache_write_5m_tokens ELSE usage_events.cache_write_5m_tokens END,
  cache_write_1h_tokens = CASE WHEN excluded.total_tokens > usage_events.total_tokens THEN excluded.cache_write_1h_tokens ELSE usage_events.cache_write_1h_tokens END,
  cache_read_tokens     = CASE WHEN excluded.total_tokens > usage_events.total_tokens THEN excluded.cache_read_tokens     ELSE usage_events.cache_read_tokens END,
  reasoning_tokens      = CASE WHEN excluded.total_tokens > usage_events.total_tokens THEN excluded.reasoning_tokens      ELSE usage_events.reasoning_tokens END,
  total_tokens          = CASE WHEN excluded.total_tokens > usage_events.total_tokens THEN excluded.total_tokens          ELSE usage_events.total_tokens END,
  cost_usd              = CASE WHEN excluded.total_tokens > usage_events.total_tokens THEN excluded.cost_usd              ELSE usage_events.cost_usd END,
  is_error              = CASE WHEN excluded.total_tokens > usage_events.total_tokens THEN excluded.is_error              ELSE usage_events.is_error END,
  stop_reason           = CASE WHEN excluded.total_tokens > usage_events.total_tokens THEN excluded.stop_reason           ELSE usage_events.stop_reason END,
  context_window        = CASE WHEN excluded.total_tokens > usage_events.total_tokens THEN excluded.context_window        ELSE usage_events.context_window END,
  ts                    = CASE WHEN excluded.total_tokens > usage_events.total_tokens THEN excluded.ts                    ELSE usage_events.ts END,
  duration_ms           = CASE WHEN excluded.total_tokens > usage_events.total_tokens THEN excluded.duration_ms           ELSE COALESCE(usage_events.duration_ms, excluded.duration_ms) END,
  tools                 = CASE
                           WHEN excluded.total_tokens > usage_events.total_tokens THEN excluded.tools
                           WHEN usage_events.tools IS NULL AND excluded.tools IS NOT NULL THEN excluded.tools
                           ELSE usage_events.tools
                         END,
  duration_ms           = CASE
                           WHEN excluded.total_tokens > usage_events.total_tokens THEN excluded.duration_ms
                           WHEN usage_events.duration_ms IS NULL AND excluded.duration_ms IS NOT NULL THEN excluded.duration_ms
                           ELSE usage_events.duration_ms
                         END,
  duration_kind         = CASE
                           WHEN excluded.total_tokens > usage_events.total_tokens THEN excluded.duration_kind
                           WHEN usage_events.duration_ms IS NULL AND excluded.duration_ms IS NOT NULL THEN excluded.duration_kind
                           ELSE COALESCE(usage_events.duration_kind, excluded.duration_kind)
                         END
WHERE excluded.total_tokens > usage_events.total_tokens
   OR (usage_events.tools IS NULL AND excluded.tools IS NOT NULL)
   OR (usage_events.duration_ms IS NULL AND excluded.duration_ms IS NOT NULL)`;

/**
 * Idempotent by construction: `event_key` is UNIQUE. Re-scanning a file can never
 * double-count.
 *
 * The upsert exists for one case: Claude Code writes each assistant message to the
 * transcript several times as it streams, and the first copy is a placeholder with
 * `output_tokens: 0`. Incremental reads see the placeholder first, so `INSERT OR
 * IGNORE` would freeze the row at zero output. The `DO UPDATE` clause upgrades a
 * stored row only when a later copy carries strictly more tokens — never downgrades,
 * so re-reading identical data is still a no-op.
 *
 * The one deliberate exception is `tools`: Claude Code writes one line per content
 * block under the same message.id with identical usage, so the tool names sit on
 * sibling copies whose totals are equal and the token guard can never reach them.
 * `tools` therefore widens independently: a copy carrying names may heal a stored
 * NULL even at equal tokens, and every other column keeps its stored value on that
 * path (the CASE guards), so nothing can regress. A stored non-NULL is never
 * overwritten by an equal-token copy.
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
INSERT INTO anomalies (
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

const SEV_RANK: Record<string, number> = { info: 0, warn: 1, critical: 2 };

export interface AnomalyWriteResult {
  /** Rows that did not exist before this call. */
  inserted: Anomaly[];
  /** Rows whose severity ROSE (warn → critical) — the escalation channel. */
  escalated: Anomaly[];
}

/**
 * Idempotent by `anomaly_key`, but not frozen: a window first seen at 3.1x (warn)
 * while still open under 5-second polling used to stay warn forever even when it
 * ended at 8x, because INSERT OR IGNORE kept the first sight. Now a stored row is
 * upgraded when the new copy carries a strictly larger `observed` or a higher
 * severity rank — never downgraded — and `detected_at` advances with the upgrade
 * so downstream watermarks (the app's notification gate) see the change.
 *
 * The two outcomes the caller must treat differently come back separately:
 * `inserted` always notifies; `escalated` is the severity-transition channel and
 * is the only update path that re-notifies, so a growing window does not page
 * anyone twice. Rows that changed nothing are not rewritten at all.
 */
export function insertAnomalies(db: DB, rows: Anomaly[]): AnomalyWriteResult {
  const result: AnomalyWriteResult = { inserted: [], escalated: [] };
  if (rows.length === 0) return result;
  const insert = db.prepare(INSERT_ANOMALY);
  const existing = db.prepare('SELECT severity, observed FROM anomalies WHERE anomaly_key = ?');
  const update = db.prepare(`
    UPDATE anomalies SET
      severity   = CASE WHEN :sevRank > CASE severity WHEN 'critical' THEN 2 WHEN 'warn' THEN 1 ELSE 0 END
                        THEN :severity ELSE severity END,
      observed   = MAX(observed, :observed),
      baseline   = :baseline,
      threshold  = :threshold,
      detail     = :detail,
      window_end = :window_end,
      detected_at = :detected_at
    WHERE anomaly_key = :anomaly_key
      AND (:observed > observed
           OR :sevRank > CASE severity WHEN 'critical' THEN 2 WHEN 'warn' THEN 1 ELSE 0 END)`);
  const run = db.transaction((rs: Anomaly[]) => {
    for (const r of rs) {
      const prev = existing.get(r.anomaly_key) as { severity: string; observed: number } | undefined;
      if (!prev) {
        if (insert.run({ ...r, ...ORIGIN }).changes > 0) result.inserted.push(r);
        continue;
      }
      const escalates = (SEV_RANK[r.severity] ?? 0) > (SEV_RANK[prev.severity] ?? 0);
      const grows = r.observed > prev.observed;
      if (!escalates && !grows) continue; // identical re-detection: no rewrite, no notify
      update.run({
        anomaly_key: r.anomaly_key, severity: r.severity, observed: r.observed,
        baseline: r.baseline, threshold: r.threshold, detail: r.detail,
        window_end: r.window_end, detected_at: r.detected_at,
        sevRank: SEV_RANK[r.severity] ?? 0,
      });
      if (escalates) result.escalated.push(r);
    }
  });
  run(rows);
  return result;
}

export interface CollectorState {
  source_path: string;
  tool: Tool;
  last_offset: number;
  last_mtime: number | null;
  last_scanned_at: number | null;
}

export interface CollectorRunRow {
  tool: string;
  started_at: number;
  duration_ms: number;
  files: number;
  parsed: number;
  inserted: number;
  source_state: string;
  ok: number;
  notes: string | null;
}

/**
 * The per-collector heartbeat: one row per collector per pass, written even when a
 * pass found nothing. `collector_state.last_scanned_at` is per-file and only Claude
 * Code writes it, so without this table a Codex- or OpenCode-only Mac is invisible
 * to every liveness check.
 */
export function recordCollectorRun(db: DB, r: CollectorRunRow): void {
  db.prepare(
    `INSERT INTO collector_runs
       (tool, started_at, duration_ms, files, parsed, inserted, source_state, ok, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.tool, r.started_at, r.duration_ms, r.files, r.parsed, r.inserted, r.source_state, r.ok, r.notes);
}

/** Latest run per collector — the four honest states a coverage strip renders from. */
export function latestCollectorRuns(db: DB): CollectorRunRow[] {
  return db
    .prepare(
      `SELECT tool, started_at, duration_ms, files, parsed, inserted, source_state, ok, notes
       FROM collector_runs cr
       WHERE started_at = (SELECT MAX(started_at) FROM collector_runs c2 WHERE c2.tool = cr.tool)
       ORDER BY tool`,
    )
    .all() as CollectorRunRow[];
}

// ── The scanner cadence lane ─────────────────────────────────────────────────
//
// Discovery work (codesign per binary, an /Applications walk, launchd plist
// enumeration) is orders of magnitude more expensive than a poll and must never
// ride the 5-second loop. Scanners register here with their OWN cadence; the
// collector checks the gate (one indexed read per scanner) on every poll but a
// scanner's body executes at most once per its cadence. Cadence means detection
// is delayed by up to one cadence — a runtime started and stopped between two
// scans is never seen, which is why scanner evidence carries a timestamp, never
// a claim of continuity.

export interface Scanner {
  name: string;
  cadenceMs: number;
  /** Must be cheap to skip and safe to overlap a poll; runs on its own cadence. */
  run: () => { ok: boolean; notes?: string };
}

export interface ScanStateRow {
  scanner: string;
  cadence_ms: number;
  last_started_at: number | null;
  last_duration_ms: number | null;
  ok: number | null;
  notes: string | null;
}

export function scanDue(db: DB, scanner: string, cadenceMs: number, now = Date.now()): boolean {
  const row = db
    .prepare('SELECT last_started_at FROM scan_state WHERE scanner = ?')
    .get(scanner) as { last_started_at: number | null } | undefined;
  if (!row || row.last_started_at === null) return true; // never ran: due immediately
  return now - row.last_started_at >= cadenceMs;
}

export function recordScan(
  db: DB,
  scanner: string,
  cadenceMs: number,
  startedAt: number,
  durationMs: number,
  ok: boolean,
  notes: string | null,
): void {
  db.prepare(
    `INSERT INTO scan_state (scanner, cadence_ms, last_started_at, last_duration_ms, ok, notes)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(scanner) DO UPDATE SET
       cadence_ms = excluded.cadence_ms,
       last_started_at = excluded.last_started_at,
       last_duration_ms = excluded.last_duration_ms,
       ok = excluded.ok,
       notes = excluded.notes`,
  ).run(scanner, cadenceMs, startedAt, durationMs, ok ? 1 : 0, notes);
}

export function latestScans(db: DB): ScanStateRow[] {
  return db
    .prepare('SELECT scanner, cadence_ms, last_started_at, last_duration_ms, ok, notes FROM scan_state ORDER BY scanner')
    .all() as ScanStateRow[];
}

// ── The triage inbox ─────────────────────────────────────────────────────────
//
// The app never writes the store (read-only by contract), but triage IS a write:
// acknowledge, mute, escalate. Those writes go to ~/.vole/inbox/*.json and the
// collector drains them into finding_actions on its next pass — the same
// single-writer discipline every other write follows.

export interface InboxItem {
  anomaly_key: string;
  action: 'acknowledged' | 'muted' | 'escalated' | 'reopened';
  note?: string | null;
  /** Mutes must expire: epoch-ms after which the mute no longer applies. */
  until?: number | null;
  actor?: string;
  created_at: number;
}

export function inboxDir(): string {
  return join(dirname(paths.db()), 'inbox');
}

/** Applies every spooled item, then removes the file it came from. */
export function drainInbox(db: DB): number {
  let dir: string[];
  try {
    dir = readdirSync(inboxDir());
  } catch {
    return 0; // no inbox yet — nothing triaged
  }
  const insert = db.prepare(
    'INSERT INTO finding_actions (anomaly_key, action, note, until, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  let applied = 0;
  for (const f of dir.sort()) {
    if (!f.endsWith('.json')) continue;
    const p = join(inboxDir(), f);
    try {
      const item = JSON.parse(readFileSync(p, 'utf8')) as InboxItem;
      if (item.anomaly_key && item.action) {
        insert.run(item.anomaly_key, item.action, item.note ?? null, item.until ?? null, item.actor ?? 'app', item.created_at ?? Date.now());
        applied++;
      }
      rmSync(p);
    } catch {
      /* unreadable or malformed: leave it for a human, do not lose the intent */
    }
  }
  return applied;
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
