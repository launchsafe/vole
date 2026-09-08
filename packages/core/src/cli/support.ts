/**
 * Tier 7 the support bundle: a redacted diagnostic that carries the SHAPE of
 * the store and never its rows. When an admin says a laptop is reporting
 * wrong, this is the only artifact that can leave the machine: schema
 * history, PRAGMAs (quick_check, freelist, user_version), the sqlite_schema
 * digest, store sizes and budget rows, collector health, pack inventory,
 * and versions. Before it is written, the re-identification scan runs over
 * the whole payload — the same scan the evidence bundle uses — so a
 * username or hostname that crept into a note fails the bundle closed.
 *
 *   tsx packages/core/src/cli/support.ts [--out <path>]
 *
 * A bundle carrying no rows cannot explain a wrong row: it proves which
 * schema ran, which collectors ran and which bytes exist. The honest next
 * step for 'this number is wrong' is a named, consented evidence bundle for
 * that one incident, not a wider diagnostic.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { DB } from '../db';
import { paths } from '../paths';

const _require = createRequire(import.meta.url);

// ── The re-identification scan (shared with the evidence bundle) ─────────────

export interface ReIdHit {
  path: string;
  identifier: string;
  count: number;
}

/**
 * The local identifiers a payload must not carry: the OS username, the
 * hostname and its short form, the directory-service RealName, and the
 * oauth email ~/.claude.json holds. `extra` lets tests inject their own.
 */
export function localIdentifiers(extra: string[] = []): string[] {
  const ids = new Set<string>();
  try { ids.add(userInfo().username); } catch { /* no uid */ }
  try {
    const h = hostname();
    ids.add(h);
    ids.add(h.split('.')[0]!);
  } catch { /* no hostname */ }
  try {
    const u = userInfo().username;
    const real = execFileSync('dscl', ['.', '-read', `/Users/${u}`, 'RealName'], { encoding: 'utf8' });
    for (const line of real.split('\n')) {
      const v = line.replace(/^RealName:/, '').trim();
      if (v) ids.add(v);
    }
  } catch { /* not macOS, or no RealName — not an identifier */ }
  try {
    const home = process.env.VOLE_HOME_OVERRIDE ?? userInfo().homedir;
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
      oauthAccount?: { emailAddress?: string };
    };
    if (cfg.oauthAccount?.emailAddress) ids.add(cfg.oauthAccount.emailAddress);
  } catch { /* no oauth on this machine */ }
  for (const e of extra) if (e) ids.add(e);
  return [...ids].filter((i) => i.length >= 3);
}

/**
 * Walks every string in a payload looking for the local identifiers. Returns
 * the hits; an empty array is the pass. Values are never echoed back — only
 * the JSON path and the identifier KIND, so the scan's own report cannot
 * leak what it found.
 */
export function reIdentificationScan(payload: unknown, identifiers: string[]): ReIdHit[] {
  const hits: ReIdHit[] = [];
  const walk = (v: unknown, path: string): void => {
    if (typeof v === 'string') {
      for (const id of identifiers) {
        if (v.includes(id)) {
          hits.push({ path, identifier: id.length > 3 ? 'local identifier' : 'short id', count: v.split(id).length - 1 });
        }
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    }
  };
  walk(payload, '$');
  return hits;
}

// ── Redaction (applied when composing an outbound bundle payload) ─────────────

/**
 * Replaces, in every string of a payload, the home directory with '~' and every
 * local identifier (username, hostname, RealName, oauth email) with
 * '<redacted>'. Deterministic — split/join, no clocks, no random salt — so the
 * same source row always redacts to the same value and sync dedupe keys stay
 * comparable. This is the composition-time transform; the re-identification
 * scan afterwards stays the fail-closed gate: if anything slipped past, the
 * bundle does not leave the machine.
 */
export function redactIdentifiers<T>(payload: T, identifiers: string[]): T {
  let homeDir: string | null = null;
  try {
    homeDir = userInfo().homedir;
  } catch {
    homeDir = null;
  }
  const redactString = (s: string): string => {
    let out = homeDir ? s.split(homeDir).join('~') : s;
    for (const id of identifiers) out = out.split(id).join('<redacted>');
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(payload) as T;
}

// ── store_epoch: proving the database is the one you were given ───────────────

export interface StoreEpochRow {
  epoch_id: string;
  created_at: number;
  device_key: string | null;
  first_event_ts: number | null;
  collector_version: string | null;
  prev_epoch_id: string | null;
  prev_epoch_last_seq: number | null;
}

/**
 * Writes the epoch row ONCE, when the table is empty. prev_epoch_id is NULL
 * on a genuinely first install — and that is the whole mechanism: a sink
 * already holding rows stamped epoch A from device D that now receives
 * epoch B with prev_epoch_id NULL has proof the store was deleted and
 * recreated, with first_event_ts showing exactly how much history came
 * back. The epoch must NOT enter the sync dedupe key.
 */
export function ensureStoreEpoch(db: DB, collectorVersion: string): StoreEpochRow | null {
  const existing = db.prepare('SELECT * FROM store_epoch LIMIT 1').get() as StoreEpochRow | undefined;
  if (existing) return existing;
  const firstEvent = (db.prepare('SELECT MIN(ts) AS t FROM usage_events').get() as { t: number | null }).t;
  // The previous epoch's change cursor is the durable outbox's MAX(seq) —
  // export_seq (the original sketch) was dropped by migration 28; NULL means
  // nothing was ever queued, never zero.
  const lastSeq = (db.prepare('SELECT MAX(seq) AS s FROM export_outbox').get() as { s: number | null }).s;
  let device: string | null = null;
  try {
    // Same stable identity the tier-3 machinery uses, without importing the
    // Keychain-touching module into a CLI that must stay dependency-light.
    const { deviceKey } = _require('../identity') as typeof import('../identity');
    device = deviceKey();
  } catch {
    device = null; // unknown, never invented
  }
  const createdAt = Date.now();
  const epoch_id = `e:${createHash('sha256').update(`${device ?? 'unknown'}|${firstEvent ?? 'none'}|${createdAt}`).digest('hex').slice(0, 24)}`;
  db.prepare(
    `INSERT OR IGNORE INTO store_epoch
       (epoch_id, created_at, device_key, first_event_ts, collector_version, prev_epoch_id, prev_epoch_last_seq)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  ).run(epoch_id, createdAt, device, firstEvent, collectorVersion, lastSeq);
  return db.prepare('SELECT * FROM store_epoch LIMIT 1').get() as StoreEpochRow;
}

// ── The bundle ───────────────────────────────────────────────────────────────

function swVers(): string | null {
  try {
    return execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
  } catch {
    return null; // not macOS — unknown, never invented
  }
}

function fileSize(p: string): number | null {
  try {
    return statSync(p).size;
  } catch {
    return null;
  }
}

/**
 * Builds the redacted diagnostic: the store's shape, never its rows.
 * Every count and PRAGMA is read-only.
 */
export function supportBundle(db: DB): Record<string, unknown> {
  const dbFile = paths.db();
  const schemaSql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all() as { sql: string }[]
  ).map((r) => r.sql).join('\n;\n');
  const lastRun = db
    .prepare(
      `SELECT tool, MAX(started_at) AS last_run FROM collector_runs GROUP BY tool ORDER BY tool`,
    )
    .all() as { tool: string; last_run: number }[];
  return {
    bundle_kind: 'vole_support_bundle',
    versions: {
      vole: _require('../../package.json').version as string,
      node: process.version,
      sqlite: (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v,
      macOS: swVers(),
    },
    store: {
      path_basename: 'vole.db',
      sizes_bytes: {
        db: fileSize(dbFile),
        wal: fileSize(dbFile + '-wal'),
        shm: fileSize(dbFile + '-shm'),
      },
      user_version: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      sqlite_schema_sha256: createHash('sha256').update(schemaSql).digest('hex'),
      freelist_count: (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count,
      page_count: (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count,
      quick_check: (db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check,
    },
    schema_migrations: db
      .prepare('SELECT version, name, kind, applied_at, duration_ms, rows_changed FROM schema_migrations ORDER BY version')
      .all(),
    store_budget: db.prepare('SELECT * FROM store_budget').all(),
    store_prunes: db.prepare('SELECT table_name, SUM(deleted_rows) AS deleted_rows FROM store_prunes GROUP BY table_name').all(),
    collector_health: {
      last_run_per_tool: lastRun.map((r) => ({ tool: r.tool, last_run: r.last_run })), // no run record = NULL, never zero
      recent_runs: db
        .prepare(
          `SELECT tool, started_at, duration_ms, files, parsed, inserted, source_state, ok,
                  rss_peak_bytes, cpu_user_ms, cpu_sys_ms, exit_status
           FROM collector_runs ORDER BY started_at DESC LIMIT 50`,
        )
        .all(),
    },
    content_packs: db.prepare('SELECT kind, version, trust, active FROM content_packs ORDER BY kind, version').all(),
    store_epoch: db.prepare('SELECT * FROM store_epoch LIMIT 1').all(),
    footprint_metric:
      'rss_peak_bytes = process.memoryUsage().rss at run end; cpu_user_ms/cpu_sys_ms = process.cpuUsage() deltas since process start',
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : null;

  const { openDbReadOnly } = _require('../db') as typeof import('../db');
  const db = openDbReadOnly();
  const bundle = supportBundle(db);
  db.close();

  // The bundle must pass its own content check BEFORE it is written anywhere:
  // a hit fails closed, and the report names only the path, never the value.
  const ids = localIdentifiers();
  const hits = reIdentificationScan(bundle, ids);
  if (hits.length > 0) {
    console.error('support bundle: FAIL — re-identification scan found local identifiers:');
    for (const h of hits) console.error(`  ${h.path} (${h.count}x)`);
    process.exit(1);
  }

  const json = JSON.stringify(bundle, null, 1);
  if (out) {
    writeFileSync(out, json);
    console.log(`support bundle written (redaction scan passed): ${out}`);
  } else {
    console.log(json);
  }
}

if (process.argv[1]?.endsWith('support.ts')) {
  main();
}
