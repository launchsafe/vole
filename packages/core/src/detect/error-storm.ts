import type { Anomaly, UsageEvent } from '../types';
import { bucketOf, groupBy, worstConfidence, shortId } from './util';

const WINDOW_MS = 15 * 60 * 1000;
const MIN_ERRORS = 5;
const RATIO_THRESHOLD = 0.2;

/**
 * Quota exhaustion is not a failing tool: Grok's 403 spending-limit rows were 7 of
 * the 10 live error_storm incidents — quota misfiled as breakage. Quota-shaped
 * failures are split out of the ratio and named in the detail; they belong to the
 * quota surface (rate_limit_pressure already reads Codex's own headroom).
 */
const QUOTA_RE = /limit|quota|403|billing|spend|exceeded|credit/i;

/**
 * error_storm, narrowed to assistant-level API failures (tier 5 #34):
 *  - activity_only rows are never counted — a tool that records a call but no
 *    outcome cannot testify that anything failed;
 *  - quota-shaped failures are counted separately and excluded from the ratio;
 *  - tool-call failures are NOT this rule — tool_failure_storm (behaviour.ts)
 *    names the failing tool from the ledger.
 *
 * Requires both an absolute error count and a ratio: 3 errors out of 4 calls is a
 * quiet session, not an incident, while 5 errors out of 200 calls is noise. Both
 * must trip.
 */
export function detectErrorStorms(events: UsageEvent[], now: number): Anomaly[] {
  const out: Anomaly[] = [];
  // Assistant-level rows only: activity_only rows carry no error signal at all.
  const usable = events.filter((e) => e.confidence !== 'activity_only');

  for (const [key, group] of groupBy(usable, (e) => `${e.tool}::${e.session_id ?? 'none'}`)) {
    const windows = groupBy(group, (e) => String(bucketOf(e.ts, WINDOW_MS)));

    for (const [bucketStr, evs] of windows) {
      const errors = evs.filter((e) => e.is_error === 1 && !QUOTA_RE.test(e.stop_reason ?? ''));
      const quota = evs.filter((e) => e.is_error === 1 && QUOTA_RE.test(e.stop_reason ?? ''));
      if (errors.length < MIN_ERRORS) continue;
      const ratio = errors.length / evs.length;
      if (ratio <= RATIO_THRESHOLD) continue;

      const first = evs[0];
      if (!first) continue;
      const bucket = Number(bucketStr);
      const [tool] = key.split('::');

      out.push({
        anomaly_key: `error_storm:${tool}:${first.session_id ?? 'none'}:${bucket}`,
        rule: 'error_storm',
        severity: ratio >= 0.5 ? 'critical' : 'warn',
        tool: first.tool,
        session_id: first.session_id,
        model: first.model,
        window_start: bucket,
        window_end: bucket + WINDOW_MS,
        title: `API error storm in ${first.tool} session ${shortId(first.session_id)}`,
        detail:
          `${errors.length} of ${evs.length} calls failed in 15 min ` +
          `(${(ratio * 100).toFixed(0)}% error rate) — assistant-level API failures only, activity_only rows excluded.` +
          (quota.length
            ? ` ${quota.length} quota-shaped failure(s) in the same window were split out of the ratio: quota exhaustion is not breakage and belongs on the quota surface.`
            : '') +
          ` Sustained failure ratios usually mean the agent is retrying against a broken tool or an exhausted quota.`,
        observed: ratio,
        baseline: RATIO_THRESHOLD,
        threshold: RATIO_THRESHOLD,
        confidence: worstConfidence(evs),
        source: first.source,
        detected_at: now,
      });
    }
  }
  return out;
}
