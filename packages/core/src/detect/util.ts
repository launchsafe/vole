import type { Confidence, UsageEvent } from '../types';

/** Epoch-anchored bucketing, so window boundaries are stable across runs and processes. */
export function bucketOf(ts: number, windowMs: number): number {
  return Math.floor(ts / windowMs) * windowMs;
}

export function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] as number;
  return ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * Token maths must never include `activity_only` rows — those tools record that a call
 * happened but persist no tokens, so counting them as zero would drag every average down.
 */
export function withTokens(events: UsageEvent[]): UsageEvent[] {
  return events.filter((e) => e.confidence !== 'activity_only' && e.total_tokens !== null);
}

/** An anomaly is only as trustworthy as its weakest contributing event. */
export function worstConfidence(events: UsageEvent[]): Confidence {
  return events.some((e) => e.confidence === 'activity_only') ? 'activity_only' : 'exact';
}

export function shortId(id: string | null): string {
  if (!id) return 'unknown';
  return id.slice(0, 8);
}

export function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Median of every value EXCEPT the one at `excludeIndex`.
 *
 * An outlier must not be allowed to inflate the baseline it is measured against. With
 * sparse data (few windows) a single huge window otherwise drags the median up far
 * enough to mask itself — the anomaly hides inside its own baseline.
 */
export function medianExcluding(values: number[], excludeIndex: number): number {
  const rest = values.filter((_, i) => i !== excludeIndex);
  return median(rest);
}
