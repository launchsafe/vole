/**
 * Tier 7 the answer sheet: a hunt's output is not a table, it is a
 * paragraph somebody has to send to a regulator, a customer or a board.
 * One sheet per hunt_runs row — the pack's name, signature and trust
 * class, the four verdict counters, the horizon — and each run is
 * versioned and never overwritten, because the paragraph is true only as
 * of the horizon it names: re-running the same pack later can flip a
 * not_seen to unanswerable as evidence ages out.
 */
import type { DB } from '../db';

export interface HuntRun {
  hunt_id: string;
  pack_kind: string;
  pack_version: number | null;
  signature: string | null;
  ran_at: number;
  verdict_confirmed: number | null;
  verdict_cleared: number | null;
  verdict_unanswerable: number | null;
  verdict_not_seen: number | null;
  horizon_ts: number | null;
  answer_sentence: string | null;
}

export function latestHunt(db: DB): HuntRun | null {
  return (db
    .prepare('SELECT * FROM hunt_runs ORDER BY ran_at DESC LIMIT 1')
    .get() as HuntRun | undefined) ?? null;
}

export function huntById(db: DB, hunt_id: string): HuntRun | null {
  return (db.prepare('SELECT * FROM hunt_runs WHERE hunt_id = ?').get(hunt_id) as HuntRun | undefined) ?? null;
}

/**
 * The sentence the security team sends back. The trust class comes from the
 * content_packs registry (builtin floor vs admin pack), never from the
 * hunt's own claim about itself.
 */
export function answerSheet(db: DB, run: HuntRun): string {
  const pack = db
    .prepare('SELECT trust FROM content_packs WHERE kind = ? AND version = ?')
    .get(run.pack_kind, run.pack_version) as { trust: string | null } | undefined;
  const trust = pack?.trust ?? 'unknown';
  const horizon = run.horizon_ts !== null ? new Date(run.horizon_ts).toISOString().slice(0, 10) : 'an unstated horizon';
  const parts = [
    `Under the ${run.pack_kind} pack v${run.pack_version ?? '?'} (signature ${run.signature ?? 'unsigned'}, trust ${trust}), as of ${horizon}:`,
    `${run.verdict_confirmed ?? 0} confirmed,`,
    `${run.verdict_cleared ?? 0} cleared,`,
    `${run.verdict_unanswerable ?? 0} unanswerable,`,
    `${run.verdict_not_seen ?? 0} not seen.`,
  ];
  const unanswerable = (run.verdict_unanswerable ?? 0) > 0;
  if (unanswerable) {
    parts.push('The unanswerable count is evidence aging, not absence: those indicators cannot be answered from what this device still holds.');
  }
  parts.push('This answer is true only as of the horizon it names; a later run may differ and never corrects this one.');
  return parts.join(' ');
}

/**
 * Records a hunt run. Idempotent on hunt_id; never overwrites an existing
 * row's counters — a re-run is a NEW row, because a corrected answer is a
 * different fact, not an update.
 */
export function recordHuntRun(db: DB, run: HuntRun): void {
  db.prepare(
    `INSERT OR IGNORE INTO hunt_runs
       (hunt_id, pack_kind, pack_version, signature, ran_at, verdict_confirmed,
        verdict_cleared, verdict_unanswerable, verdict_not_seen, horizon_ts, answer_sentence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.hunt_id, run.pack_kind, run.pack_version, run.signature, run.ran_at,
    run.verdict_confirmed, run.verdict_cleared, run.verdict_unanswerable,
    run.verdict_not_seen, run.horizon_ts, run.answer_sentence,
  );
}
