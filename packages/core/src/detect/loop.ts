import type { Anomaly, UsageEvent } from '../types';
import { bucketOf, groupBy, medianExcluding, withTokens, worstConfidence, fmt, shortId } from './util';

const WINDOW_MS = 5 * 60 * 1000;
const MIN_CALLS = 15;
const RATE_MULTIPLE = 3;
/** Output this small, repeatedly, means the agent is reacting rather than producing. */
const FLAT_OUTPUT_TOKENS = 400;

/**
 * Runaway-loop detection.
 *
 * Call frequency alone is a poor signal — a productive burst also looks fast. The
 * distinguishing signature of a stuck agent is high call volume where output stays flat
 * while cache reads climb: it keeps re-reading the same context and producing almost
 * nothing. Requiring both conditions is what separates "busy" from "spinning".
 */
export function detectLoops(events: UsageEvent[], now: number): Anomaly[] {
  const out: Anomaly[] = [];
  const usable = withTokens(events).filter((e) => e.session_id);

  for (const [sessionId, group] of groupBy(usable, (e) => e.session_id as string)) {
    const windows = groupBy(group, (e) => String(bucketOf(e.ts, WINDOW_MS)));
    const entries = [...windows.entries()];
    if (entries.length < 2) continue;
    const counts = entries.map(([, v]) => v.length);

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const [bucketStr, evs] = entry;

      // Baseline excludes this window, so a burst cannot mask itself.
      const baseline = Math.max(1, medianExcluding(counts, i));
      if (evs.length < MIN_CALLS) continue;
      if (evs.length <= baseline * RATE_MULTIPLE) continue;

      const avgOutput = evs.reduce((s, e) => s + (e.output_tokens ?? 0), 0) / evs.length;
      const cacheRead = evs.reduce((s, e) => s + (e.cache_read_tokens ?? 0), 0);
      // The loop signature: lots of calls, almost no new output, heavy context re-reads.
      if (avgOutput > FLAT_OUTPUT_TOKENS) continue;
      if (cacheRead <= 0) continue;

      const first = evs[0];
      if (!first) continue;
      const bucket = Number(bucketStr);
      const multiple = evs.length / baseline;

      out.push({
        anomaly_key: `loop_suspected:${first.tool}:${sessionId}:${bucket}`,
        rule: 'loop_suspected',
        severity: evs.length >= MIN_CALLS * 2 ? 'critical' : 'warn',
        tool: first.tool,
        session_id: sessionId,
        model: first.model,
        window_start: bucket,
        window_end: bucket + WINDOW_MS,
        title: `Possible runaway loop in ${first.tool} session ${shortId(sessionId)}`,
        detail:
          `${evs.length} calls in 5 min (${multiple.toFixed(1)}x this session's normal ` +
          `${baseline.toFixed(0)}) while average output stayed at ${fmt(avgOutput)} tokens ` +
          `and ${fmt(cacheRead)} cached tokens were re-read. The agent appears to be ` +
          `re-processing the same context without making progress.`,
        observed: evs.length,
        baseline,
        threshold: baseline * RATE_MULTIPLE,
        confidence: worstConfidence(evs),
        source: first.source,
        detected_at: now,
      });
    }
  }
  return out;
}
