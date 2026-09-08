/**
 * Tier 7 detection quality and response metrics.
 *
 * RULE QUALITY — per rule and content_rev: findings, cases, labelled cases
 * split by disposition, unlabelled, and the label_mode split between
 * individually opened and bulk-swept. The precision ratio is printed ONLY
 * when labelled cases clear a floor (default 20 cases AND 20% of the rule's
 * cases); below the floor the cell is NULL and the caller renders an em dash
 * and the literal denominator ('9 of 21 cases labelled'). Precision is
 * knowable only over labelled cases and labellers choose the interesting
 * ones, so the figure is biased in a direction the product cannot measure —
 * recall is never shown at all, because Vole cannot count the findings it
 * failed to produce.
 *
 * MTTA / MTTR — medians (never means; one incident left open for a weekend
 * must not drag a median), per rule, computed ONLY from clocks Vole itself
 * wrote: finding_actions.ts minus anomalies.detected_at, never a vendor
 * clock and never window_end. Backfill exclusion: a detection run that
 * stamped many rows with one detected_at (a first pass over months of
 * history) is discovery='backfill' and is excluded from MTTA entirely
 * rather than handed a plausible-looking number. Beside every median sits
 * the complementary count of cases with no action at all, split by whether
 * a queue_opened record ever landed during the case's open life: unattended
 * (the queue was never opened — nobody could have triaged it) versus
 * unactioned (the queue was open and the case was still left alone).
 */
import type { DB } from '../db';

/** The labelled-fraction floor: precision renders only above BOTH bounds. */
export const QUALITY_FLOOR_CASES = 20;
export const QUALITY_FLOOR_FRACTION = 0.2;

export interface RuleQuality {
  rule: string;
  content_rev: number | null;
  findings: number;
  cases: number;
  labelled: number;
  by_state: Record<string, number>;
  unlabelled: number;
  labelled_single: number;
  labelled_bulk: number;
  /** null below the floor — the caller renders '—' plus the literal denominator. */
  precision: number | null;
  floor_met: boolean;
}

export function ruleQuality(db: DB): RuleQuality[] {
  const cases = db
    .prepare(
      `SELECT rule, content_rev, COUNT(*) AS findings, COUNT(DISTINCT COALESCE(case_key, anomaly_key)) AS cases
       FROM anomalies GROUP BY rule, content_rev`,
    )
    .all() as { rule: string; content_rev: number | null; findings: number; cases: number }[];
  const actions = db
    .prepare(
      `SELECT a.rule, a.content_rev AS a_rev, f.action, f.label_mode, COUNT(DISTINCT COALESCE(a.case_key, a.anomaly_key)) AS n
       FROM finding_actions f JOIN anomalies a ON a.anomaly_key = f.anomaly_key
       GROUP BY a.rule, a.content_rev, f.action, f.label_mode`,
    )
    .all() as { rule: string; a_rev: number | null; action: string; label_mode: string | null; n: number }[];

  const distinctLabelled = db.prepare(
    `SELECT COUNT(DISTINCT COALESCE(a.case_key, a.anomaly_key)) AS n, f.label_mode AS m
     FROM finding_actions f JOIN anomalies a ON a.anomaly_key = f.anomaly_key
     WHERE a.rule = ? AND COALESCE(a.content_rev, -1) = COALESCE(?, -1)
       AND f.action NOT IN ('queue_opened', 'acknowledged')
     GROUP BY f.label_mode`,
  );

  return cases.map((c) => {
    const mine = actions.filter((x) => x.rule === c.rule && x.a_rev === c.content_rev);
    const by_state: Record<string, number> = {};
    for (const x of mine) by_state[x.action] = (by_state[x.action] ?? 0) + x.n;
    const split = distinctLabelled.all(c.rule, c.content_rev) as { n: number; m: string | null }[];
    const labelled = split.reduce((s, r) => s + r.n, 0);
    const single = split.filter((r) => r.m !== 'bulk').reduce((s, r) => s + r.n, 0);
    const bulk = split.filter((r) => r.m === 'bulk').reduce((s, r) => s + r.n, 0);
    const floor = labelled >= QUALITY_FLOOR_CASES && labelled >= QUALITY_FLOOR_FRACTION * c.cases;
    const terminal = ['resolved', 'false_positive', 'expected', 'accepted_risk'];
    const fp = Object.entries(by_state)
      .filter(([k]) => terminal.includes(k) && k !== 'resolved')
      .reduce((s, [, v]) => s + v, 0);
    return {
      rule: c.rule,
      content_rev: c.content_rev,
      findings: c.findings,
      cases: c.cases,
      labelled,
      by_state,
      unlabelled: c.cases - labelled,
      labelled_single: single,
      labelled_bulk: bulk,
      precision: floor && labelled > 0 ? fp / labelled : null,
      floor_met: floor,
    };
  });
}

// ── MTTA / MTTR ──────────────────────────────────────────────────────────────

export interface ResponseStat {
  rule: string;
  /** Median minutes from detected_at to the first action; null if none. */
  mtta_min: number | null;
  /** Median minutes from detected_at to the first TERMINAL action; null if none. */
  mttr_min: number | null;
  with_action: number;
  unattended: number;
  unactioned: number;
  /** Cases excluded because their detected_at was a backfill stamp. */
  backfill_excluded: number;
}

const TERMINAL = ['resolved', 'false_positive', 'expected', 'accepted_risk'];

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * A detected_at value shared by >= 3 anomalies is a backfill stamp: a whole
 * history discovered in one first pass. ponytail: the threshold is a
 * heuristic — the honest fix is a discovery='backfill' marker on the row,
 * which needs a coordinated foundation column. Until then, shared-stamp
 * detection is conservative (excludes only clearly-batched stamps).
 */
const BACKFILL_STAMP_MIN_ROWS = 3;

export function mttaMttr(db: DB): ResponseStat[] {
  const rows = db
    .prepare(
      `SELECT anomaly_key, rule, detected_at FROM anomalies WHERE source = 'live'`,
    )
    .all() as { anomaly_key: string; rule: string; detected_at: number }[];
  const actions = db
    .prepare(
      `SELECT anomaly_key, action, created_at FROM finding_actions ORDER BY created_at`,
    )
    .all() as { anomaly_key: string; action: string; created_at: number }[];
  const byKey = new Map<string, { action: string; created_at: number }[]>();
  for (const a of actions) {
    if (a.action === 'queue_opened') continue; // a UI event, not a case action
    const arr = byKey.get(a.anomaly_key);
    if (arr) arr.push(a);
    else byKey.set(a.anomaly_key, [a]);
  }

  // Backfill stamps: detected_at values shared by many rows.
  const stampCount = new Map<number, number>();
  for (const r of rows) stampCount.set(r.detected_at, (stampCount.get(r.detected_at) ?? 0) + 1);

  // Whether the queue was ever opened, and when — the unattended/unactioned split.
  const queueOpens = actions
    .filter((a) => a.action === 'queue_opened')
    .map((a) => a.created_at)
    .sort((a, b) => a - b);

  const perRule = new Map<string, ResponseStat & { acks: number[]; res: number[] }>();
  for (const r of rows) {
    const st = perRule.get(r.rule) ?? {
      rule: r.rule, mtta_min: null, mttr_min: null, with_action: 0,
      unattended: 0, unactioned: 0, backfill_excluded: 0, acks: [], res: [],
    };
    if ((stampCount.get(r.detected_at) ?? 0) >= BACKFILL_STAMP_MIN_ROWS) {
      st.backfill_excluded++;
      perRule.set(r.rule, st);
      continue;
    }
    const acts = byKey.get(r.anomaly_key) ?? [];
    const first = acts[0]?.created_at;
    const terminal = acts.find((a) => TERMINAL.includes(a.action))?.created_at;
    if (first !== undefined) {
      st.with_action++;
      st.acks.push(first - r.detected_at);
    } else {
      // No action at all. Unattended = the queue was never opened during the
      // case's open life (after detection); unactioned = it was.
      const openedAfter = queueOpens.some((t) => t >= r.detected_at);
      if (openedAfter) st.unactioned++;
      else st.unattended++;
    }
    if (terminal !== undefined) st.res.push(terminal - r.detected_at);
    perRule.set(r.rule, st);
  }

  return [...perRule.values()].map((s) => ({
    rule: s.rule,
    mtta_min: s.acks.length ? median(s.acks)! / 60000 : null,
    mttr_min: s.res.length ? median(s.res)! / 60000 : null,
    with_action: s.with_action,
    unattended: s.unattended,
    unactioned: s.unactioned,
    backfill_excluded: s.backfill_excluded,
  }));
}
