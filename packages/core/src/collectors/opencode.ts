import { count } from '../util/jsonl.js';
import { Database } from '../sqlite';
import { existsSync, statSync } from 'node:fs';
import { paths } from '../paths';
import { contextWindow } from '../pricing';
import { getState, setState, type DB } from '../db';
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

/** SQLite caps a statement at 32766 bind variables; an `IN (...)` built one hole
 *  per id throws `too many SQL variables` past that. Split the ids instead — a
 *  large first scan would otherwise fail on every pass, and because the watermark
 *  only moves in commit(), it would fail identically forever. */
function chunked<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export function collectOpencode(_db: DB): CollectorResult {
  const dbPath = paths.opencodeDb();
  const events: UsageEvent[] = [];
  const notes: string[] = [];

  if (!existsSync(dbPath)) {
    return { tool: 'opencode', events, filesScanned: 0, notes: [`No OpenCode DB at ${dbPath}`], sourceState: 'no_source' };;
  }

  let src: DB;
  try {
    // Read-only: OpenCode may be running and holding this file (WAL).
    src = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return {
      tool: 'opencode',
      events,
      filesScanned: 0,
      notes: [`Could not open OpenCode DB read-only: ${(err as Error).message}`],
      sourceState: 'error',
    };
  }

  // Scan cursor: a rowid watermark on `message`, so a poll reads only new rows
  // instead of the whole 507 MB store. rowid is not stable across a VACUUM and
  // can be reused after deletes, so a shrinking max(rowid) forces one full
  // re-scan — the re-read is idempotent on the stable event keys, it only costs
  // one pass.
  const msgCursorKey = `${dbPath}#message`;
  let msgCursor = getState(_db, msgCursorKey)?.last_offset ?? 0;
  if ((src.prepare('SELECT MAX(rowid) AS m FROM message').get() as { m: number | null }).m === null) msgCursor = 0;
  else if ((msgCursor > 0) &&
    (src.prepare('SELECT MAX(rowid) AS m FROM message').get() as { m: number | null }).m! < msgCursor) {
    msgCursor = 0; // rowid went backwards: VACUUM or deletes — re-scan once
    notes.push('message rowid watermark moved backwards; full re-scan this pass');
  }

  // This pass's new watermark, advanced by commit() only after the rows stored.
  let nextMsgRowid = msgCursor;

  try {
    const rows = src
      .prepare(
        `SELECT id, session_id, time_created, data, rowid AS rid
           FROM message
          WHERE json_extract(data, '$.role') = 'assistant' AND rowid > ?
          ORDER BY rowid`,
      )
      .all(msgCursor) as (MsgRow & { rid: number })[];

    // Repair pass for rows the cursor already passed while they were in flight.
    // Those were stored at zero tokens and the watermark moved beyond them, so the
    // ordinary read can never reach them again. Anything we hold at zero is either
    // a genuinely empty turn (re-reading it is a no-op) or a stranded snapshot whose
    // real numbers are now in OpenCode — so re-read them and let the upsert grow it.
    // Bounded by LIMIT so the bind list stays well inside SQLite's variable cap.
    const stranded = (
      _db
        .prepare(
          `SELECT raw_ref FROM usage_events
            WHERE tool = 'opencode' AND source = 'live' AND COALESCE(total_tokens, 0) = 0
            ORDER BY ts DESC LIMIT 400`,
        )
        .all() as { raw_ref: string | null }[]
    )
      .map((x) => x.raw_ref?.split('#message/')[1])
      .filter((x): x is string => !!x);
    if (stranded.length) {
      const seen = new Set(rows.map((r) => r.id));
      for (const chunk of chunked(stranded, 400)) {
        const extra = src
          .prepare(
            `SELECT id, session_id, time_created, data, rowid AS rid
               FROM message
              WHERE id IN (${chunk.map(() => '?').join(',')})`,
          )
          .all(...chunk) as (MsgRow & { rid: number })[];
        for (const r of extra) if (!seen.has(r.id)) rows.push(r);
      }
      rows.sort((a, b) => a.rid - b.rid);
    }

    // Tool NAMES for this pass's messages: a part can be written after its
    // message was already consumed under the message cursor, so attribution is
    // keyed by message_id (bounded by the messages read this pass), not by the
    // part cursor.
    const toolsByMessage = new Map<string, string>();
    if (rows.length) {
      const partRows: { message_id: string; data: string }[] = [];
      for (const ids of chunked(rows.map((r) => r.id), 400)) {
        partRows.push(
          ...(src
            .prepare(
              `SELECT message_id, data FROM part
               WHERE json_extract(data, '$.type') = 'tool' AND message_id IN (${ids.map(() => '?').join(',')})`,
            )
            .all(...ids) as { message_id: string; data: string }[]),
        );
      }
      for (const r of partRows) {
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
    for (const r of src
      .prepare(`SELECT id, parent_id, agent FROM session`)
      .all() as { id: string; parent_id: string | null; agent: string | null }[]) {
      if (r.parent_id) parentOf.set(r.id, { parent: r.parent_id, label: `${r.agent ?? 'agent'}:${r.id}` });
    }

    // The watermark may only pass messages that can never change again. OpenCode
    // INSERTs an assistant row at turn start with zero tokens and UPDATEs it in
    // place on completion at the SAME rowid, so advancing past an in-flight row
    // means its real tokens and cost are never read — the upsert that would heal
    // it only fires on a re-read that can no longer happen. Rows are ordered by
    // rowid, so the cursor stops at the first unfinished message and everything
    // after it is re-read next pass (emitting is idempotent: the upsert only
    // grows a row).
    let cursorBlocked = false;
    for (const r of rows) {
      let d: MsgData;
      try {
        d = JSON.parse(r.data) as MsgData;
      } catch {
        // Unparseable now, unparseable forever — let the cursor pass, or one
        // corrupt row would pin it and every later pass would re-read the tail.
        if (!cursorBlocked && r.rid > nextMsgRowid) nextMsgRowid = r.rid;
        continue;
      }
      // Terminal: completed, or failed (a provider error ends the turn with 0 tokens).
      const settled = d.time?.completed != null || d.error != null
        || (d.finish != null && ERROR_FINISH.has(d.finish));
      // Only rows the ordinary read produced govern the watermark; a repaired
      // row sits below the cursor and must never pin it.
      if (!settled && r.rid > msgCursor) cursorBlocked = true;
      if (!cursorBlocked && r.rid > nextMsgRowid) nextMsgRowid = r.rid;
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
        total_tokens: count(input) + count(output) + count(reasoning) + count(read) + count(write),
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
  } finally {
    src.close();
  }
  return {
    tool: 'opencode',
    events,
    filesScanned: 1,
    notes,
    commit: () => {
      // Advance the scan cursor only after the rows were stored; a failed insert
      // leaves the watermark untouched and the next pass re-reads.
      setState(_db, msgCursorKey, 'opencode', nextMsgRowid, Math.trunc(statSync(dbPath).mtimeMs));
    },
  };
}
