/**
 * Tier 6 §6: the suppression register — turn a detector off centrally, keep
 * counting what it hid.
 *
 * Entries ship in an admin_authored pack (never vendor-signed). Two modes:
 *   mute_report — the detector still runs; findings are withheld, not deleted,
 *                 and suppressed_counts(day, kind, entry_id, n) increments.
 *   mute_scan   — the work is skipped entirely; that counter is written NULL —
 *                 never 0 — because "not evaluated" is not "no findings".
 * A reason is required: "0 findings" must never be indistinguishable from
 * "0 reported".
 */
import type { DB } from '../db';

export type SuppressionMode = 'mute_report' | 'mute_scan';

export interface SuppressionEntry {
  /** The rule id (or indicator kind) being muted. */
  kind: string;
  entry_id: string;
  /** Required. An unexplained mute is unauditable. */
  reason: string;
  set_by: string;
  expires_at?: number | null;
  mode?: SuppressionMode;
}

/** UTC day bucket — epoch-derived, not now()-in-key: the same day re-runs upsert the same row. */
const dayOf = (ts: number): number => Math.floor(ts / 86_400_000);

/**
 * Applies a suppressions block from an admin pack. Refuses entries without a
 * reason (returns them in `refused`). The register is current-state: the row
 * for a rule carries the newest entry's fields.
 */
export function applySuppressionPack(
  db: DB,
  entries: SuppressionEntry[],
  now: number,
): number {
  const up = db.prepare(
    `INSERT INTO suppression (rule, reason, suppressed_at, hidden_count, kind, entry_id, set_by, expires_at, mode)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
     ON CONFLICT(rule) DO UPDATE SET
       reason = excluded.reason,
       entry_id = excluded.entry_id,
       set_by  = excluded.set_by,
       expires_at = excluded.expires_at,
       mode    = excluded.mode`,
  );
  let applied = 0;
  for (const e of entries) {
    if (!e.reason || !e.reason.trim()) continue; // no reason: the entry is refused, never silently applied
    up.run(e.kind, e.reason, now, e.kind, e.entry_id, e.set_by, e.expires_at ?? null, e.mode ?? 'mute_report');
    applied++;
  }
  return applied;
}

export interface ActiveSuppression {
  rule: string;
  entry_id: string | null;
  mode: SuppressionMode;
  reason: string | null;
}

/** Entries in force right now (unexpired). Expired entries stay as history. */
export function activeSuppressions(db: DB, now: number): ActiveSuppression[] {
  const rows = db
    .prepare('SELECT rule, entry_id, mode, reason FROM suppression WHERE expires_at IS NULL OR expires_at > ?')
    .all(now) as { rule: string; entry_id: string | null; mode: string | null; reason: string | null }[];
  return rows.map((r) => ({
    rule: r.rule,
    entry_id: r.entry_id,
    mode: (r.mode === 'mute_scan' ? 'mute_scan' : 'mute_report') as SuppressionMode,
    reason: r.reason,
  }));
}

/** Split the register by mode: mute_scan rules must not be evaluated at all. */
export function splitModes(db: DB, now: number): { evaluate: Set<string>; skip: Set<string> } {
  const evaluate = new Set<string>();
  const skip = new Set<string>();
  for (const a of activeSuppressions(db, now)) (a.mode === 'mute_scan' ? skip : evaluate).add(a.rule);
  return { evaluate, skip };
}

/**
 * Increments the hidden-count accounting for one suppressed rule. `n === null`
 * means mute_scan (not evaluated) and writes NULL, never 0.
 */
export function recordSuppressed(db: DB, kind: string, entryId: string | null, n: number | null, now: number): void {
  const day = dayOf(now);
  db.prepare(
    `INSERT INTO suppressed_counts (day, kind, entry_id, n) VALUES (?, ?, ?, ?)
     ON CONFLICT(day, kind, entry_id) DO UPDATE SET
       n = CASE WHEN excluded.n IS NULL THEN NULL
                ELSE COALESCE(suppressed_counts.n, 0) + excluded.n END`,
  ).run(day, kind, entryId ?? '', n);
  if (n !== null && n > 0) {
    db.prepare('UPDATE suppression SET hidden_count = hidden_count + ? WHERE rule = ?').run(n, kind);
  }
}

/**
 * The detection-pass filter: mute_report rules keep counting what they hid
 * (the finding is withheld, the counter incremented); mute_scan rules never
 * reach here — the caller has already skipped their evaluation.
 */
export function suppressReported(
  db: DB,
  anomalies: { rule: string }[],
  now: number,
): { rule: string }[] {
  const active = new Map(activeSuppressions(db, now).map((a) => [a.rule, a]));
  const survivors: { rule: string }[] = [];
  const hiddenByRule = new Map<string, number>();
  for (const a of anomalies) {
    const s = active.get(a.rule);
    if (s && s.mode === 'mute_report') {
      hiddenByRule.set(a.rule, (hiddenByRule.get(a.rule) ?? 0) + 1);
    } else {
      survivors.push(a);
    }
  }
  for (const [rule, n] of hiddenByRule) {
    recordSuppressed(db, rule, active.get(rule)?.entry_id ?? null, n, now);
  }
  return survivors;
}
