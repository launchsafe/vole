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
 * Leave-one-out medians for every index, in one O(n log n) pass.
 *
 * The naive form — filter, copy and sort per index — is O(n² log n) overall,
 * which at 20k windows measured ~15.6s per detection pass under 5-second polling.
 * One sort plus a rank map computes each exclusion in O(1): with `p` the sorted
 * position of the excluded value, the j-th element of the remaining sequence is
 * `sorted[j]` before `p` and `sorted[j+1]` at and after it.
 */
export function leaveOneOutMedians(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  const sorted = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const pos = new Array<number>(n);
  for (let p = 0; p < n; p++) pos[sorted[p]![1]] = p;
  const at = (p: number, j: number): number => sorted[j < p ? j : j + 1]![0];

  const out = new Array<number>(n);
  const m = n - 1; // length of the remaining sequence
  for (let i = 0; i < n; i++) {
    const p = pos[i]!;
    if (m === 0) {
      out[i] = 0;
    } else if (m % 2 === 1) {
      out[i] = at(p, (m - 1) / 2);
    } else {
      out[i] = (at(p, m / 2 - 1) + at(p, m / 2)) / 2;
    }
  }
  return out;
}
