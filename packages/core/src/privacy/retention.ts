/**
 * Tier 8: retention split by data class, with a receipt, gated on what can
 * still be rebuilt. Classes whose pressures point in opposite directions:
 * behavioural rows minimise downward; incident evidence has an upward floor
 * wherever the org has declared itself a deployer under EU AI Act Art. 27/49 —
 * a floor the PROFILE declares, because Vole cannot know whether the org is a
 * deployer, and whether a deterministic rule engine falls under Annex III
 * 4(b) at all is unsettled (Annex III obligations deferred to 2027-12-02 by
 * Regulation (EU) 2026/1744). Both are shown; neither is silently chosen.
 *
 * Deletion is not free: the store stopped being disposable the moment a row
 * outlived its source, so the prune gates every deletion on the row's own
 * raw_ref still existing on disk (rebuildable), and refuses — with a named
 * refused section — anything it would destroy for good. Receipts land in
 * store_prunes, one row per data class per pass.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { DB } from '../db';
import { paths } from '../paths';

export interface ClassTables {
  table: string;
  time_col: string;
}

export interface RetentionClass {
  /** The data class name (the policy block's key). */
  class: string;
  tables: ClassTables[];
  /** Configured retention in days; null = keep indefinitely. */
  days: number | null;
  /** The declared upward floor (AI Act deployer obligation), when declared. */
  floor_days: number | null;
  reason: string;
}

export interface RetentionPolicy {
  classes: RetentionClass[];
  /** The org's declared AI Act deployer floor; null when undeclared. */
  ai_act_floor_days: number | null;
  source: string | null;
}

/** The class vocabulary — closed, like the purpose union. */
const CLASS_DEFS: Omit<RetentionClass, 'days' | 'floor_days'>[] = [
  {
    class: 'behavioural',
    tables: [
      { table: 'usage_events', time_col: 'ts' },
      { table: 'tool_calls', time_col: 'ts' },
    ],
    reason: 'per-call behaviour minimises downward once it has served detection',
  },
  {
    class: 'operational',
    tables: [
      { table: 'collector_runs', time_col: 'started_at' },
      { table: 'access_log', time_col: 'ts' },
      { table: 'scan_state', time_col: 'last_started_at' },
    ],
    reason: 'collector health and view audit; the running window only',
  },
  {
    class: 'incident_evidence',
    tables: [
      { table: 'anomalies', time_col: 'window_end' },
      { table: 'secret_sightings', time_col: 'last_seen' },
    ],
    reason: 'incident evidence holds an upward floor wherever the org is a deployer',
  },
];

/** Loads the retention block from the rule policy (managed first, user refines). */
export function loadRetentionPolicy(
  files: string[] = paths.rulePolicyPaths(),
): RetentionPolicy {
  let parsed: {
    retention?: {
      classes?: Record<string, { days?: number | null; floor_days?: number | null }>;
      ai_act_floor_days?: number | null;
    };
  } | null = null;
  let source: string | null = null;
  for (const p of files) {
    if (!existsSync(p)) continue;
    try {
      parsed = JSON.parse(readFileSync(p, 'utf8'));
      source = p;
    } catch {
      /* malformed layer ignored, same as every other policy read */
    }
  }
  const declared = parsed?.retention?.classes ?? {};
  const classes: RetentionClass[] = CLASS_DEFS.map((def) => {
    const d = declared[def.class];
    const days = d && typeof d.days === 'number' ? d.days : d && d.days === null ? null : defaultDays(def.class);
    const floor = d && typeof d.floor_days === 'number' ? d.floor_days : null;
    return { ...def, days, floor_days: floor };
  });
  const aiAct = parsed?.retention?.ai_act_floor_days;
  return {
    classes,
    ai_act_floor_days: typeof aiAct === 'number' ? aiAct : null,
    source,
  };
}

/** Defaults when the org declared nothing: shown, not chosen. */
function defaultDays(cls: string): number | null {
  if (cls === 'incident_evidence') return null; // no deletion without a decision
  return 90; // ponytail: the pre-feature default, one value for both remaining classes
}

export interface PruneTableResult {
  table: string;
  data_class: string;
  /** Rows the pass deleted. */
  deleted_rows: number;
  /** Rows held back: their source is gone (or a floor protects them). */
  refused_rows: number;
  refused_reason: string | null;
  total_rows: number;
  oldest_deleted_ts: number | null;
  newest_deleted_ts: number | null;
}

export interface PrunePassResult {
  results: PruneTableResult[];
  /** Receipt rows as written to store_prunes (empty in dry run). */
  receipts: { table_name: string; data_class: string; days: number; deleted_rows: number; bytes_before: number; bytes_after: number; ran_at: number }[];
}

function fileBytes(db: DB): number {
  const page = db.prepare('PRAGMA page_count').get() as { page_count: number };
  const size = db.prepare('PRAGMA page_size').get() as { page_size: number };
  return page.page_count * size.page_size;
}

/** Is a usage_events row rebuildable? Only when its raw_ref still exists on disk. */
export function rawRefRebuildable(rawRef: string | null): boolean {
  if (!rawRef) return false;
  try {
    return statSync(rawRef).isFile();
  } catch {
    return existsSync(rawRef);
  }
}

/**
 * One prune pass over every class. Dry run by default: reports what would go,
 * what is refused and why, without deleting. Receipts (store_prunes) are
 * written only on apply, one row per table per pass, with bytes measured
 * from page_count × page_size around the pass.
 */
export function prunePass(
  db: DB,
  policy: RetentionPolicy,
  opts: { apply: boolean; now?: number },
): PrunePassResult {
  const now = opts.now ?? Date.now();
  const results: PruneTableResult[] = [];
  const receipts: PrunePassResult['receipts'] = [];
  for (const cls of policy.classes) {
    if (cls.days === null) continue; // keep indefinitely: a decision, not an accident
    const cutoff = now - cls.days * 86_400_000;
    for (const t of cls.tables) {
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${t.table}`).get() as { n: number }).n;
      const old = db.prepare(
        `SELECT rowid AS id${t.table === 'usage_events' ? ', raw_ref' : ', NULL AS raw_ref'} FROM ${t.table} WHERE ${t.time_col} < ?`,
      ).all(cutoff) as { id: number; raw_ref: string | null }[];
      let deleted = 0;
      let refused = 0;
      let refusedReason: string | null = null;
      let oldest: number | null = null;
      let newest: number | null = null;
      const ids: number[] = [];
      for (const r of old) {
        // Gated on rebuildability: a row whose source is gone is the only copy
        // of that fact — deleting it destroys evidence. Refuse, name the reason.
        if (t.table === 'usage_events' && !rawRefRebuildable(r.raw_ref)) {
          refused++;
          refusedReason = 'source gone: raw_ref missing or pruned — the store holds the only copy';
          continue;
        }
        if (t.table === 'anomalies' && cls.floor_days !== null && cls.days < cls.floor_days) {
          refused++;
          refusedReason = `declared floor ${cls.floor_days}d exceeds configured ${cls.days}d`;
          continue;
        }
        ids.push(r.id);
      }
      if (opts.apply && ids.length > 0) {
        const bytesBefore = fileBytes(db);
        const del = db.transaction((rows: number[]) => {
          let n = 0;
          const stmt = db.prepare(`DELETE FROM ${t.table} WHERE rowid = ?`);
          for (const id of rows) n += stmt.run(id).changes;
          return n;
        });
        deleted = del(ids);
        const bounds = db.prepare(
          `SELECT MIN(${t.time_col}) AS a, MAX(${t.time_col}) AS b FROM ${t.table}`,
        ).get() as { a: number | null; b: number | null };
        oldest = bounds.a;
        newest = bounds.b;
        receipts.push({
          table_name: t.table,
          data_class: cls.class,
          days: cls.days,
          deleted_rows: deleted,
          bytes_before: bytesBefore,
          bytes_after: fileBytes(db),
          ran_at: now,
        });
      }
      results.push({
        table: t.table,
        data_class: cls.class,
        deleted_rows: deleted,
        refused_rows: refused,
        refused_reason: refusedReason,
        total_rows: total,
        oldest_deleted_ts: oldest,
        newest_deleted_ts: newest,
      });
    }
  }
  if (opts.apply) {
    const ins = db.prepare(
      `INSERT INTO store_prunes (table_name, data_class, days, deleted_rows, bytes_before, bytes_after, ran_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of receipts) {
      ins.run(r.table_name, r.data_class, r.days, r.deleted_rows, r.bytes_before, r.bytes_after, r.ran_at);
    }
  }
  return { results, receipts };
}
