import type { Anomaly, RateLimitObservation } from '../types';
import { bucketOf, shortId } from './util';

const WINDOW_MS = 60 * 60 * 1000;
const PRESSURE_THRESHOLD = 80;

/**
 * Rate-limit headroom pressure.
 *
 * Codex is the only tool here that reports its own remaining quota, so this rule has no
 * equivalent for the others. It is exact, free, and predicts an outage before it happens
 * rather than reporting one afterwards.
 */
export function detectRateLimitPressure(
  observations: RateLimitObservation[],
  now: number,
): Anomaly[] {
  const out: Anomaly[] = [];
  const seen = new Set<string>();

  for (const o of observations) {
    if (o.used_percent <= PRESSURE_THRESHOLD) continue;
    const bucket = bucketOf(o.ts, WINDOW_MS);
    const key = `rate_limit_pressure:${o.tool}:${o.session_id ?? 'none'}:${bucket}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      anomaly_key: key,
      rule: 'rate_limit_pressure',
      severity: o.used_percent >= 95 ? 'critical' : 'warn',
      tool: o.tool,
      session_id: o.session_id,
      model: null,
      window_start: bucket,
      window_end: bucket + WINDOW_MS,
      title: `${o.tool} approaching its rate limit`,
      detail:
        `${o.used_percent.toFixed(0)}% of the ${o.window_minutes}-minute quota consumed ` +
        `in session ${shortId(o.session_id)}. Reported by the tool itself, so this is an ` +
        `exact reading rather than an inference.`,
      observed: o.used_percent,
      baseline: null,
      threshold: PRESSURE_THRESHOLD,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }
  return out;
}
