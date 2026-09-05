import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths';
import type { DB } from '../db';
import { parseLine } from '../util/jsonl';
import { computeCost } from '../pricing';
import type { CollectorResult, RateLimitObservation, UsageEvent } from '../types';

/**
 * Codex CLI — exact tokens, but structured differently than Claude Code.
 *
 * Rollouts live at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Each `token_count`
 * event carries BOTH a cumulative `total_token_usage` (the meter) and a per-turn
 * `last_token_usage` (the breakdown of what the current turn consumed).
 *
 * The METER is authoritative. Consumption per event is the delta of the cumulative
 * total: summing `total_token_usage` would double-count catastrophically, and a
 * duplicate emission (Codex sometimes writes the same token_count event twice at
 * session start) advances the meter by zero and is skipped.
 *
 * The BREAKDOWN is best-effort attribution, and not every Codex version fills it:
 * older rollouts emit all-zero component fields with a non-zero meter total. Those
 * tokens are real but unattributable, so the component columns are stored NULL —
 * never 0, which would both understate the session and fabricate a cache split —
 * and cost stays NULL, since pricing needs the input/output split. The exact meter
 * delta is always kept in `total_tokens`.
 *
 * Rollouts are few and small, so each file is re-read in full rather than tracked by
 * offset: deltas must be computed from a known starting point, and `event_key` +
 * INSERT OR IGNORE already make re-reads free.
 */

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface CodexLine {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    id?: string;
    model?: string;
    cwd?: string;
    /** response_item function_call / custom_tool_call / local_shell_call */
    name?: string;
    info?: {
      total_token_usage?: TokenUsage;
      last_token_usage?: TokenUsage;
      model_context_window?: number;
    };
    rate_limits?: {
      primary?: { used_percent?: number; window_minutes?: number };
    };
  };
}

const TOOL_ITEMS = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);

function walkRollouts(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkRollouts(p, out);
    else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push(p);
  }
}

export function collectCodex(_db: DB): CollectorResult {
  const root = paths.codexSessions();
  const events: UsageEvent[] = [];
  const rateLimits: RateLimitObservation[] = [];
  const notes: string[] = [];

  if (!existsSync(root)) {
    return { tool: 'codex', events, filesScanned: 0, notes: [`No directory at ${root}`] };
  }

  const files: string[] = [];
  walkRollouts(root, files);

  for (const filePath of files) {
    let lines: string[];
    try {
      lines = readFileSync(filePath, 'utf8').split('\n').filter((l) => l.length > 0);
    } catch (err) {
      notes.push(`Could not read ${filePath}: ${(err as Error).message}`);
      continue;
    }

    let sessionId: string | null = null;
    let model: string | null = null;
    let project: string | null = null;
    let prevTotal = 0;
    // Tool calls the model issued since the previous token_count; attributed to the
    // next one, which is the meter reading that covers them.
    let pendingTools: string[] = [];

    lines.forEach((line, index) => {
      const entry = parseLine<CodexLine>(line);
      if (!entry) return;

      if (entry.type === 'session_meta') {
        sessionId = entry.payload?.id ?? null;
        project = entry.payload?.cwd ?? project;
        return;
      }
      // session_meta.model is null in real logs; the live model lives on turn_context,
      // as does the cwd (it can change mid-session).
      if (entry.type === 'turn_context') {
        model = entry.payload?.model ?? model;
        project = entry.payload?.cwd ?? project;
        return;
      }
      if (entry.type === 'response_item' && TOOL_ITEMS.has(entry.payload?.type ?? '')) {
        pendingTools.push(entry.payload?.name ?? entry.payload?.type ?? 'tool');
        return;
      }
      if (entry.payload?.type !== 'token_count') return;

      const ts = entry.timestamp ? Date.parse(entry.timestamp) : Date.now();

      const rl = entry.payload.rate_limits?.primary;
      if (rl?.used_percent !== undefined) {
        rateLimits.push({
          tool: 'codex',
          session_id: sessionId,
          ts,
          used_percent: rl.used_percent,
          window_minutes: rl.window_minutes ?? 0,
        });
      }

      const info = entry.payload.info;
      const total = info?.total_token_usage;
      const last = info?.last_token_usage;
      if (!total && !last) return;
      const tools = pendingTools.length ? pendingTools.join(',') : null;
      pendingTools = [];

      // Meter delta: what this event consumed, per Codex's own running total.
      let delta: number;
      let usage: TokenUsage;

      if (total) {
        const runningTotal = total.total_tokens ?? 0;
        if (runningTotal > prevTotal) {
          // Normal path: consume only what is new since the previous token_count.
          delta = runningTotal - prevTotal;
          // The per-turn figure is trustworthy only when it bridges the meter exactly;
          // otherwise fall back to whichever figure we have.
          usage =
            last && (last.total_tokens ?? 0) + prevTotal === runningTotal ? last : (last ?? total);
          prevTotal = runningTotal;
        } else if (runningTotal < prevTotal) {
          // Counter reset (new turn context): the whole meter is new-segment consumption.
          delta = runningTotal;
          usage = last ?? total;
          prevTotal = runningTotal;
        } else {
          // No new tokens — a duplicate emission. Skip rather than count it again.
          return;
        }
      } else {
        // No cumulative meter in this event: trust the per-turn figure as-is.
        usage = last!;
        delta = usage.total_tokens ?? 0;
        if (delta <= 0) return;
      }

      const input = usage.input_tokens ?? 0;
      const cached = usage.cached_input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;
      // Codex reports cached input inside input_tokens; separate them so cache maths holds.
      const freshInput = Math.max(0, input - cached);
      const attributed = freshInput + cached + output;

      // attributed === 0 with delta > 0 means the version never split the meter
      // (all-zero breakdown). The tokens are exact, the components are unknown.
      const breakdownKnown = attributed > 0;
      // Cost needs the full input/output split; a partial breakdown leaves part of the
      // meter unattributable, so the cost is unknown even though the total is exact.
      const costKnown = breakdownKnown && attributed === delta;

      const tokens = {
        input_tokens: freshInput,
        output_tokens: output,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        cache_read_tokens: cached,
      };

      events.push({
        event_key: `codex:${sessionId ?? filePath}:${index}`,
        tool: 'codex',
        model,
        session_id: sessionId,
        project,
        git_branch: null,
        ts,
        // Codex has no cache-write concept: 0 here is structural, not a measurement.
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        input_tokens: breakdownKnown ? freshInput : null,
        output_tokens: breakdownKnown ? output : null,
        cache_read_tokens: breakdownKnown ? cached : null,
        reasoning_tokens: breakdownKnown ? (usage.reasoning_output_tokens ?? 0) : null,
        total_tokens: delta,
        cost_usd: costKnown ? computeCost(model, tokens) : null,
        confidence: 'exact',
        is_error: 0,
        stop_reason: null,
        source: 'live',
        raw_ref: `${filePath}#${index}`,
        tools,
        agent_id: null,
        // Codex states its own window on every meter event — exact, no lookup needed.
        context_window: info?.model_context_window ?? null,
      });
    });
  }

  return { tool: 'codex', events, filesScanned: files.length, notes, rateLimits };
}
