/**
 * The span model (feature 27): real execute_tool durations, honestly
 * zero-length chat spans. Roadmap-v1 said Claude spans have no duration and
 * should be demoted to span events — right for the model call, wrong for tool
 * calls: a tool_call with duration_kind='measured' carries a true interval.
 * Chat spans are zero-length UNLESS the source stated the span; every span
 * carries a vole.duration_source badge ('measured' | 'turn_scoped' | 'none')
 * so the app's timing column and the trace UI cannot diverge about what the
 * number means.
 *
 * Ids are deterministic (sha256 of the stable key, never now()): replays
 * re-emit the same trace/span ids, which is the only dedupe an OTLP backend
 * might honour.
 */
import { createHash } from 'node:crypto';
import type { DB } from '../db';
import type { EncodeCtx } from './fields';

export interface VoleSpan {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  start_time_unix_nano: string;
  end_time_unix_nano: string;
  kind: 'internal' | 'server';
  attributes: Record<string, string | number>;
}

function id32(...parts: (string | number | null | undefined)[]): string {
  return createHash('sha256').update(parts.map((p) => p ?? '').join('|')).digest('hex').slice(0, 32);
}

export function traceIdFor(sessionId: string): string {
  return id32('trace', sessionId);
}

export interface SpanBuildOpts {
  from?: number;
  limit?: number;
}

/**
 * Build the exported trace model for the live partition: one trace per
 * session; tool-call spans with real durations where measured; chat spans
 * zero-length unless measured. Agent-id subagent calls become child spans of
 * the session's synthetic root.
 */
export function buildSpans(db: DB, _ctx: EncodeCtx, opts: SpanBuildOpts = {}): VoleSpan[] {
  const spans: VoleSpan[] = [];
  const seenSessions = new Map<string, string>(); // session_id -> root span id

  const rootSpanId = (sessionId: string, atTs: number): string => {
    const existing = seenSessions.get(sessionId);
    if (existing) return existing;
    const sid = id32('root', sessionId).slice(0, 16);
    seenSessions.set(sessionId, sid);
    // A synthetic, zero-length session root so child parent ids resolve.
    spans.push({
      trace_id: traceIdFor(sessionId),
      span_id: sid,
      parent_span_id: null,
      name: 'session',
      start_time_unix_nano: String(atTs * 1_000_000),
      end_time_unix_nano: String(atTs * 1_000_000),
      kind: 'internal',
      attributes: { 'vole.duration_source': 'none' },
    });
    return sid;
  };

  // ── tool-call spans: the ones with real durations ─────────────────────
  // A pre-migration store honestly lacks the tier-5 columns; select what exists.
  const haveTc = new Set(
    (db.prepare('PRAGMA table_info(tool_calls)').all() as { name: string }[]).map((c) => c.name),
  );
  const tcCols = ['tool_call_key', 'session_id', 'agent_id', 'tool', 'name', 'server', 'ts',
    'duration_ms', 'duration_kind', 'status', 'permission_mode', 'autonomy_rank', 'origin_kind',
    'execution_context_id'].filter((c) => haveTc.has(c));
  const tcWhere = opts.from !== undefined ? 'WHERE ts >= ?' : '';
  const tc = db.prepare(
    `SELECT ${tcCols.join(', ')}
     FROM tool_calls ${tcWhere} ORDER BY ts, tool_call_key ${opts.limit ? `LIMIT ${Math.floor(opts.limit)}` : ''}`,
  ).all(...(opts.from !== undefined ? [opts.from] : [])) as Record<string, unknown>[];

  for (const r of tc) {
    const sessionId = r['session_id'] as string | null;
    const trace = sessionId ? traceIdFor(sessionId) : id32('trace', String(r['tool_call_key']));
    const spanId = id32('span', String(r['tool_call_key'])).slice(0, 16);
    const start = Number(r['ts']);
    const measured = r['duration_kind'] === 'measured' && r['duration_ms'] != null;
    const end = measured ? start + Number(r['duration_ms']) : start; // zero-length when unmeasured — honest
    const attrs: Record<string, string | number> = {
      'vole.duration_source': r['duration_kind'] === 'measured' ? 'measured' : 'none',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': String(r['name']),
    };
    if (r['server']) attrs['vole.mcp_server'] = String(r['server']);
    if (r['status']) attrs['vole.status'] = String(r['status']);
    if (r['permission_mode']) attrs['vole.permission_mode'] = String(r['permission_mode']);
    if (r['autonomy_rank']) attrs['vole.autonomy_rank'] = String(r['autonomy_rank']);
    if (r['origin_kind']) attrs['vole.origin_kind'] = String(r['origin_kind']);
    if (r['execution_context_id']) attrs['vole.execution_context_id'] = String(r['execution_context_id']);
    spans.push({
      trace_id: trace,
      span_id: spanId,
      parent_span_id: sessionId ? rootSpanId(sessionId, start) : null,
      name: `execute_tool ${String(r['name'])}`,
      start_time_unix_nano: String(start * 1_000_000),
      end_time_unix_nano: String(end * 1_000_000),
      kind: 'internal',
      attributes: attrs,
    });
  }

  // ── chat spans: zero-length unless the source stated the span ─────────
  const evWhere = opts.from !== undefined ? 'AND ts >= ?' : '';
  const evs = db.prepare(
    `SELECT event_key, session_id, agent_id, tool, model, ts, duration_ms, duration_kind,
            input_tokens, output_tokens, total_tokens, is_error
     FROM usage_events WHERE source = 'live' ${evWhere}
     ORDER BY ts, event_key ${opts.limit ? `LIMIT ${Math.floor(opts.limit)}` : ''}`,
  ).all(...(opts.from !== undefined ? [opts.from] : [])) as Record<string, unknown>[];

  for (const r of evs) {
    const sessionId = r['session_id'] as string | null;
    const trace = sessionId ? traceIdFor(sessionId) : id32('trace', String(r['event_key']));
    const spanId = id32('span', String(r['event_key'])).slice(0, 16);
    const start = Number(r['ts']);
    const measured = r['duration_kind'] === 'measured' && r['duration_ms'] != null;
    const end = measured ? start + Number(r['duration_ms']) : start;
    const attrs: Record<string, string | number> = {
      'vole.duration_source': measured ? 'measured' : r['duration_kind'] === 'turn_scoped' ? 'turn_scoped' : 'none',
      'gen_ai.operation.name': 'chat',
    };
    if (r['model']) attrs['gen_ai.response.model'] = String(r['model']);
    if (r['input_tokens'] != null) attrs['gen_ai.usage.input_tokens'] = Number(r['input_tokens']);
    if (r['output_tokens'] != null) attrs['gen_ai.usage.output_tokens'] = Number(r['output_tokens']);
    if (r['agent_id']) attrs['gen_ai.agent.id'] = String(r['agent_id']);
    spans.push({
      trace_id: trace,
      span_id: spanId,
      parent_span_id: sessionId ? rootSpanId(sessionId, start) : null,
      name: 'chat',
      start_time_unix_nano: String(start * 1_000_000),
      end_time_unix_nano: String(end * 1_000_000),
      kind: 'server',
      attributes: attrs,
    });
  }
  return spans;
}
