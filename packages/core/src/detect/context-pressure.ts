import type { Anomaly, UsageEvent } from '../types';
import { contextWindow } from '../pricing';
import { bucketOf, fmt, groupBy, shortId, withTokens } from './util';

const WINDOW_MS = 60 * 60 * 1000;
const WARN_RATIO = 0.8;
const CRITICAL_RATIO = 0.95;

/** The context a call carried: fresh input plus everything served from or written to cache. */
export function contextOf(e: UsageEvent): number {
  return (
    (e.input_tokens ?? 0) +
    (e.cache_read_tokens ?? 0) +
    (e.cache_write_5m_tokens ?? 0) +
    (e.cache_write_1h_tokens ?? 0)
  );
}

/** The window the call ran against: the tool's own figure first, else the published one. */
export function windowOf(e: Pick<UsageEvent, 'model' | 'context_window'>): number | null {
  return e.context_window ?? contextWindow(e.model);
}

/**
 * Context-window pressure.
 *
 * Every exact row records the context it carried, and the window is either reported by
 * the tool (Codex) or published for the model. Once a session's context passes 80% of
 * its window, compaction or a hard failure is close — this fires before that happens,
 * once per session per hour, on the largest call in that hour. Sessions on a model
 * with no known window are skipped rather than guessed.
 */
export function detectContextPressure(events: UsageEvent[], now: number): Anomaly[] {
  const out: Anomaly[] = [];
  const usable = withTokens(events).filter((e) => e.session_id);

  for (const [sessionId, group] of groupBy(usable, (e) => e.session_id as string)) {
    for (const [bucketStr, evs] of groupBy(group, (e) => String(bucketOf(e.ts, WINDOW_MS)))) {
      let worst: { e: UsageEvent; ctx: number; win: number; ratio: number } | null = null;
      for (const e of evs) {
        const win = windowOf(e);
        if (!win) continue;
        const ctx = contextOf(e);
        const ratio = ctx / win;
        if (ratio < WARN_RATIO) continue;
        if (!worst || ratio > worst.ratio) worst = { e, ctx, win, ratio };
      }
      if (!worst) continue;

      const bucket = Number(bucketStr);
      const { e, ctx, win, ratio } = worst;
      out.push({
        anomaly_key: `context_pressure:${e.tool}:${sessionId}:${bucket}`,
        rule: 'context_pressure',
        severity: ratio >= CRITICAL_RATIO ? 'critical' : 'warn',
        tool: e.tool,
        session_id: sessionId,
        model: e.model,
        window_start: bucket,
        window_end: bucket + WINDOW_MS,
        title: `Context at ${Math.round(ratio * 100)}% of window in ${e.tool} session ${shortId(sessionId)}`,
        detail:
          `A call carried ${fmt(ctx)} tokens of context against a ${fmt(win)}-token window ` +
          `(${e.model ?? 'unknown model'}). Compaction or a hard limit is close: start a fresh ` +
          `session, or clear old tool output, before the agent loses the thread.`,
        observed: ratio,
        baseline: null,
        threshold: WARN_RATIO,
        confidence: 'exact',
        source: e.source,
        detected_at: now,
      });
    }
  }
  return out;
}
