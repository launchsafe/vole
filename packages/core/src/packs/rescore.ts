/**
 * Tier 6 §22 + §29 + §30(label carry-over): content_rev on incidents —
 * re-score without duplicating, retire without lying.
 *
 * anomaly_key deliberately excludes the pack revision: including it would
 * duplicate every open incident on every bump. The row instead carries
 * content_rev (the pack revision that first produced it) and a newer pack
 * scoring the same window higher widens severity/observed in place; a newer
 * pack scoring it lower changes nothing (rescore_declined — returned to the
 * caller because the column for it does not exist yet).
 */
import { insertAnomalies } from '../db';
import type { DB } from '../db';
import type { Anomaly } from '../types';

/**
 * Stamps the pack revision that produced rows which predate the column.
 * NULL-only widening: a row that already carries a content_rev is never
 * rewritten with a re-derived one.
 */
export function stampContentRev(db: DB, prevRev: number): number {
  const res = db
    .prepare('UPDATE anomalies SET content_rev = ? WHERE content_rev IS NULL AND rule != ?')
    .run(prevRev, 'content_stale');
  return res.changes;
}

export interface RescoreResult {
  inserted: Anomaly[];
  escalated: Anomaly[];
  /** Rows the newer pack scored lower — kept at their original severity, counted, never lied about. */
  declined: number;
}

/**
 * Insert-gated re-score at a pack revision. Rides the existing escalation
 * channel (severity/observed only ever widen); new rows carry content_rev,
 * and previously-unstamped rows from the old pack are stamped first.
 */
export function insertAnomaliesWithRev(db: DB, rows: Anomaly[], rev: number): RescoreResult {
  const r = insertAnomalies(db, rows);
  // content_rev is the revision that FIRST produced the row: only new rows are
  // stamped; an escalation by a newer pack widens severity in place and keeps
  // the original revision (the rescored_rev column does not exist yet).
  const mark = db.prepare('UPDATE anomalies SET content_rev = ? WHERE anomaly_key = ? AND content_rev IS NULL');
  for (const a of r.inserted) mark.run(rev, a.anomaly_key);

  // A decline is a row whose existing severity/observed the new pack did not
  // exceed — insertAnomalies skips it, so recompute against the store.
  let declined = 0;
  const seen = new Set([...r.inserted, ...r.escalated].map((a) => a.anomaly_key));
  const existing = db.prepare('SELECT severity, observed FROM anomalies WHERE anomaly_key = ?');
  const rank = (s: string) => (s === 'critical' ? 2 : s === 'warn' ? 1 : 0);
  for (const a of rows) {
    if (seen.has(a.anomaly_key)) continue;
    const prev = existing.get(a.anomaly_key) as { severity: string; observed: number } | undefined;
    if (prev && rank(a.severity) <= rank(prev.severity) && a.observed <= prev.observed) declined++;
  }
  return { ...r, declined };
}

/**
 * Pack-bump requeue: when the dlp_detectors version changes, retained
 * evidence is requeued so the next scan re-reads it inside the byte budget
 * the scan engine already enforces — a bump degrades throughput, never
 * blocks a poll. Files already deleted by the vendor's cleanup horizon
 * simply never come back; the honest answer for those is "not re-checked".
 */
export function requeueOnBump(db: DB, newRev: number): number {
  const res = db
    .prepare(
      `UPDATE dlp_scan_state SET pack_rev = ?, completed = 0
       WHERE pack_rev IS NULL OR pack_rev < ?`,
    )
    .run(newRev, newRev);
  return res.changes;
}

export interface ReReviewRow {
  anomaly_key: string;
  rule: string;
  severity: string;
  content_rev: number | null;
}

/**
 * The re-review queue: incidents produced by an older pack revision, still
 * open (no terminal state), each carrying why it is queued.
 */
export function reReviewQueue(db: DB, activeRev: number): { reason: string; rows: ReReviewRow[] } {
  const rows = db
    .prepare(
      `SELECT anomaly_key, rule, severity, content_rev FROM anomalies
       WHERE rule != 'content_stale' AND (content_rev IS NULL OR content_rev < ?)
         AND (state IS NULL OR state NOT IN ('resolved', 'dismissed', 'closed'))
       ORDER BY window_start`,
    )
    .all(activeRev) as ReReviewRow[];
  return { reason: `re-scored under a newer pack (active rev ${activeRev})`, rows };
}

/**
 * Label carry-over: because anomaly_key excludes the pack revision, every
 * disposition recorded against an incident survives a bump unchanged. This
 * surfaces the prior labels next to the queued re-review so the reviewer sees
 * what was already decided before re-scoring.
 */
export function carryOverLabels(db: DB, anomalyKeys: string[]): Record<string, { action: string; note: string | null; actor: string; created_at: number }[]> {
  if (anomalyKeys.length === 0) return {};
  const q = db.prepare('SELECT action, note, actor, created_at FROM finding_actions WHERE anomaly_key = ? ORDER BY created_at');
  const out: Record<string, { action: string; note: string | null; actor: string; created_at: number }[]> = {};
  for (const k of anomalyKeys) {
    const rows = q.all(k) as { action: string; note: string | null; actor: string; created_at: number }[];
    if (rows.length > 0) out[k] = rows;
  }
  return out;
}
