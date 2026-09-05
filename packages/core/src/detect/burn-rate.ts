import type { Anomaly, UsageEvent } from '../types';
import { bucketOf, groupBy, medianExcluding, withTokens, worstConfidence, fmt, shortId } from './util';

const WINDOW_MS = 10 * 60 * 1000;
/** Below this a "spike" is just noise — a single large prompt should not page anyone. */
const MIN_TOKENS_IN_WINDOW = 20_000;
const SPIKE_MULTIPLE = 3;

/**
 * Token-burn rate spike.
 *
 * Compares each 10-minute window's tokens/min against the median window for that same
 * tool+model, so a model that is simply expensive does not permanently look anomalous —
 * only a departure from its OWN normal does.
 *
 * Windows are scanned across the whole timeline rather than only the trailing window, so
 * historical logs still produce an incident feed.
 */
export function detectBurnRate(events: UsageEvent[], now: number): Anomaly[] {
  const out: Anomaly[] = [];
  const usable = withTokens(events);

  for (const [key, group] of groupBy(usable, (e) => `${e.tool}::${e.model ?? 'unknown'}`)) {
    const windows = groupBy(group, (e) => String(bucketOf(e.ts, WINDOW_MS)));
    if (windows.size < 3) continue; // too little history to have a "normal"

    const rates = new Map<number, { tokens: number; events: UsageEvent[] }>();
    for (const [bucketStr, evs] of windows) {
      const tokens = evs.reduce((s, e) => s + (e.total_tokens ?? 0), 0);
      rates.set(Number(bucketStr), { tokens, events: evs });
    }

    const entries = [...rates.entries()];
    const allTokens = entries.map(([, r]) => r.tokens);

    const [tool, model] = key.split('::');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const [bucket, r] = entry;

      // Baseline excludes this window, so a spike cannot mask itself.
      const baseline = medianExcluding(allTokens, i);
      if (baseline <= 0) continue;
      if (r.tokens < MIN_TOKENS_IN_WINDOW) continue;
      if (r.tokens <= baseline * SPIKE_MULTIPLE) continue;

      const multiple = r.tokens / baseline;
      const perMin = r.tokens / (WINDOW_MS / 60000);
      const first = r.events[0];
      if (!first) continue;

      out.push({
        anomaly_key: `burn_rate_spike:${tool}:${model}:${bucket}`,
        rule: 'burn_rate_spike',
        severity: multiple >= 6 ? 'critical' : 'warn',
        tool: first.tool,
        session_id: first.session_id,
        model: model === 'unknown' ? null : (model ?? null),
        window_start: bucket,
        window_end: bucket + WINDOW_MS,
        title: `Token burn spike on ${first.tool} (${model})`,
        detail:
          `Burned ${fmt(r.tokens)} tokens in 10 min (${fmt(perMin)}/min) across ` +
          `${r.events.length} calls — ${multiple.toFixed(1)}x this model's typical ` +
          `${fmt(baseline)}-token window. Session ${shortId(first.session_id)}.`,
        observed: r.tokens,
        baseline,
        threshold: baseline * SPIKE_MULTIPLE,
        confidence: worstConfidence(r.events),
        source: first.source,
        detected_at: now,
      });
    }
  }
  return out;
}
