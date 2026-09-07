import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths';
import { getState, setState, type DB } from '../db';
import { readNewLines, parseLine } from '../util/jsonl';
import { computeCost, contextWindow } from '../pricing';
import type { CollectorResult, UsageEvent } from '../types';
import { skeletonize, argsDigest, type ToolCallRow } from '../toolcalls/bind';

/**
 * Claude Code — exact, rich and live: per-message tokens, cache split and model.
 *
 * CRITICAL: Claude Code writes the same API response to the transcript more than once
 * (observed ~2.4x on real logs). Keying on `message.id` collapses that, but the copies
 * are NOT identical: the first is written mid-stream with `output_tokens: 0` and no
 * `stop_reason`, then rewritten complete. So this pass coalesces every occurrence it
 * sees down to the fullest one, and `insertEvents` upgrades any already-stored
 * placeholder from an earlier pass when a later copy carries more tokens.
 *
 * Transcripts nest: the main session is `<project>/<session>.jsonl`, and every subagent
 * (Agent tool, workflows) writes its own `<project>/<session>/subagents/…/agent-*.jsonl`
 * with the parent's `sessionId`. Those calls are real spend, so the walk is recursive.
 */

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  output_tokens_details?: { thinking_tokens?: number };
}

interface ClaudeEntry {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  /** Set on subagent transcripts; the main thread has none. */
  agentId?: string | null;
  cwd?: string;
  gitBranch?: string;
  isApiErrorMessage?: boolean;
  message?: {
    id?: string;
    model?: string;
    stop_reason?: string | null;
    usage?: ClaudeUsage;
    content?: { type?: string; name?: string; id?: string; input?: unknown }[] | string;
  };
}

/** User-message entries carry tool_result blocks — phase 2 of the ledger bind. */
interface ClaudeUserEntry {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  agentId?: string | null;
  message?: {
    content?: { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[] | string;
  };
}

export function collectClaudeCode(db: DB): CollectorResult {
  const root = paths.claudeCodeProjects();
  const events: UsageEvent[] = [];
  const notes: string[] = [];
  let filesScanned = 0;

  // Claude Code writes each message to the transcript several times while streaming;
  // the first copy is a placeholder with output_tokens: 0. Coalesce every occurrence
  // seen this pass down to the fullest one before emitting, and the upsert in
  // insertEvents upgrades any already-stored placeholder from an earlier pass.
  //
  // The copies are per-content-block: the same message.id is written once per block
  // with identical usage, so the tool_use names are spread across sibling copies.
  // Keeping one copy drops every other copy's names (the live store had tools NULL
  // on half the tool_use turns before this), so the names are unioned across all
  // copies of an id, in first-appearance order, and stamped on whichever copy wins.
  const best = new Map<string, UsageEvent>();
  const toolUnion = new Map<string, string[]>();
  const keep = (id: string, ev: UsageEvent) => {
    if (ev.tools) {
      const u = toolUnion.get(id);
      if (!u) toolUnion.set(id, ev.tools.split(','));
      else for (const t of ev.tools.split(',')) if (!u.includes(t)) u.push(t);
    }
    const prev = best.get(id);
    const evTok = ev.total_tokens ?? 0;
    const prevTok = prev?.total_tokens ?? 0;
    if (!prev || evTok > prevTok || (evTok === prevTok && ev.stop_reason && !prev.stop_reason)) {
      best.set(id, ev);
    }
  };

  if (!existsSync(root)) {
    return { tool: 'claude_code', events, filesScanned, notes: [`No directory at ${root}`], sourceState: 'no_source' };;
  }

  const pending: [string, number, number][] = [];
  const calls: ToolCallRow[] = [];
  for (const filePath of walkTranscripts(root)) {
    filesScanned++;

    const state = getState(db, filePath);
    let result;
    try {
      result = readNewLines(filePath, state?.last_offset ?? 0);
    } catch (err) {
      notes.push(`Could not read ${filePath}: ${(err as Error).message}`);
      continue;
    }

    // Turn-scoped duration estimation: the gap from the last line that was NOT
    // part of this message (a user turn, a tool result) to this assistant message
    // approximates the generation span — including queue time and the permission
    // prompt, so the derived speed is a LOWER bound, and the row says so via
    // duration_kind = 'turn_scoped'. Same-id streaming copies never reset the
    // clock; a new turn does.
    let turnStartTs: number | null = null;
    let lastMsgId: string | null = null;
    for (const line of result.lines) {
      const entry = parseLine<ClaudeEntry>(line);
      if (!entry) continue;
      const ts = entry.timestamp ? Date.parse(entry.timestamp) : null;

      // ── The tool-call ledger, phase 1 (the call) ──
      if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
        for (const block of entry.message!.content as { type?: string; id?: string; name?: string; input?: unknown }[]) {
          if (block?.type === 'tool_use' && block.id && block.name) {
            calls.push({
              tool_call_key: `claude_code:${block.id}`,
              tool: 'claude_code',
              name: block.name,
              shape: skeletonize(block.name, block.input),
              args_digest: argsDigest(block.input),
              session_id: entry.sessionId ?? null,
              agent_id: entry.agentId ?? null,
              ts: ts ?? Date.now(),
              raw_ref: filePath,
            });
          }
        }
      }
      // ── phase 2 (the result) ──
      if (entry.type === 'user' && Array.isArray((entry as unknown as ClaudeUserEntry).message?.content)) {
        for (const block of (entry as unknown as ClaudeUserEntry).message!.content as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) {
          if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
          const text = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c) => (typeof c === 'object' && c && 'text' in c ? String((c as { text?: string }).text ?? '') : '')).join(' ')
              : '';
          const denied = /user doesn't want|permission denied|didn't allow|rejected the tool/i.test(text);
          calls.push({
            tool_call_key: `claude_code:${block.tool_use_id}`,
            tool: 'claude_code',
            name: '',           // widened from the phase-1 row by the bind
            shape: null,
            session_id: entry.sessionId ?? null,
            agent_id: entry.agentId ?? null,
            ts: ts ?? Date.now(),
            status: denied ? 'denied' : block.is_error ? 'error' : 'success',
            status_source: 'result_flag',
            authority: denied ? 'denied' : null,
            raw_ref: filePath,
          });
        }
      }

      if (entry.type === 'assistant' && entry.message?.id && entry.message?.usage) {
        const messageId = entry.message.id;
        // Every copy coalesces (the fullest wins, per the upsert contract); the
        // duration is measured from the turn start, which same-id streaming
        // copies never reset — so the completed copy carries the full gap.
        const duration =
          ts !== null && turnStartTs !== null && ts > turnStartTs && ts - turnStartTs < 600_000
            ? ts - turnStartTs
            : null;
        keep(messageId, toEvent(entry, entry.message.usage, messageId, filePath, duration));
        lastMsgId = messageId;
      } else if (ts !== null) {
        turnStartTs = ts;   // a new turn began; the clock restarts here
        lastMsgId = null;
      }
    }

    pending.push([filePath, result.newOffset, result.mtimeMs]);
  }

  for (const [id, ev] of best) {
    const union = toolUnion.get(id);
    if (union?.length) ev.tools = union.join(',');
    events.push(ev);
  }
  return {
    tool: 'claude_code',
    events,
    filesScanned,
    notes,
    toolCalls: calls,
    commit: () => {
      for (const [p, off, mtime] of pending) setState(db, p, 'claude_code', off, mtime);
    },
  };
}

/** Every `*.jsonl` under the projects root, at any depth. */
export function walkTranscripts(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // vanished mid-scan, or unreadable — skip, do not abort the pass
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTranscripts(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function toEvent(
  entry: ClaudeEntry,
  usage: ClaudeUsage,
  messageId: string,
  filePath: string,
  durationMs: number | null,
): UsageEvent {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;

  // Newer entries split cache creation by TTL, which lets us price it exactly. Older
  // entries only give a total; the 5-minute TTL is the default, so attribute it there.
  const split = usage.cache_creation;
  const w5m = split?.ephemeral_5m_input_tokens ?? (split ? 0 : (usage.cache_creation_input_tokens ?? 0));
  const w1h = split?.ephemeral_1h_input_tokens ?? 0;

  const model = entry.message?.model ?? null;
  const content = entry.message?.content;
  const tools = Array.isArray(content)
    ? content.filter((c) => c.type === 'tool_use' && c.name).map((c) => c.name as string)
    : [];
  const tokens = {
    input_tokens: input,
    output_tokens: output,
    cache_write_5m_tokens: w5m,
    cache_write_1h_tokens: w1h,
    cache_read_tokens: read,
  };

  return {
    // The dedup key. Identical rows from the same response collapse to one.
    event_key: `claude_code:${messageId}`,
    tool: 'claude_code',
    model,
    session_id: entry.sessionId ?? null,
    project: entry.cwd ?? null,
    git_branch: entry.gitBranch ?? null,
    ts: entry.timestamp ? Date.parse(entry.timestamp) : Date.now(),
    ...tokens,
    reasoning_tokens: usage.output_tokens_details?.thinking_tokens ?? 0,
    total_tokens: input + output + w5m + w1h + read,
    cost_usd: computeCost(model, tokens),
    confidence: 'exact',
    is_error: entry.isApiErrorMessage === true ? 1 : 0,
    stop_reason: entry.message?.stop_reason ?? null,
    source: 'live',
    raw_ref: filePath,
    tools: tools.length ? tools.join(',') : null,
    agent_id: entry.agentId ?? null,
    context_window: contextWindow(model),
    // Turn-scoped estimate from the turn-start gap — a lower bound on true speed.
    duration_ms: durationMs,
    duration_kind: durationMs !== null ? ('turn_scoped' as const) : null,
  };
}
