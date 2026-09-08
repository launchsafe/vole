import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths';
import type { DB } from '../db';
import { parseLine } from '../util/jsonl';
import { skeletonize, type ToolCallRow } from '../toolcalls/bind';
import { contentOf, type Content } from '../content';
import { computeCost, contextWindow } from '../pricing';
import { advanceCursor, readSlice, getCursor } from '../cursors';
import { recordUploadStart, recordUploadEnqueued, recordUploadDecision, stampObservedAt } from './ledger';
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
  success?: boolean;
  elapsed_ms?: number;
  /* repo_state.upload.start */
  phase?: string;
  turn_number?: number;
  repo_path?: string;
  max_file_bytes?: number;
  /* repo_state.upload.enqueued */
  size_bytes?: number;
  gcs_path?: string;
  blobs?: number;
  /* trace.upload.decision — the vendor's own precedence chain */
  trace_upload?: boolean;
  trace_upload_source?: string;
  telemetry_mode?: string;
  telemetry_source?: string;
  in_requirement_pin?: boolean;
  in_env_trace_upload?: boolean;
  in_env_telemetry_enabled?: boolean;
  in_cfg_telemetry_trace_upload?: boolean;
  in_cfg_features_telemetry?: boolean;
  in_remote_trace_upload_enabled?: boolean;
  has_remote_settings?: boolean;
  uploads_enabled?: boolean;
  upload_reason?: string;
  data_collection_disabled?: boolean;
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

export function collectGrok(db: DB): CollectorResult {
  const logPath = paths.grokUnifiedLog();
  const events: UsageEvent[] = [];
  const notes: string[] = [];
  const calls: ToolCallRow[] = [];

  if (!existsSync(logPath)) {
    return { tool: 'grok', events, filesScanned: 0, notes: [`No Grok log at ${logPath}`], sourceState: 'no_source' };;
  }

  const meta = sessionMeta();
  let lines: Content[];
  let st: ReturnType<typeof statSync>;
  try {
    // contentOf via map: the boundary crossing for the unified log. Full re-read
    // each pass (cheap, 18ms) so cross-chunk exec_done attribution stays correct.
    lines = readFileSync(logPath, 'utf8').split('\n').map(contentOf);
    st = statSync(logPath);
  } catch (err) {
    return { tool: 'grok', events, filesScanned: 0, notes: [`Could not read ${logPath}: ${(err as Error).message}`] };
  }

  // The latest call per session, so tool executions can be attributed to it.
  const lastCall = new Map<string, UsageEvent>();
  const failNull = {
    input_tokens: null, output_tokens: null, cache_write_5m_tokens: null,
    cache_write_1h_tokens: null, cache_read_tokens: null, reasoning_tokens: null,
    total_tokens: null, cost_usd: null, duration_ms: null, duration_kind: null,
  };

  let prevLineTs: number | null = null;
  // The last upload start per session: an enqueued line widens the most recent
  // start of the same session when it does not carry its own join fields.
  const openUploads = new Map<string, string>();
  for (const raw of lines) {
    const e = parseLine<Line>(raw);
    if (!e || !e.ctx || !e.sid || !e.ts) {
      continue;
    }
    const lineTs = Date.parse(e.ts);

    // ── repo_state uploads: the whole-repo tarball egress (tier 5 #7) ──
    if (e.msg === 'repo_state.upload.start') {
      const c = e.ctx;
      const key = `grok-upload:${e.sid}:${c.turn_number ?? 'na'}:${c.repo_path ?? 'na'}`;
      recordUploadStart(db, {
        upload_key: key,
        repo_path: c.repo_path ?? null,
        turn: typeof c.turn_number === 'number' ? c.turn_number : null,
        max_file_bytes: typeof c.max_file_bytes === 'number' ? c.max_file_bytes : null,
        phase: c.phase ?? null,
        started_at: Number.isFinite(lineTs) ? lineTs : null,
      });
      openUploads.set(e.sid, key);
      continue;
    }
    if (e.msg === 'repo_state.upload.enqueued') {
      const c = e.ctx;
      const key = c.turn_number !== undefined || c.repo_path !== undefined
        ? `grok-upload:${e.sid}:${c.turn_number ?? 'na'}:${c.repo_path ?? 'na'}`
        : (openUploads.get(e.sid) ?? null);
      // size_bytes exists only on enqueued records: 399 starts produced 274
      // enqueued lines on the reference machine, so the 125 that never
      // enqueued keep size NULL — an unknown, never a 0-byte upload.
      if (key) {
        recordUploadEnqueued(db, {
          upload_key: key,
          size_bytes: typeof c.size_bytes === 'number' ? c.size_bytes : null,
          gcs_path: c.gcs_path ?? null,
          blobs: typeof c.blobs === 'number' ? c.blobs : null,
        });
      }
      continue;
    }
    // ── the measured collection posture (tier 6 #72) ──
    if (e.msg === 'trace.upload.decision') {
      const c = e.ctx;
      recordUploadDecision(db, {
        // The source line's own timestamp is the key's clock — never now().
        upload_key: `grok-decision:${e.sid}:${e.ts}`,
        ts: Number.isFinite(lineTs) ? lineTs : null,
        uploads_enabled: typeof c.uploads_enabled === 'boolean' ? (c.uploads_enabled ? 1 : 0) : null,
        upload_reason: c.upload_reason ?? null,
        trace_upload_source: c.trace_upload_source ?? null,
        telemetry_mode: c.telemetry_mode ?? null,
        data_collection_disabled: typeof c.data_collection_disabled === 'boolean' ? (c.data_collection_disabled ? 1 : 0) : null,
        in_env_trace_upload: typeof c.in_env_trace_upload === 'boolean' ? (c.in_env_trace_upload ? 1 : 0) : null,
        in_cfg_telemetry_trace_upload: typeof c.in_cfg_telemetry_trace_upload === 'boolean' ? (c.in_cfg_telemetry_trace_upload ? 1 : 0) : null,
        in_remote_trace_upload_enabled: typeof c.in_remote_trace_upload_enabled === 'boolean' ? (c.in_remote_trace_upload_enabled ? 1 : 0) : null,
        has_remote_settings: typeof c.has_remote_settings === 'boolean' ? (c.has_remote_settings ? 1 : 0) : null,
        in_requirement_pin: typeof c.in_requirement_pin === 'boolean' ? (c.in_requirement_pin ? 1 : 0) : null,
      });
      continue;
    }

    if (e.msg === 'shell.tool.exec_done' && e.ctx.tool_name) {
      const prev = lastCall.get(e.sid);
      if (prev) prev.tools = prev.tools ? `${prev.tools},${e.ctx.tool_name}` : e.ctx.tool_name;
      if (Number.isFinite(lineTs)) prevLineTs = lineTs;
      // The ledger: grok's exec_done is call AND verdict in one line — success
      // flag, elapsed_ms measured. status_source: log_flag.
      calls.push({
        tool_call_key: `grok:${e.sid}:${e.ts}:${calls.length}`,
        tool: 'grok',
        name: e.ctx.tool_name,
        shape: skeletonize(e.ctx.tool_name, null),
        args_digest: null,
        session_id: e.sid,
        agent_id: null,
        ts: lineTs,
        status: e.ctx.success === false ? 'error' : 'success',
        status_source: 'log_flag',
        // elapsed_ms of 0 is a real instant (a cache hit) but not a measured
        // span — a zero duration is 'no duration', not a fast one.
        duration_ms: typeof e.ctx.elapsed_ms === 'number' && e.ctx.elapsed_ms > 0 ? e.ctx.elapsed_ms : null,
        duration_kind: typeof e.ctx.elapsed_ms === 'number' && e.ctx.elapsed_ms > 0 ? 'measured' : null,
        authority: 'no_record',
        raw_ref: `${logPath} (${e.sid})`,
      });
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
    // Turn-scoped estimate: the gap from the previous log line (same runtime,
    // any session) to this completion. Includes queue time; the kind says so.
    const duration =
      prevLineTs !== null && lineTs > prevLineTs && lineTs - prevLineTs < 600_000
        ? lineTs - prevLineTs
        : null;
    if (Number.isFinite(lineTs)) prevLineTs = lineTs;

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
      duration_ms: duration,
      duration_kind: duration !== null ? ('turn_scoped' as const) : null,
    };
    events.push(ev);
    lastCall.set(e.sid, ev);
  }

  // The declared cursor for the unified log: the byte offset and the chained
  // prefix digest, so the Coverage strip can state where this source stopped
  // and detect a rewrite. The log is still re-READ in full each pass (exec_done
  // attribution crosses chunk boundaries); the cursor is the record, not the gate.
  const prev = getCursor(db, logPath);
  advanceCursor(db, {
    sourceKey: logPath,
    tool: 'grok',
    offset: st.size,
    mtimeMs: st.mtimeMs,
    newBytes: readSlice(logPath, Math.min(prev?.last_offset ?? 0, st.size), st.size),
    stat: { ino: st.ino, birthtimeMs: st.birthtimeMs },
  });

  const now = Date.now(); // the collector clock — observed_at, never a key
  return {
    tool: 'grok',
    events,
    filesScanned: 1,
    notes,
    toolCalls: calls,
    commit: () => {
      // The second clock on this pass's rows (tier 7 #39).
      stampObservedAt(db, events.map((e) => e.event_key), now);
    },
  };
}
