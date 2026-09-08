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
/** N identical (name, args) calls in a 5-minute window is a loop, whatever the rate. */
const IDENTICAL_REPEATS = 5;
/** An A-B-A-B cycle needs at least 4 alternating calls to be a cycle. */
const ABAB_MIN = 4;

/** The ledger-call shape the signatures need (CallLite and PairCall satisfy it structurally). */
export interface LoopCall {
  id: number;
  tool: string;
  name: string;
  args_digest: string | null;
  session?: string | null;
  agent?: string | null;
  ts: number;
}

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

/**
 * The ledger signatures (tier 5 #19's other two legs), over tool_calls:
 *
 *  - identical: N calls with the same (name, args_digest) inside a 5-minute run —
 *    the agent re-issuing the exact call because nothing changes between tries;
 *  - A-B-A-B: the same two (name, args_digest) pairs alternating — the classic
 *    edit/test/verify thrash where neither side converges.
 *
 * A genuine loop with a varying argument (an incrementing offset, a new file each
 * turn) hashes differently every call and is reachable only by the absolute-rate
 * path, which needs per-call output tokens and so covers only tools with exact
 * usage — that gap is stated, not hidden.
 */
export function detectLedgerRepeatLoops(calls: LoopCall[], now: number): Anomaly[] {
  const out: Anomaly[] = [];
  const groups = groupBy(
    calls.filter((c) => c.session !== null && c.args_digest !== null),
    (c) => `${c.session}::${c.agent ?? 'main'}`,
  );

  for (const [key, group] of groups) {
    const [sessionId = 'none', agentId = 'main'] = key.split('::');
    const sorted = [...group].sort((a, b) => a.id - b.id);

    // identical runs: collapse consecutive same-digest calls with <5min gaps.
    let run: LoopCall[] = [];
    const flushIdentical = () => {
      if (run.length < IDENTICAL_REPEATS) {
        run = [];
        return;
      }
      const first = run[0]!;
      out.push({
        anomaly_key: `repeat_call_loop:ident:${first.tool}:${sessionId}:${agentId}:${first.args_digest}:${Math.floor(first.ts / WINDOW_MS)}`,
        rule: 'repeat_call_loop',
        severity: run.length >= IDENTICAL_REPEATS * 2 ? 'warn' : 'info',
        tool: first.tool as Anomaly['tool'],
        session_id: sessionId,
        model: null,
        window_start: first.ts,
        window_end: run[run.length - 1]!.ts,
        title: `Identical repeat: ${first.name} x${run.length}`,
        detail:
          `${run.length} calls with the identical (name, arguments digest) inside a 5-minute window — the agent re-issued the exact call ` +
          `${run.length} times${agentId !== 'main' ? ` (subagent ${shortId(agentId)})` : ''}. The repeated call skeleton is its shape; the arguments are a digest, never content.`,
        observed: run.length,
        baseline: null,
        threshold: IDENTICAL_REPEATS,
        confidence: 'exact',
        source: 'live',
        detected_at: now,
      });
      run = [];
    };
    for (const c of sorted) {
      if (run.length && (run[run.length - 1]!.args_digest !== c.args_digest || c.ts - run[run.length - 1]!.ts > WINDOW_MS)) flushIdentical();
      run.push(c);
    }
    flushIdentical();

    // A-B-A-B cycles over the ordered digest sequence.
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (
        j + 2 < sorted.length &&
        sorted[j]!.args_digest === sorted[j + 2]!.args_digest &&
        sorted[j + 1]!.args_digest !== sorted[j]!.args_digest &&
        sorted[j + 1]!.args_digest === (sorted[j + 3]?.args_digest ?? null) &&
        sorted[j + 3]!.ts - sorted[j]!.ts <= WINDOW_MS
      ) {
        j++;
      }
      const len = j - i + 3; // calls i..j+2 form the alternating run
      if (len >= ABAB_MIN) {
        const a = sorted[i]!;
        const b = sorted[i + 1]!;
        out.push({
          anomaly_key: `repeat_call_loop:abab:${a.tool}:${sessionId}:${agentId}:${a.args_digest}:${b.args_digest}:${Math.floor(a.ts / WINDOW_MS)}`,
          rule: 'repeat_call_loop',
          severity: 'warn',
          tool: a.tool as Anomaly['tool'],
          session_id: sessionId,
          model: null,
          window_start: a.ts,
          window_end: sorted[j + 2]!.ts,
          title: `A-B-A-B cycle: ${a.name} / ${b.name} x${Math.floor(len / 2)}`,
          detail:
            `The same two calls alternated ${Math.floor(len / 2)} times within 5 minutes (${a.name} and ${b.name}, stable argument digests) — ` +
            `an edit/verify thrash where neither side converges${agentId !== 'main' ? `, subagent ${shortId(agentId)}` : ''}.`,
          observed: len,
          baseline: null,
          threshold: ABAB_MIN,
          confidence: 'exact',
          source: 'live',
          detected_at: now,
        });
        i = j + 3;
      } else i++;
    }
  }
  return out;
}
