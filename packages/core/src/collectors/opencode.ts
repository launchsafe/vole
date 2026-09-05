import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { paths } from '../paths';
import { contextWindow } from '../pricing';
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
    return { tool: 'opencode', events, filesScanned: 0, notes: [`No OpenCode DB at ${dbPath}`] };
  }

  let src: Database.Database;
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

    const toolsByMessage = new Map<string, string>();
    for (const r of src
      .prepare(
        `SELECT message_id, group_concat(json_extract(data, '$.tool'), ',') AS tools
           FROM part WHERE json_extract(data, '$.type') = 'tool' GROUP BY message_id`,
      )
      .all() as { message_id: string; tools: string }[]) {
      toolsByMessage.set(r.message_id, r.tools);
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
      });
    }
  } finally {
    src.close();
  }

  return { tool: 'opencode', events, filesScanned: 1, notes };
}
