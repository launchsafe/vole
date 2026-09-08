import type { DB } from '../db';

/**
 * Generic NULL-only-widening upsert for the tier-5 ledgers: every table already
 * carries its UNIQUE key from migration 23, passed through verbatim. A stored
 * non-NULL is never overwritten; a conflict that widens nothing is a no-op
 * (`.changes` = 0), so idempotent re-polling costs nothing. Tables with
 * first_seen/last_seen stamps also bump last_seen.
 */
export interface UpsertSpec {
  table: string;
  keyCols: string[];
  /** Widenable data columns (NULL-only). */
  cols: string[];
  /** The table carries first_seen/last_seen stamp columns. */
  stamped?: boolean;
}

export function widenUpsert<T extends object>(
  db: DB,
  spec: UpsertSpec,
  rows: T[],
): number {
  if (!rows.length) return 0;
  const { table, keyCols, cols, stamped } = spec;
  const allCols = stamped ? [...keyCols, ...cols, 'first_seen', 'last_seen'] : [...keyCols, ...cols];
  // Stamp columns are bound to @now (collection time), everything else to its name.
  const values = allCols.map((c) => (c === 'first_seen' || c === 'last_seen' ? '@now' : `@${c}`)).join(', ');
  const sets = cols.map((c) =>
    `${c} = CASE WHEN ${table}.${c} IS NULL AND excluded.${c} IS NOT NULL THEN excluded.${c} ELSE ${table}.${c} END`,
  );
  const widening = cols.map((c) => `(${table}.${c} IS NULL AND excluded.${c} IS NOT NULL)`).join(' OR ');
  // Same contract as bind.ts: last_seen only moves when the row actually widened,
  // so re-polling unchanged sources is a true no-op (changes = 0).
  const gate = widening;
  const sql =
    `INSERT INTO ${table} (${allCols.join(', ')}) VALUES (${values})\n` +
    `ON CONFLICT(${keyCols.join(', ')}) DO UPDATE SET\n` +
    [...sets, ...(stamped ? ['last_seen = excluded.last_seen'] : [])].join(',\n') +
    (gate ? `\nWHERE ${gate}` : '');
  const stmt = db.prepare(sql);
  const run = db.transaction((batch: T[]) => {
    const now = Date.now();
    let changed = 0;
    for (const r of batch) {
      const params: Record<string, unknown> = { ...r } as Record<string, unknown>;
      for (const c of allCols) {
        // Stamp columns bind to @now, not to a row field.
        if (stamped && (c === 'first_seen' || c === 'last_seen')) continue;
        if (params[c] === undefined) params[c] = null;
      }
      if (stamped) params.now = now;
      changed += stmt.run(params).changes;
    }
    return changed;
  });
  return run(rows);
}
