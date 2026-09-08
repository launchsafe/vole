import { Database } from '../sqlite';
import { existsSync, statSync } from 'node:fs';
import { paths } from '../paths';
import { contextWindow } from '../pricing';
import { skeletonize, type ToolCallRow } from '../toolcalls/bind';
import { BASH_TOOLS } from '../toolcalls/file-writes';
import { commandOf } from '../toolcalls/net-ledgers';
import { getCursor, advanceCursor } from '../cursors';
import { stampObservedAt } from './ledger';
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

  // The declared cursors (tier 1 #14): rowid watermarks per table, so a poll
  // reads only new/updated rows instead of the whole 507 MB store. rowid is
  // not stable across a VACUUM and can be reused after deletes, so a shrinking
  // max(rowid) forces one full re-scan — the re-read is idempotent on the
  // stable event keys, it only costs one pass.
  const msgCursorKey = `${dbPath}#message`;
  const partCursorKey = `${dbPath}#part`;
  const msgPrev = getCursor(_db, msgCursorKey);
  const partPrev = getCursor(_db, partCursorKey);
  let msgCursor = msgPrev?.last_offset ?? 0;
  if ((src.prepare('SELECT MAX(rowid) AS m FROM message').get() as { m: number | null }).m === null) msgCursor = 0;
  else if ((msgCursor > 0) &&
    (src.prepare('SELECT MAX(rowid) AS m FROM message').get() as { m: number | null }).m! < msgCursor) {
    msgCursor = 0; // rowid went backwards: VACUUM or deletes — re-scan once
    notes.push('message rowid watermark moved backwards; full re-scan this pass');
  }
  let partCursor = partPrev?.last_offset ?? 0;
  let partTimeCursor = partPrev?.last_mtime ?? 0;
  if (partCursor > 0) {
    const maxRowid = (src.prepare('SELECT MAX(rowid) AS m FROM part').get() as { m: number | null }).m;
    if (maxRowid === null || maxRowid < partCursor) {
      partCursor = 0;
      partTimeCursor = 0;
      notes.push('part rowid watermark moved backwards; full re-scan this pass');
    }
  }

  // This pass's new watermarks, advanced by commit() only after the rows stored.
  let nextMsgRowid = msgCursor;
  let nextPartRowid = partCursor;
  let nextPartTime = partTimeCursor;
  // Older opencode stores predate part.time_updated; probe before binding it.
  const hasPartTime = (src.prepare('PRAGMA table_info(part)').all() as { name: string }[])
    .some((c) => c.name === 'time_updated');

  try {
    const rows = src
      .prepare(
        `SELECT id, session_id, time_created, data, rowid AS rid
           FROM message
          WHERE json_extract(data, '$.role') = 'assistant' AND rowid > ?
          ORDER BY rowid`,
      )
      .all(msgCursor) as (MsgRow & { rid: number })[];

    // Tool parts: the ledger's richest source — id, status, exit code, and
    // MEASURED start/end times, straight from the part's own state. Bounded by
    // the declared part cursor: new or time_updated rows only.
    const toolParts: {
      id: string; session_id: string | null; tool: string;
      status: string | null; exit: number | null; start: number | null; end: number | null;
      args: unknown;
    }[] = [];
    for (const r of src
      .prepare(
        `SELECT p.id, p.session_id, p.message_id, p.data, p.rowid AS rid${hasPartTime ? ', p.time_updated' : ''}
         FROM part p
         WHERE json_extract(p.data, '$.type') = 'tool' AND (p.rowid > ?${hasPartTime ? ' OR p.time_updated > ?' : ''})`,
      )
      .all(...(hasPartTime ? [partCursor, partTimeCursor] : [partCursor])) as { id: string; session_id: string | null; message_id: string; data: string; rid: number; time_updated: number | null }[]) {
      let d: {
        tool?: string; state?: { status?: string; metadata?: { exit?: number }; time?: { start?: number; end?: number }; input?: unknown };
      };
      try {
        d = JSON.parse(r.data);
      } catch {
        continue;
      }
      const name = d.tool ?? '?';
      if (r.rid > nextPartRowid) nextPartRowid = r.rid;
      if (r.time_updated !== null && r.time_updated > nextPartTime) nextPartTime = r.time_updated;
      toolParts.push({
        id: r.id,
        session_id: r.session_id,
        tool: name,
        status: d.state?.status ?? null,
        exit: d.state?.metadata?.exit ?? null,
        start: d.state?.time?.start ?? null,
        end: d.state?.time?.end ?? null,
        args: d.state?.input ?? null, // the raw tool arguments — derivation-only, never stored
      });
    }

    // Tool NAMES for this pass's messages: a part can be written after its
    // message was already consumed under the message cursor, so attribution is
    // keyed by message_id (bounded by the messages read this pass), not by the
    // part cursor.
    const toolsByMessage = new Map<string, string>();
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      for (const r of src
        .prepare(
          `SELECT message_id, data FROM part
           WHERE json_extract(data, '$.type') = 'tool' AND message_id IN (${ids.map(() => '?').join(',')})`,
        )
        .all(...ids) as { message_id: string; data: string }[]) {
        let name: string | undefined;
        try {
          name = (JSON.parse(r.data) as { tool?: string }).tool;
        } catch {
          continue;
        }
        if (!name) continue;
        toolsByMessage.set(r.message_id, toolsByMessage.get(r.message_id) ? `${toolsByMessage.get(r.message_id)},${name}` : name);
      }
    }

    // child session -> { parent, label }. Nesting is one level deep in OpenCode.
    const parentOf = new Map<string, { parent: string; label: string }>();
    // session -> directory, for write-target resolution (older stores lack it).
    const cwdOf = new Map<string, string>();
    const hasDirectory = (src.prepare('PRAGMA table_info(session)').all() as { name: string }[])
      .some((c) => c.name === 'directory');
    for (const r of src
      .prepare(`SELECT id, parent_id, agent${hasDirectory ? ', directory' : ''} FROM session`)
      .all() as { id: string; parent_id: string | null; agent: string | null; directory?: string | null }[]) {
      if (r.parent_id) parentOf.set(r.id, { parent: r.parent_id, label: `${r.agent ?? 'agent'}:${r.id}` });
      if (r.directory) cwdOf.set(r.id, r.directory);
    }

    for (const r of rows) {
      if (r.rid > nextMsgRowid) nextMsgRowid = r.rid;
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
        args: tp.args, // derivation-only: the bind-time ledgers read it, the store never keeps it
        command: BASH_TOOLS.has(tp.tool) ? commandOf(tp.tool, tp.args) : null,
        cwd: cwdOf.get(tp.session_id ?? '') ?? null,
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
  const now = Date.now(); // the collector clock — observed_at, never a key
  return {
    tool: 'opencode',
    events,
    filesScanned: 1,
    notes,
    toolCalls: calls,
    commit: () => {
      // Advance the declared cursors only after the rows were stored; a failed
      // insert leaves the watermark untouched and the next pass re-reads.
      const st = statSync(dbPath);
      const stat = { ino: st.ino, birthtimeMs: st.birthtimeMs };
      advanceCursor(_db, { sourceKey: msgCursorKey, tool: 'opencode', offset: nextMsgRowid, mtimeMs: st.mtimeMs, stat });
      advanceCursor(_db, { sourceKey: partCursorKey, tool: 'opencode', offset: nextPartRowid, mtimeMs: nextPartTime || st.mtimeMs, stat });
      stampObservedAt(_db, events.map((e) => e.event_key), now);
    },
  };
}
