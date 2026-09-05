import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths';
import type { DB } from '../db';
import { parseLine } from '../util/jsonl';
import { computeCost, contextWindow } from '../pricing';
import type { CollectorResult, UsageEvent } from '../types';

/**
 * Grok CLI (xAI) — exact tokens, cost unknown.
 *
 * ~/.grok/logs/unified.jsonl carries one `shell.turn.inference_done` line per model
 * call, with `ctx.{prompt_tokens, cached_prompt_tokens, completion_tokens,
 * reasoning_tokens}` — the OpenAI-style usage shape. `prompt_tokens` already includes
 * the cached portion and `completion_tokens` already includes reasoning, so:
 *   total   = prompt_tokens + completion_tokens
 *   input   = prompt_tokens - cached_prompt_tokens   (fresh)
 *   read    = cached_prompt_tokens
 *   output  = completion_tokens
 * Model and cwd come from each session's summary.json. No xAI rate is loaded, so cost
 * stays NULL — exact tokens do not imply known cost.
 *
 * The log is small and append-only; it is re-read in full and deduped on
 * `grok:<session>:<timestamp>` (inference_done lines never share a timestamp within a
 * session).
 *
 * `shell.tool.exec_done` lines name each tool the previous call asked for, so they are
 * attached to that call. `shell.turn.inference_failed` is a model call that returned an
 * error (quota, 4xx, timeout): it carries no usage, so it is stored as an
 * `activity_only` row with `is_error = 1` — the call happened, nothing was measured.
 */

interface Ctx {
  prompt_tokens?: number;
  cached_prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  tool_name?: string;
  status_code?: number;
}
interface Line {
  ts?: string;
  sid?: string;
  msg?: string;
  ctx?: Ctx;
}

function sessionMeta(): Map<string, { cwd: string | null; model: string | null }> {
  const map = new Map<string, { cwd: string | null; model: string | null }>();
  const root = paths.grokSessionsDir();
  if (!existsSync(root)) return map;
  for (const encCwd of readdirSync(root)) {
    const dir = join(root, encCwd);
    let sids: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      sids = readdirSync(dir);
    } catch {
      continue;
    }
    for (const sid of sids) {
      const summary = join(dir, sid, 'summary.json');
      if (!existsSync(summary)) continue;
      try {
        const s = JSON.parse(readFileSync(summary, 'utf8'));
        map.set(sid, { cwd: s.info?.cwd ?? null, model: s.current_model_id ?? null });
      } catch {
        /* ignore a malformed summary */
      }
    }
  }
  return map;
}

export function collectGrok(_db: DB): CollectorResult {
  const logPath = paths.grokUnifiedLog();
  const events: UsageEvent[] = [];
  const notes: string[] = [];

  if (!existsSync(logPath)) {
    return { tool: 'grok', events, filesScanned: 0, notes: [`No Grok log at ${logPath}`] };
  }

  const meta = sessionMeta();
  let lines: string[];
  try {
    lines = readFileSync(logPath, 'utf8').split('\n');
  } catch (err) {
    return { tool: 'grok', events, filesScanned: 0, notes: [`Could not read ${logPath}: ${(err as Error).message}`] };
  }

  // The latest call per session, so tool executions can be attributed to it.
  const lastCall = new Map<string, UsageEvent>();
  const failNull = {
    input_tokens: null, output_tokens: null, cache_write_5m_tokens: null,
    cache_write_1h_tokens: null, cache_read_tokens: null, reasoning_tokens: null,
    total_tokens: null, cost_usd: null,
  };

  for (const raw of lines) {
    const e = parseLine<Line>(raw);
    if (!e || !e.ctx || !e.sid || !e.ts) continue;

    if (e.msg === 'shell.tool.exec_done' && e.ctx.tool_name) {
      const prev = lastCall.get(e.sid);
      if (prev) prev.tools = prev.tools ? `${prev.tools},${e.ctx.tool_name}` : e.ctx.tool_name;
      continue;
    }
    if (e.msg === 'shell.turn.inference_failed') {
      const m = meta.get(e.sid);
      events.push({
        event_key: `grok:${e.sid}:${e.ts}:failed`,
        tool: 'grok',
        model: m?.model ?? null,
        session_id: e.sid,
        project: m?.cwd ?? null,
        git_branch: null,
        ts: Date.parse(e.ts),
        ...failNull,
        confidence: 'activity_only',
        is_error: 1,
        stop_reason: e.ctx.status_code ? `error:${e.ctx.status_code}` : 'error',
        source: 'live',
        raw_ref: `${logPath} (${e.sid})`,
        tools: null,
        agent_id: null,
        context_window: null,
      });
      continue;
    }
    if (e.msg !== 'shell.turn.inference_done') continue;

    const c = e.ctx;
    const prompt = c.prompt_tokens ?? 0;
    const cached = c.cached_prompt_tokens ?? 0;
    const output = c.completion_tokens ?? 0;
    if (prompt === 0 && output === 0) continue;

    const freshInput = Math.max(0, prompt - cached);
    const m = meta.get(e.sid);
    const model = m?.model ?? null;

    const tokens = {
      input_tokens: freshInput,
      output_tokens: output,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: 0,
      cache_read_tokens: cached,
    };

    const ev: UsageEvent = {
      event_key: `grok:${e.sid}:${e.ts}`,
      tool: 'grok',
      model,
      session_id: e.sid,
      project: m?.cwd ?? null,
      git_branch: null,
      ts: Date.parse(e.ts),
      ...tokens,
      // reasoning is already inside completion_tokens; stored for info, not re-added.
      reasoning_tokens: c.reasoning_tokens ?? 0,
      total_tokens: prompt + output,
      cost_usd: computeCost(model, tokens), // NULL — no xAI rate loaded
      confidence: 'exact',
      is_error: 0,
      stop_reason: null,
      source: 'live',
      raw_ref: `${logPath} (${e.sid})`,
      tools: null,
      agent_id: null,
      context_window: contextWindow(model),
    };
    events.push(ev);
    lastCall.set(e.sid, ev);
  }

  return { tool: 'grok', events, filesScanned: 1, notes };
}
