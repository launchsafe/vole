import type { Anomaly, UsageEvent } from '../types';
import { bucketOf, groupBy, leaveOneOutMedians, withTokens, worstConfidence, fmt, shortId } from './util';

const WINDOW_MS = 10 * 60 * 1000;
/** Below this a "spike" is just noise — a single large prompt should not page anyone. */
const MIN_TOKENS_IN_WINDOW = 20_000;
const SPIKE_MULTIPLE = 3;
/** A leave-one-out median needs at least this many surviving windows to mean anything. */
const MIN_BASELINE_WINDOWS = 3;

/**
 * Billable burn-rate spike.
 *
 * Scores each 10-minute window on what it COST, not on raw tokens: for Claude Code
 * ~85% of total_tokens is cache reads priced at 0.1x, so a total-token rule reports
 * that "the context got large", not that money was spent — on the live store it
 * fired on 14.8% of windows and dominated the incident feed with cache-read noise.
 * A window is scored on SUM(cost_usd) when every row in it is priced, and on
 * SUM(total_tokens - cache_read_tokens) otherwise (cache reads are the cheap 0.1x
 * component; cache writes are billable and stay in). The raw token total stays in
 * the detail line so nothing is hidden.
 *
 * Baseline hygiene: only windows that themselves clear MIN_TOKENS_IN_WINDOW are
 * baseline candidates. A stray call, or the still-open current window under polling,
 * must not drag the median down — a [30k, 800, 90k] sequence used to report 5.8x
 * where the truth is 3.0x. The group is (tool, model, session), so concurrent
 * subagents sharing a window are no longer charged to a single session's baseline.
 */
export function detectBillableBurn(events: UsageEvent[], now: number): Anomaly[] {
  const out: Anomaly[] = [];
  const usable = withTokens(events);

  for (const [key, group] of groupBy(usable, (e) => `${e.tool}::${e.model ?? 'unknown'}::${e.session_id ?? 'none'}`)) {
    const windows = groupBy(group, (e) => String(bucketOf(e.ts, WINDOW_MS)));
    if (windows.size < MIN_BASELINE_WINDOWS + 1) continue; // too little history to have a "normal"

    const scored = [...windows.entries()].map(([bucketStr, evs]) => ({
      bucket: Number(bucketStr),
      evs,
      raw: evs.reduce((s, e) => s + (e.total_tokens ?? 0), 0),
      // BOTH units are computed per window; which one is compared is decided once
      // for the whole group below. usd is null unless every row in the window has a
      // resolvable cost.
      usd: evs.every((e) => e.cost_usd !== null)
        ? evs.reduce((s, e) => s + (e.cost_usd ?? 0), 0)
        : null,
      // Uncached tokens: the expensive majority of what is left once 0.1x cache
      // reads come out.
      tokens: evs.reduce((s, e) => s + Math.max(0, (e.total_tokens ?? 0) - (e.cache_read_tokens ?? 0)), 0),
    }));

    const candidates = scored.filter((w) => w.raw >= MIN_TOKENS_IN_WINDOW);
    if (candidates.length < MIN_BASELINE_WINDOWS + 1) continue;

    // ONE unit for the whole group, decided here rather than per window. Scoring each
    // window independently meant a single unpriced row anywhere in one window flipped
    // that window from a ~0.09 DOLLAR score to a ~30000 TOKEN score, which was then
    // compared against a dollar median — minting a `critical` "333333.3x typical" out
    // of an utterly ordinary window. The mirror-image false negative was just as real:
    // a genuine $5 spike measured against a token median could never fire. Dollars and
    // uncached tokens are not commensurable; a median across a mixed array is meaningless.
    const priced = candidates.every((w) => w.usd !== null);
    const scoreOf = (w: (typeof candidates)[number]) => (priced ? (w.usd ?? 0) : w.tokens);

    // One O(W log W) pass for the whole group: the leave-one-out median of the
    // surviving candidates for each surviving candidate.
    const loo = leaveOneOutMedians(candidates.map(scoreOf));

    const [tool, model, session] = key.split('::');
    for (let ci = 0; ci < candidates.length; ci++) {
      const w = candidates[ci]!;

      // Baseline excludes this window, so a spike cannot mask itself — and every
      // sub-threshold window, which is noise by definition, not a "normal" one.
      const baseline = loo[ci]!;
      if (baseline <= 0) continue;
      const score = scoreOf(w);
      if (score <= baseline * SPIKE_MULTIPLE) continue;

      const multiple = score / baseline;
      const first = w.evs[0];
      if (!first) continue;

      const perMin = score / (WINDOW_MS / 60000);
      const money = priced
        ? `$${score.toFixed(2)} in 10 min ($${perMin.toFixed(2)}/min)`
        : `${fmt(score)} uncached tokens in 10 min (${fmt(perMin)}/min)`;

      out.push({
        anomaly_key: `billable_burn_spike:${tool}:${model}:${session}:${w.bucket}`,
        rule: 'billable_burn_spike',
        severity: multiple >= 6 ? 'critical' : 'warn',
        tool: first.tool,
        session_id: first.session_id,
        model: model === 'unknown' ? null : (model ?? null),
        window_start: w.bucket,
        window_end: w.bucket + WINDOW_MS,
        title: `Billable burn spike on ${first.tool} (${model})`,
        detail:
          `${money} across ${w.evs.length} calls — ${multiple.toFixed(1)}x this session's typical window ` +
          `(${priced ? `$${baseline.toFixed(2)}` : `${fmt(baseline)} uncached tokens`}). ` +
          `Raw ${fmt(w.raw)} tokens including cache reads. Session ${shortId(first.session_id)}.`,
        observed: score,
        baseline,
        threshold: baseline * SPIKE_MULTIPLE,
        confidence: worstConfidence(w.evs),
        source: first.source,
        detected_at: now,
      });
    }
  }
  return out;
}
