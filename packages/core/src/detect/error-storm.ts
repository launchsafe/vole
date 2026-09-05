import type { Anomaly, UsageEvent } from '../types';
import { bucketOf, groupBy, worstConfidence, shortId } from './util';

const WINDOW_MS = 15 * 60 * 1000;
const MIN_ERRORS = 5;
const RATIO_THRESHOLD = 0.2;

/**
 * Retry / failure ratio spike.
 *
 * Requires both an absolute error count and a ratio: 3 errors out of 4 calls is a quiet
 * session, not an incident, while 5 errors out of 200 calls is noise. Both must trip.
 */
export function detectErrorStorms(events: UsageEvent[], now: number): Anomaly[] {
  const out: Anomaly[] = [];

  for (const [key, group] of groupBy(events, (e) => `${e.tool}::${e.session_id ?? 'none'}`)) {
    const windows = groupBy(group, (e) => String(bucketOf(e.ts, WINDOW_MS)));

    for (const [bucketStr, evs] of windows) {
      const errors = evs.filter((e) => e.is_error === 1);
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
        title: `Retry storm in ${first.tool} session ${shortId(first.session_id)}`,
        detail:
          `${errors.length} of ${evs.length} calls failed in 15 min ` +
          `(${(ratio * 100).toFixed(0)}% error rate). Sustained failure ratios usually ` +
          `mean the agent is retrying against a broken tool or an exhausted quota.`,
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
