import { Database } from '../sqlite';
import { existsSync } from 'node:fs';
import { paths } from '../paths';
import { contextWindow } from '../pricing';
import { skeletonize, type ToolCallRow } from '../toolcalls/bind';
import type { DB } from '../db';
import type { CollectorResult, Confidence, UsageEvent } from '../types';

/**
 * OpenCode — exact.
 *
 * ~/.local/share/opencode/opencode.db is a Drizzle SQLite store. Every assistant turn is
 * one `message` row whose `data` JSON carries `cost`, a `tokens` object split into
 * input / output / reasoning / cache.{read,write}, `modelID`, `providerID`, per-turn
 * timestamps and the working directory — everything Vole needs, verbatim. Confidence is
 * `exact`; cost is OpenCode's own figure (it prices every provider it supports,
 * including local models at $0), not recomputed here.
 *
 * Keyed on the message id, so re-reading the whole table on every poll is idempotent.
 *
 * Tool names come from the `part` table (one `tool` part per call, keyed on message id).
 * A subagent runs as a child `session` with `parent_id` set; its calls are stored under
 * the parent's session id with `agent_id = <agent>:<child id>`, so a session's spend is
 * one tree — the same shape Claude Code's `agentId` gives.
 */

interface MsgRow {
  id: string;
  session_id: string | null;
  time_created: number;
  data: string;
}

interface MsgData {
  role?: string;
  cost?: number | null;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  modelID?: string | null;
  providerID?: string | null;
  path?: { cwd?: string | null; root?: string | null };
  time?: { created?: number; completed?: number };
  finish?: string | null;
  /** Present when the provider call failed (timeout, 4xx/5xx); tokens are then 0. */
  error?: unknown;
}

const ERROR_FINISH = new Set(['error', 'content-filter']);

export function collectOpencode(_db: DB): CollectorResult {
  const dbPath = paths.opencodeDb();
  const events: UsageEvent[] = [];
  const notes: string[] = [];

  if (!existsSync(dbPath)) {
    return { tool: 'opencode', events, filesScanned: 0, notes: [`No OpenCode DB at ${dbPath}`], sourceState: 'no_source' };;
  }

  let src: DB;
  const calls: ToolCallRow[] = [];
  try {
    // Read-only: OpenCode may be running and holding this file (WAL).
    src = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return {
      tool: 'opencode',
      events,
      filesScanned: 0,
      notes: [`Could not open OpenCode DB read-only: ${(err as Error).message}`],
    };
  }

  try {
    const rows = src
      .prepare(
        `SELECT id, session_id, time_created, data
           FROM message
          WHERE json_extract(data, '$.role') = 'assistant'`,
      )
      .all() as MsgRow[];

    // Tool parts: the ledger's richest source — id, status, exit code, and
    // MEASURED start/end times, straight from the part's own state.
    const toolParts: {
      id: string; session_id: string | null; tool: string;
      status: string | null; exit: number | null; start: number | null; end: number | null;
    }[] = [];
    const toolsByMessage = new Map<string, string>();
    for (const r of src
      .prepare(
        `SELECT p.id, p.session_id, p.message_id, p.data
         FROM part p WHERE json_extract(p.data, '$.type') = 'tool'`,
      )
      .all() as { id: string; session_id: string | null; message_id: string; data: string }[]) {
      let d: {
        tool?: string; state?: { status?: string; metadata?: { exit?: number }; time?: { start?: number; end?: number } };
      };
      try {
        d = JSON.parse(r.data);
      } catch {
        continue;
      }
      const name = d.tool ?? '?';
      toolParts.push({
        id: r.id,
        session_id: r.session_id,
        tool: name,
        status: d.state?.status ?? null,
        exit: d.state?.metadata?.exit ?? null,
        start: d.state?.time?.start ?? null,
        end: d.state?.time?.end ?? null,
      });
      if (r.message_id) {
        toolsByMessage.set(r.message_id, toolsByMessage.get(r.message_id) ? `${toolsByMessage.get(r.message_id)},${name}` : name);
      }
    }

    // child session -> { parent, label }. Nesting is one level deep in OpenCode.
    const parentOf = new Map<string, { parent: string; label: string }>();
    for (const r of src
      .prepare('SELECT id, parent_id, agent FROM session WHERE parent_id IS NOT NULL')
      .all() as { id: string; parent_id: string; agent: string | null }[]) {
      parentOf.set(r.id, { parent: r.parent_id, label: `${r.agent ?? 'agent'}:${r.id}` });
    }

    for (const r of rows) {
      let d: MsgData;
      try {
        d = JSON.parse(r.data) as MsgData;
      } catch {
        continue;
      }
      const t = d.tokens;
      if (!t) continue;

      const input = t.input ?? 0;
      const output = t.output ?? 0;
      const reasoning = t.reasoning ?? 0;
      const read = t.cache?.read ?? 0;
      const write = t.cache?.write ?? 0;

      // Providers repeat model names (claude-*, gpt-*, qwen3.*), so keep the provider
      // prefix to disambiguate in the breakdown.
      const model =
        d.modelID && d.providerID ? `${d.providerID}/${d.modelID}` : (d.modelID ?? null);
      const child = r.session_id ? parentOf.get(r.session_id) : undefined;

      events.push({
        event_key: `opencode:${r.id}`,
        tool: 'opencode',
        model,
        session_id: child?.parent ?? r.session_id ?? null,
        project: d.path?.cwd ?? d.path?.root ?? null,
        git_branch: null,
        ts: d.time?.created ?? r.time_created,
        input_tokens: input,
        output_tokens: output,
        // OpenCode reports one cache-write figure; attribute it to the 5m slot so the
        // schema's TTL split still totals correctly.
        cache_write_5m_tokens: write,
        cache_write_1h_tokens: 0,
        cache_read_tokens: read,
        reasoning_tokens: reasoning,
        total_tokens: input + output + reasoning + read + write,
        // OpenCode's own figure. A real 0 (free local model) is kept; only a missing
        // field becomes null.
        cost_usd: typeof d.cost === 'number' ? d.cost : null,
        confidence: 'exact' as Confidence,
        is_error: d.error != null || (d.finish && ERROR_FINISH.has(d.finish)) ? 1 : 0,
        stop_reason: d.finish ?? (d.error != null ? 'error' : null),
        source: 'live',
        raw_ref: `${dbPath}#message/${r.id}`,
        tools: toolsByMessage.get(r.id) ?? null,
        agent_id: child?.label ?? null,
        context_window: contextWindow(model),
        // Generation speed's raw material: the message's own completed-created
        // span. Only a REAL span is stored (positive, under 30 min); anything
        // else stays NULL — an unknown, never a fabricated duration.
        duration_ms:
          d.time?.completed != null && d.time?.created != null &&
          d.time.completed > d.time.created && d.time.completed - d.time.created < 1_800_000
            ? d.time.completed - d.time.created
            : null,
        duration_kind:
          d.time?.completed != null && d.time?.created != null &&
          d.time.completed > d.time.created && d.time.completed - d.time.created < 1_800_000
            ? ('measured' as const)
            : null,
      });
    }
    // The ledger: one row per tool part, outcome + MEASURED duration from the
    // part's own state (status/exit, time.start/end) — the richest source.
    for (const tp of toolParts) {
      const errored = tp.status === 'error' || (tp.exit !== null && tp.exit !== 0);
      calls.push({
        tool_call_key: `opencode:${tp.id}`,
        tool: 'opencode',
        name: tp.tool,
        shape: skeletonize(tp.tool, null),
        args_digest: null, // opencode parts carry no args in the tool row
        session_id: parentOf.get(tp.session_id ?? '')?.parent ?? tp.session_id,
        agent_id: parentOf.get(tp.session_id ?? '')?.label ?? null,
        ts: tp.start ?? 0,
        status: errored ? 'error' : tp.status === 'completed' ? 'success' : null,
        status_source: tp.exit !== null ? 'exit_code' : 'log_flag',
        duration_ms: tp.start != null && tp.end != null && tp.end > tp.start ? tp.end - tp.start : null,
        duration_kind: tp.start != null && tp.end != null && tp.end > tp.start ? 'measured' : null,
        authority: 'no_record',
        raw_ref: dbPath,
      });
    }
  } finally {
    src.close();
  }
  return { tool: 'opencode', events, filesScanned: 1, notes, toolCalls: calls };
}
