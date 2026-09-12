import type { Anomaly, UsageEvent } from '../types';
import { bucketOf, groupBy, withTokens, worstConfidence, fmt, shortId } from './util';

const WINDOW_MS = 5 * 60 * 1000;
/**
 * Absolute call rate: this many calls in one 5-minute window is spinning, no matter
 * what the session's own history looks like. The old relative rule compared a window
 * against the session's leave-one-out median, so a session that loops at a constant
 * rate from its first turn — a CI `claude -p`, a bash retry loop — was its own
 * baseline and never fired.
 */
const ABS_CALLS_PER_WINDOW = 45;
/** Output this small, repeatedly, means the agent is reacting rather than producing. */
const FLAT_OUTPUT_TOKENS = 400;
/**
 * Runaway-loop detection, absolute-rate path.
 *
 * A window fires when it holds at least ABS_CALLS_PER_WINDOW calls while average
 * output stays flat — high volume with real output is a productive burst, not a
 * spin. There is deliberately no baseline: the signature is the absolute rate, so a
 * loop that starts with the session is caught from its first window.
 *
 * The group is (session_id, agent_id), so ten parallel read-only subagents sharing
 * the parent's session_id no longer read as one spinning agent.
 */
export function detectRepeatLoops(events: UsageEvent[], now: number): Anomaly[] {
  const out: Anomaly[] = [];
  const usable = withTokens(events).filter((e) => e.session_id);

  for (const [key, group] of groupBy(usable, (e) => `${e.session_id}::${e.agent_id ?? 'main'}`)) {
    const [sessionId = '', agentId = 'main'] = key.split('::');

    for (const [bucketStr, evs] of groupBy(group, (e) => String(bucketOf(e.ts, WINDOW_MS)))) {
      if (evs.length < ABS_CALLS_PER_WINDOW) continue;

      const avgOutput = evs.reduce((s, e) => s + (e.output_tokens ?? 0), 0) / evs.length;
      // The loop signature: many calls, almost no new output.
      if (avgOutput > FLAT_OUTPUT_TOKENS) continue;

      const first = evs[0];
      if (!first) continue;
      const bucket = Number(bucketStr);

      out.push({
        anomaly_key: `repeat_call_loop:${first.tool}:${sessionId}:${agentId}:${bucket}`,
        rule: 'repeat_call_loop',
        severity: evs.length >= ABS_CALLS_PER_WINDOW * 2 ? 'critical' : 'warn',
        tool: first.tool,
        session_id: sessionId,
        model: first.model,
        window_start: bucket,
        window_end: bucket + WINDOW_MS,
        title: `Runaway loop in ${first.tool} session ${shortId(sessionId)}`,
        detail:
          `${evs.length} calls in 5 min while average output stayed at ${fmt(avgOutput)} tokens. ` +
          `The threshold is absolute (${ABS_CALLS_PER_WINDOW} calls / 5 min), so a session spinning ` +
          `at a constant rate from its first turn is caught. ` +
          (agentId !== 'main' ? `Subagent ${shortId(agentId)}. ` : '') +
          'The agent appears to be re-processing the same context without making progress.',
        observed: evs.length,
        baseline: null,
        threshold: ABS_CALLS_PER_WINDOW,
        confidence: worstConfidence(evs),
        source: first.source,
        detected_at: now,
      });
    }
  }
  return out;
}
