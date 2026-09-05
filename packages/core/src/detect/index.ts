import type { Anomaly, RateLimitObservation, UsageEvent } from '../types';
import { detectBurnRate } from './burn-rate';
import { detectLoops } from './loop';
import { detectErrorStorms } from './error-storm';
import { detectRateLimitPressure } from './rate-limit';
import { detectContextPressure } from './context-pressure';

export { detectBurnRate, detectLoops, detectErrorStorms, detectRateLimitPressure, detectContextPressure };
export { contextOf, windowOf } from './context-pressure';
export * from './util';

/** Runs every rule. Pure: no DB access, so rules stay unit-testable in isolation. */
export function detectAll(
  events: UsageEvent[],
  rateLimits: RateLimitObservation[] = [],
  now: number = Date.now(),
): Anomaly[] {
  return [
    ...detectBurnRate(events, now),
    ...detectLoops(events, now),
    ...detectErrorStorms(events, now),
    ...detectRateLimitPressure(rateLimits, now),
    ...detectContextPressure(events, now),
  ];
}

/**
 * Runs the rules separately per data source.
 *
 * Seed and live rows must never share a baseline: a 30-day synthetic history would
 * otherwise redefine what "normal" means for real usage (and vice versa), so a real
 * spike could be masked by demo data. Keeping the partitions apart is what makes the
 * demo data genuinely removable rather than merely separately stored.
 *
 * The source is also folded into `anomaly_key`, so a live and a seed incident occupying
 * the same time bucket cannot collide on the UNIQUE constraint.
 */
export function detectBySource(
  events: UsageEvent[],
  rateLimitsBySource: Partial<Record<string, RateLimitObservation[]>>,
  now: number = Date.now(),
): Anomaly[] {
  const bySource = new Map<string, UsageEvent[]>();
  for (const e of events) {
    const arr = bySource.get(e.source);
    if (arr) arr.push(e);
    else bySource.set(e.source, [e]);
  }

  const out: Anomaly[] = [];
  for (const [source, evs] of bySource) {
    const rl = rateLimitsBySource[source] ?? [];
    for (const a of detectAll(evs, rl, now)) {
      out.push({
        ...a,
        source: source as Anomaly['source'],
        anomaly_key: `${source}:${a.anomaly_key}`,
      });
    }
  }
  return out;
}
