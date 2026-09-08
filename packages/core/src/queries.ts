import type { DB } from './db';
import { computeCost, rateFor, CACHE_MULTIPLIERS } from './pricing';
import { contextOf, windowOf } from './detect/context-pressure';
import type { Confidence, Severity, Tool, UsageEvent } from './types';

export type Range = '24h' | '7d' | '30d' | 'all';

export function rangeStart(range: Range, now = Date.now()): number {
  switch (range) {
    case '24h': return now - 24 * 3600_000;
    case '7d': return now - 7 * 24 * 3600_000;
    case '30d': return now - 30 * 24 * 3600_000;
    case 'all': return 0;
  }
}

/**
 * Every aggregate below excludes `activity_only` rows from token and cost maths but
 * still counts them as calls. Cursor genuinely made those calls; it just never recorded
 * their size. Counting them as zero tokens would understate nothing but would quietly
 * drag down per-call averages, so they are filtered explicitly rather than coalesced.
 */
const TOKEN_FILTER = "confidence != 'activity_only'";

export interface Summary {
  calls: number;
  tokens: number;
  cost: number | null;
  sessions: number;
  cacheHitRatio: number | null;
  errors: number;
  /** Calls that stopped because they hit the output-token limit (`max_tokens` / `length`). */
  truncated: number;
  /** True when any row in range is activity-only (a tool that records no tokens). */
  hasActivityOnly: boolean;
  hasSeed: boolean;
  byTool: ToolSummary[];
}

export interface ToolSummary {
  tool: Tool;
  calls: number;
  tokens: number | null;
  cost: number | null;
  confidence: Confidence;
  /** Calls in this group that recorded no tokens — a mixed group renders as mixed. */
  activityOnlyCalls: number;
}

export function getSummary(db: DB, range: Range, includeSeed: boolean): Summary {
  const from = rangeStart(range);
  const seedClause = includeSeed ? '' : " AND source = 'live'";

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN ${TOKEN_FILTER} THEN total_tokens END), 0) AS tokens,
              SUM(cost_usd) AS cost,
              COUNT(DISTINCT session_id) AS sessions,
              COALESCE(SUM(is_error), 0) AS errors,
              COALESCE(SUM(CASE WHEN stop_reason IN ('max_tokens', 'length') THEN 1 ELSE 0 END), 0) AS truncated,
              COALESCE(SUM(CASE WHEN ${TOKEN_FILTER} THEN cache_read_tokens END), 0) AS cacheRead,
              COALESCE(SUM(CASE WHEN ${TOKEN_FILTER}
                   THEN COALESCE(input_tokens,0) + COALESCE(cache_write_5m_tokens,0)
                      + COALESCE(cache_write_1h_tokens,0) END), 0) AS freshIn
       FROM usage_events WHERE ts >= ?${seedClause}`,
    )
    .get(from) as {
    calls: number; tokens: number; cost: number | null; sessions: number;
    errors: number; truncated: number; cacheRead: number; freshIn: number;
  };

  const byTool = db
    .prepare(
      `SELECT tool,
              COUNT(*) AS calls,
              CASE WHEN SUM(CASE WHEN ${TOKEN_FILTER} THEN 1 ELSE 0 END) = 0
                   THEN NULL
                   ELSE COALESCE(SUM(CASE WHEN ${TOKEN_FILTER} THEN total_tokens END), 0)
              END AS tokens,
              SUM(cost_usd) AS cost,
              CASE WHEN SUM(confidence != 'activity_only') = 0
                   THEN 'activity_only' ELSE 'exact' END AS confidence,
              SUM(CASE WHEN confidence = 'activity_only' THEN 1 ELSE 0 END) AS activityOnlyCalls
       FROM usage_events WHERE ts >= ?${seedClause}
       GROUP BY tool ORDER BY calls DESC`,
    )
    .all(from) as ToolSummary[];

  const flags = db
    .prepare(
      `SELECT SUM(CASE WHEN confidence = 'activity_only' THEN 1 ELSE 0 END) AS activityOnly,
              SUM(CASE WHEN source = 'seed' THEN 1 ELSE 0 END) AS seed
       FROM usage_events WHERE ts >= ?`,
    )
    .get(from) as { activityOnly: number | null; seed: number | null };

  const denom = totals.cacheRead + totals.freshIn;

  return {
    calls: totals.calls,
    tokens: totals.tokens,
    cost: totals.cost,
    sessions: totals.sessions,
    errors: totals.errors,
    truncated: totals.truncated,
    cacheHitRatio: denom > 0 ? totals.cacheRead / denom : null,
    hasActivityOnly: (flags.activityOnly ?? 0) > 0,
    hasSeed: (flags.seed ?? 0) > 0,
    byTool,
  };
}

export type TimePoint = { bucket: number } & Partial<Record<Tool, number>>;

const ZERO_BY_TOOL: Record<Tool, number> = {
  claude_code: 0,
  codex: 0,
  cursor: 0,
  antigravity: 0,
  opencode: 0,
  grok: 0,
  devin: 0,
  gemini: 0,
  copilot_cli: 0,
  goose: 0,
  amp: 0,
  continue: 0,
  aider: 0,
  vscode_chat: 0,
  clines: 0,
  ollama_local: 0,
  kiro: 0,
  vole: 0,
};

/**
 * One point per bucket across the whole range, quiet buckets included. Without the
 * fill, a category axis packs the active days together and a 30-day view of eight
 * active days reads as eight equal bars — and an incident on a quiet day has no bar
 * to pin to.
 */
export function getTimeseries(db: DB, range: Range, includeSeed: boolean, now = Date.now()): TimePoint[] {
  const from = rangeStart(range, now);
  const seedClause = includeSeed ? '' : " AND source = 'live'";
  // Hourly detail for a day, daily buckets for anything longer.
  const bucketMs = range === '24h' ? 3600_000 : 24 * 3600_000;

  const rows = db
    .prepare(
      // CAST is required: a bound numeric parameter makes SQLite use floating-point
      // division, so (ts / n) * n returns ts unchanged and every event becomes its own
      // bucket. Truncating explicitly is what actually aligns buckets to day/hour edges.
      `SELECT CAST(ts / ? AS INTEGER) * ? AS bucket, tool,
              COALESCE(SUM(CASE WHEN ${TOKEN_FILTER} THEN total_tokens END), 0) AS tokens
       FROM usage_events WHERE ts >= ?${seedClause}
       GROUP BY bucket, tool ORDER BY bucket`,
    )
    .all(bucketMs, bucketMs, from) as { bucket: number; tool: Tool; tokens: number }[];

  const map = new Map<number, TimePoint>();
  for (const r of rows) {
    let pt = map.get(r.bucket);
    if (!pt) {
      pt = { bucket: r.bucket, ...ZERO_BY_TOOL };
      map.set(r.bucket, pt);
    }
    pt[r.tool] = r.tokens;
  }
  if (map.size === 0) return [];
  // 'all' has no natural start: span the data. Bounded ranges span the window to now.
  const first = range === 'all' ? Math.min(...map.keys()) : Math.floor(from / bucketMs) * bucketMs;
  const last = Math.max(Math.floor(now / bucketMs) * bucketMs, ...map.keys());
  for (let b = first; b <= last; b += bucketMs) {
    if (!map.has(b)) map.set(b, { bucket: b, ...ZERO_BY_TOOL });
  }
  return [...map.values()].sort((a, b) => a.bucket - b.bucket);
}

export type BreakdownBy = 'model' | 'project' | 'branch';
const BREAKDOWN_COL: Record<BreakdownBy, string> = { model: 'model', project: 'project', branch: 'git_branch' };

export interface BreakdownRow {
  tool: Tool;
  /** The model id — or the project path / branch name when grouped that way. */
  model: string | null;
  confidence: Confidence;
  calls: number;
  tokens: number | null;
  cost: number | null;
  cacheRead: number | null;
  output: number | null;
}

export function getBreakdown(
  db: DB,
  range: Range,
  includeSeed: boolean,
  by: BreakdownBy = 'model',
): BreakdownRow[] {
  const from = rangeStart(range);
  const seedClause = includeSeed ? '' : " AND source = 'live'";
  // `by` is a closed union, never user text — safe to splice into SQL.
  const col = BREAKDOWN_COL[by] ?? 'model';
  return db
    .prepare(
      `SELECT tool, ${col} AS model, confidence,
              COUNT(*) AS calls,
              CASE WHEN confidence = 'activity_only' THEN NULL
                   ELSE COALESCE(SUM(total_tokens), 0) END AS tokens,
              SUM(cost_usd) AS cost,
              CASE WHEN confidence = 'activity_only' THEN NULL
                   ELSE COALESCE(SUM(cache_read_tokens), 0) END AS cacheRead,
              CASE WHEN confidence = 'activity_only' THEN NULL
                   ELSE COALESCE(SUM(output_tokens), 0) END AS output
       FROM usage_events WHERE ts >= ?${seedClause}
       GROUP BY tool, ${col}, confidence
       ORDER BY (tokens IS NULL), tokens DESC`,
    )
    .all(from) as BreakdownRow[];
}

export interface IncidentRow {
  id: number;
  anomaly_key: string;
  rule: string;
  severity: string;
  tool: Tool;
  session_id: string | null;
  model: string | null;
  window_start: number;
  window_end: number;
  title: string;
  detail: string;
  observed: number;
  baseline: number | null;
  threshold: number | null;
  confidence: Confidence;
  source: string;
  detected_at: number;
}

// ponytail: the dashboard counts what this returns, so the cap is the count's ceiling;
// add a COUNT(*) alongside if a feed ever outgrows it.
export function getAnomalies(db: DB, range: Range, includeSeed: boolean, limit = 500): IncidentRow[] {
  const from = rangeStart(range);
  const seedClause = includeSeed ? '' : " AND source = 'live'";
  // v_incident_explained is the shared read-model view created by migration 7 —
  // the shape lives in the store, and both readers (TS and Swift) select from it.
  return db
    .prepare(
      `SELECT * FROM v_incident_explained WHERE window_end >= ?${seedClause}
       ORDER BY window_start DESC LIMIT ?`,
    )
    .all(from, limit) as IncidentRow[];
}

// ── Token speed ───────────────────────────────────────────────────────────────

export interface TokenSpeed {
  /** Trailing-window average, tokens per minute. */
  perMin: number;
  /** The busiest single minute in the last 24h — the honest peak, not an instant. */
  peakPerMin: number;
  byTool: { tool: Tool; perMin: number }[];
}

/**
 * Token speed: the trailing-window burn rate and the 24h peak minute. `now` is
 * a parameter (not Date.now()) so the figure is testable and the two readers
 * can be compared on the same instant.
 */
export function getTokenSpeed(db: DB, windowMs = 5 * 60_000, now = Date.now()): TokenSpeed {
  const from = now - windowMs;
  const rows = db
    .prepare(
      `SELECT tool, COALESCE(SUM(total_tokens), 0) AS t
       FROM usage_events WHERE ts >= ? AND ts <= ? AND source = 'live' AND ${TOKEN_FILTER}
       GROUP BY tool ORDER BY t DESC`,
    )
    .all(from, now) as { tool: Tool; t: number }[];
  const minutes = windowMs / 60_000;
  const byTool = rows.map((r) => ({ tool: r.tool, perMin: r.t / minutes }));
  const peak = db
    .prepare(
      `SELECT COALESCE(MAX(c), 0) AS peak FROM (
         SELECT SUM(total_tokens) AS c
         FROM usage_events WHERE ts >= ? AND source = 'live' AND ${TOKEN_FILTER}
         GROUP BY CAST(ts / 60000 AS INTEGER))`,
    )
    .get(now - 24 * 3600_000) as { peak: number };
  return {
    perMin: byTool.reduce((s, t) => s + t.perMin, 0),
    peakPerMin: peak.peak ?? 0,
    byTool: byTool.slice(0, 5),
  };
}

// ── Generation speed (tok/s) ─────────────────────────────────────────────────

export interface ModelSpeed {
  tool: Tool;
  model: string | null;
  /** Output tokens per second, over rows that state a real duration. */
  tokensPerSecond: number;
  /** Median response duration in ms — the typical latency, not the mean (tails lie). */
  medianDurationMs: number;
  rows: number;
  /** Share of this model's output tokens that carry a duration: the coverage. */
  coverage: number;
  /** How the durations were obtained — 'measured' from the source, or
   * 'turn_scoped' estimated from gaps (a lower bound on true speed). */
  kind: 'measured' | 'turn_scoped';
}

/**
 * Generation speed: how fast each model actually produced tokens —
 * SUM(output_tokens) / SUM(duration) over rows with a stated duration, per
 * tool+model, with the coverage fraction printed beside every figure. Rows
 * without a duration are excluded and counted, never guessed: a speed figure
 * without its coverage is a benchmark, not a measurement.
 */
export function getModelSpeeds(db: DB, range: Range, includeSeed = false): ModelSpeed[] {
  const from = rangeStart(range);
  const seedClause = includeSeed ? '' : " AND source = 'live'";
  const rows = db
    .prepare(
      `SELECT tool, model,
              SUM(CASE WHEN duration_ms IS NOT NULL THEN output_tokens END) AS out_dur,
              SUM(CASE WHEN duration_ms IS NULL THEN output_tokens END) AS out_nodur,
              SUM(duration_ms) AS dur_ms,
              COUNT(CASE WHEN duration_ms IS NOT NULL THEN 1 END) AS rows_dur
       FROM usage_events WHERE ts >= ?${seedClause} AND confidence != 'activity_only'
       GROUP BY tool, model HAVING out_dur > 0 AND dur_ms > 0
       ORDER BY out_dur / dur_ms DESC`,
    )
    .all(from) as {
    tool: Tool; model: string | null; out_dur: number | null; out_nodur: number | null;
    dur_ms: number | null; rows_dur: number;
  }[];
  return rows.map((r) => {
    const withDur = r.out_dur ?? 0;
    const withoutDur = r.out_nodur ?? 0;
    // Provenance: whichever kind contributed more duration decides the label.
    const kindRow = db
      .prepare(
        `SELECT duration_kind, SUM(duration_ms) AS d FROM usage_events
         WHERE ts >= ?${seedClause} AND tool = ? AND model IS ? AND duration_ms IS NOT NULL
         GROUP BY duration_kind ORDER BY d DESC LIMIT 1`,
      )
      .get(from, r.tool, r.model) as { duration_kind: string | null } | undefined;
    return {
      tool: r.tool,
      model: r.model,
      tokensPerSecond: withDur / (r.dur_ms! / 1000),
      medianDurationMs: median(
        db.prepare(
          `SELECT duration_ms FROM usage_events WHERE ts >= ?${seedClause} AND tool = ? AND model IS ? AND duration_ms IS NOT NULL`,
        ).all(from, r.tool, r.model).map((x) => (x as { duration_ms: number }).duration_ms),
      ),
      rows: r.rows_dur,
      coverage: withDur + withoutDur > 0 ? withDur / (withDur + withoutDur) : 0,
      kind: kindRow?.duration_kind === 'measured' ? ('measured' as const) : ('turn_scoped' as const),
    };
  });
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// ── Live sessions ─────────────────────────────────────────────────────────────

const SEV_RANK: Record<string, number> = { info: 0, warn: 1, critical: 2 };

/** Cache TTL the tool's provider applies, where it is documented. Null = not known. */
function cacheTtlMs(e: Pick<UsageEvent, 'tool' | 'model' | 'cache_write_1h_tokens'>): number | null {
  if (e.tool === 'claude_code') return (e.cache_write_1h_tokens ?? 0) > 0 ? 3_600_000 : 300_000;
  if (e.tool === 'opencode' && e.model?.startsWith('anthropic/')) return 300_000;
  return null;
}

export interface LiveSession {
  tool: Tool;
  session_id: string;
  project: string | null;
  git_branch: string | null;
  model: string | null;
  /** Distinct agent threads, the main one included. */
  agents: number;
  calls: number;
  tokens: number;
  cost: number | null;
  errors: number;
  first_ts: number;
  last_ts: number;
  /** Context the latest main-thread call carried, and the window it ran against. */
  context: number;
  context_window: number | null;
  /** Tokens over the trailing five minutes, per minute. */
  tokens_per_min: number;
  last_tools: string | null;
  /** When the prompt cache expires if nothing else is sent; null when the TTL is unknown. */
  cache_expires_at: number | null;
  /** What re-writing the whole context to cache would cost if it has expired — list rate, priced models only. */
  rewarm_cost: number | null;
  incidents: { count: number; worst: Severity | null };
}

/** Sessions with a call inside `sinceMs`; every figure covers the whole session, not just the window. */
export function getLiveSessions(
  db: DB,
  opts: { sinceMs?: number; sessionId?: string; includeSeed?: boolean; now?: number } = {},
): LiveSession[] {
  const now = opts.now ?? Date.now();
  const since = opts.sessionId ? 0 : now - (opts.sinceMs ?? 30 * 60_000);
  const seedClause = opts.includeSeed ? '' : " AND source = 'live'";
  const idClause = opts.sessionId ? ' AND session_id = ?' : '';
  const params: (number | string)[] = [now - 5 * 60_000];
  if (opts.sessionId) params.push(opts.sessionId);
  params.push(since);

  const rows = db
    .prepare(
      `SELECT tool, session_id, MAX(project) AS project, MAX(git_branch) AS git_branch,
              COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN ${TOKEN_FILTER} THEN total_tokens END), 0) AS tokens,
              SUM(cost_usd) AS cost, COALESCE(SUM(is_error), 0) AS errors,
              MIN(ts) AS first_ts, MAX(ts) AS last_ts,
              COUNT(DISTINCT COALESCE(agent_id, '')) AS agents,
              COALESCE(SUM(CASE WHEN ts >= ? AND ${TOKEN_FILTER} THEN total_tokens END), 0) AS recent
       FROM usage_events WHERE session_id IS NOT NULL${idClause}${seedClause}
       GROUP BY tool, session_id HAVING MAX(ts) >= ? ORDER BY last_ts DESC`,
    )
    .all(...params) as {
      tool: Tool; session_id: string; project: string | null; git_branch: string | null;
      calls: number; tokens: number; cost: number | null; errors: number;
      first_ts: number; last_ts: number; agents: number; recent: number;
    }[];

  const latest = db.prepare(
    `SELECT * FROM usage_events WHERE session_id = ? AND tool = ? AND confidence = 'exact'
     ORDER BY (agent_id IS NULL) DESC, ts DESC LIMIT 1`,
  );
  const incidents = db.prepare(
    `SELECT severity FROM anomalies WHERE session_id = ? AND window_end >= ?${seedClause}`,
  );

  return rows.map((r) => {
    const e = latest.get(r.session_id, r.tool) as UsageEvent | undefined;
    const ctx = e ? contextOf(e) : 0;
    const win = e ? windowOf(e) : null;
    const ttl = e ? cacheTtlMs(e) : null;
    const rate = e ? rateFor(e.model) : undefined;
    const sev = (incidents.all(r.session_id, now - 3_600_000) as { severity: Severity }[]).map((x) => x.severity);
    return {
      tool: r.tool,
      session_id: r.session_id,
      project: r.project,
      git_branch: r.git_branch,
      model: e?.model ?? null,
      agents: r.agents,
      calls: r.calls,
      tokens: r.tokens,
      cost: r.cost,
      errors: r.errors,
      first_ts: r.first_ts,
      last_ts: r.last_ts,
      context: ctx,
      context_window: win,
      tokens_per_min: r.recent / 5,
      last_tools: e?.tools ?? null,
      cache_expires_at: ttl && e ? e.ts + ttl : null,
      rewarm_cost: rate && ctx > 0 ? (ctx * rate.input * CACHE_MULTIPLIERS.write5m) / 1e6 : null,
      incidents: {
        count: sev.length,
        worst: sev.length ? sev.reduce((a, b) => ((SEV_RANK[b] ?? 0) > (SEV_RANK[a] ?? 0) ? b : a)) : null,
      },
    };
  });
}

// ── Session drill-down ────────────────────────────────────────────────────────

export interface SessionCall {
  id: number;
  ts: number;
  model: string | null;
  agent_id: string | null;
  tools: string | null;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  /** Context this call carried; null for activity-only rows. */
  context: number | null;
  /** Growth since the previous call on the same agent thread; null for the first. */
  delta: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  stop_reason: string | null;
  is_error: 0 | 1;
  confidence: Confidence;
}

export interface SessionDetail {
  session_id: string;
  tool: Tool;
  project: string | null;
  git_branch: string | null;
  source: string;
  first_ts: number;
  last_ts: number;
  calls: number;
  tokens: number;
  cost: number | null;
  errors: number;
  truncated: number;
  cache_hit_ratio: number | null;
  peak_context: number;
  context_window: number | null;
  models: string[];
  agents: { agent_id: string | null; calls: number; tokens: number; cost: number | null; peak_context: number }[];
  /** The calls that grew the context most, with the tools whose results caused it. */
  bloat: { id: number; ts: number; agent_id: string | null; delta: number; after_tools: string | null }[];
  calls_list: SessionCall[];
  incidents: IncidentRow[];
}

export function getSessionDetail(db: DB, sessionId: string): SessionDetail | null {
  // ponytail: whole session in memory; page it if a session ever exceeds ~10K calls.
  const rows = db
    .prepare('SELECT * FROM usage_events WHERE session_id = ? ORDER BY ts, id')
    .all(sessionId) as (UsageEvent & { id: number })[];
  if (rows.length === 0) return null;

  const prevByAgent = new Map<string, UsageEvent & { id: number }>();
  const calls: SessionCall[] = [];
  const agents = new Map<string, { agent_id: string | null; calls: number; tokens: number; cost: number | null; peak_context: number }>();
  const bloat: SessionDetail['bloat'] = [];
  let cacheRead = 0;
  let freshIn = 0;
  let peak = 0;
  let win: number | null = null;
  const models = new Set<string>();

  for (const r of rows) {
    const key = r.agent_id ?? '';
    const exact = r.confidence !== 'activity_only';
    const ctx = exact ? contextOf(r) : null;
    const prev = prevByAgent.get(key);
    const delta = ctx !== null && prev ? ctx - contextOf(prev) : null;
    if (exact) prevByAgent.set(key, r);
    if (r.model) models.add(r.model);
    if (ctx !== null) {
      peak = Math.max(peak, ctx);
      cacheRead += r.cache_read_tokens ?? 0;
      freshIn += (r.input_tokens ?? 0) + (r.cache_write_5m_tokens ?? 0) + (r.cache_write_1h_tokens ?? 0);
      win = windowOf(r) ?? win;
    }
    const a = agents.get(key) ?? { agent_id: r.agent_id, calls: 0, tokens: 0, cost: null, peak_context: 0 };
    a.calls++;
    a.tokens += exact ? (r.total_tokens ?? 0) : 0;
    if (r.cost_usd !== null) a.cost = (a.cost ?? 0) + r.cost_usd;
    if (ctx !== null) a.peak_context = Math.max(a.peak_context, ctx);
    agents.set(key, a);
    if (delta !== null && delta > 0 && prev) {
      bloat.push({ id: r.id, ts: r.ts, agent_id: r.agent_id, delta, after_tools: prev.tools });
    }
    calls.push({
      id: r.id, ts: r.ts, model: r.model, agent_id: r.agent_id, tools: r.tools,
      input: r.input_tokens, output: r.output_tokens, cache_read: r.cache_read_tokens,
      cache_write: exact ? (r.cache_write_5m_tokens ?? 0) + (r.cache_write_1h_tokens ?? 0) : null,
      context: ctx, delta, total_tokens: r.total_tokens, cost_usd: r.cost_usd,
      stop_reason: r.stop_reason, is_error: r.is_error, confidence: r.confidence,
    });
  }

  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const costs = rows.map((r) => r.cost_usd).filter((c): c is number => c !== null);
  const denom = cacheRead + freshIn;
  return {
    session_id: sessionId,
    tool: first.tool,
    project: rows.find((r) => r.project)?.project ?? null,
    git_branch: rows.find((r) => r.git_branch)?.git_branch ?? null,
    source: first.source,
    first_ts: first.ts,
    last_ts: last.ts,
    calls: rows.length,
    tokens: rows.reduce((s, r) => s + (r.confidence !== 'activity_only' ? (r.total_tokens ?? 0) : 0), 0),
    cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    errors: rows.reduce((s, r) => s + r.is_error, 0),
    truncated: rows.filter((r) => r.stop_reason === 'max_tokens' || r.stop_reason === 'length').length,
    cache_hit_ratio: denom > 0 ? cacheRead / denom : null,
    peak_context: peak,
    context_window: win,
    models: [...models],
    agents: [...agents.values()].sort((a, b) => b.tokens - a.tokens),
    bloat: bloat.sort((a, b) => b.delta - a.delta).slice(0, 8),
    calls_list: calls,
    incidents: db
      .prepare(
        `SELECT id, rule, severity, tool, session_id, model, window_start, window_end,
                title, detail, confidence, source
         FROM anomalies WHERE session_id = ? ORDER BY window_start DESC`,
      )
      .all(sessionId) as IncidentRow[],
  };
}

// ── Cache re-warm accounting ──────────────────────────────────────────────────

export interface RewarmRow {
  tool: Tool;
  model: string | null;
  /** Calls that followed an idle gap longer than the cache TTL and wrote to cache. */
  gaps: number;
  tokens: number;
  cost: number | null;
}

export interface RewarmSummary {
  gaps: number;
  tokens: number;
  cost: number | null;
  byModel: RewarmRow[];
}

/**
 * Cache writes that happened on the first call after an idle gap longer than the TTL —
 * content that was already cached and had to be written again because nobody sent a
 * message in time. Exact tokens; cost at list rate where the model is priced. Only
 * tools with a priced, documented cache-write concept (Claude Code; OpenCode on
 * Anthropic models) take part.
 */
export function getCacheRewarm(db: DB, range: Range, includeSeed: boolean): RewarmSummary {
  const from = rangeStart(range);
  const seedClause = includeSeed ? '' : " AND source = 'live'";
  const rows = db
    .prepare(
      // The LAG scans whole sessions so a gap is found even when its start predates the
      // range; the range then applies to the re-warm call itself.
      `WITH o AS (
         SELECT tool, model, ts, cache_write_5m_tokens AS w5, cache_write_1h_tokens AS w1,
                ts - LAG(ts) OVER (PARTITION BY session_id, COALESCE(agent_id, '') ORDER BY ts) AS gap
         FROM usage_events
         WHERE confidence = 'exact' AND session_id IS NOT NULL${seedClause}
           AND (tool = 'claude_code' OR (tool = 'opencode' AND model LIKE 'anthropic/%'))
       )
       SELECT tool, model, COUNT(*) AS gaps,
              COALESCE(SUM(CASE WHEN gap > 300000 THEN w5 ELSE 0 END), 0) AS w5,
              COALESCE(SUM(CASE WHEN gap > 3600000 THEN w1 ELSE 0 END), 0) AS w1
       FROM o
       WHERE ts >= ? AND ((gap > 300000 AND w5 > 0) OR (gap > 3600000 AND w1 > 0))
       GROUP BY tool, model ORDER BY (w5 + w1) DESC`,
    )
    .all(from) as { tool: Tool; model: string | null; gaps: number; w5: number; w1: number }[];

  const byModel: RewarmRow[] = rows.map((r) => ({
    tool: r.tool,
    model: r.model,
    gaps: r.gaps,
    tokens: r.w5 + r.w1,
    cost: computeCost(r.model, { cache_write_5m_tokens: r.w5, cache_write_1h_tokens: r.w1 }),
  }));
  const costs = byModel.map((r) => r.cost).filter((c): c is number => c !== null);
  return {
    gaps: byModel.reduce((s, r) => s + r.gaps, 0),
    tokens: byModel.reduce((s, r) => s + r.tokens, 0),
    cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    byModel,
  };
}

// ── What-if repricing ─────────────────────────────────────────────────────────

/** ponytail: fixed comparison set; make it a pricing.json key if anyone asks. */
export const WHATIF_MODELS = ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

export interface WhatIfRow {
  tool: Tool;
  model: string | null;
  calls: number;
  tokens: number;
  /** What was actually recorded (null when the model has no rate). */
  actual: number | null;
  /** The same exact token split priced at each comparison model's list rate. */
  alternatives: Record<string, number | null>;
}

/**
 * Arithmetic only: the exact input / output / cache split of every call, multiplied by
 * another model's published rates. It says what the tokens would have cost, and
 * nothing about whether that model would have done the job.
 */
export function getWhatIf(db: DB, range: Range, includeSeed: boolean): WhatIfRow[] {
  const from = rangeStart(range);
  const seedClause = includeSeed ? '' : " AND source = 'live'";
  const rows = db
    .prepare(
      `SELECT tool, model, COUNT(*) AS calls, SUM(total_tokens) AS tokens, SUM(cost_usd) AS actual,
              SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(cache_write_5m_tokens) AS cache_write_5m_tokens,
              SUM(cache_write_1h_tokens) AS cache_write_1h_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens
       FROM usage_events
       WHERE ts >= ? AND confidence = 'exact' AND input_tokens IS NOT NULL${seedClause}
       GROUP BY tool, model ORDER BY tokens DESC LIMIT 12`,
    )
    .all(from) as ({ tool: Tool; model: string | null; calls: number; tokens: number; actual: number | null } &
      Parameters<typeof computeCost>[1])[];
  return rows.map((r) => ({
    tool: r.tool,
    model: r.model,
    calls: r.calls,
    tokens: r.tokens,
    actual: r.actual,
    alternatives: Object.fromEntries(WHATIF_MODELS.map((m) => [m, computeCost(m, r)])),
  }));
}

// ── Digest ────────────────────────────────────────────────────────────────────

export interface Digest {
  range: Range;
  from: number;
  to: number;
  summary: Summary;
  rewarm: RewarmSummary;
  topProjects: BreakdownRow[];
  topModels: BreakdownRow[];
  incidents: { total: number; critical: number; warn: number; byRule: Record<string, number> };
  biggestSession: { session_id: string; tool: Tool; project: string | null; calls: number; tokens: number; cost: number | null } | null;
  busiestDay: { bucket: number; tokens: number } | null;
}

/** "Your agent week": everything the other queries know, in one shareable object. */
export function getDigest(db: DB, range: Range, includeSeed: boolean, now = Date.now()): Digest {
  const from = rangeStart(range, now);
  const seedClause = includeSeed ? '' : " AND source = 'live'";
  const incidents = getAnomalies(db, range, includeSeed, 10_000);
  const byRule: Record<string, number> = {};
  for (const a of incidents) byRule[a.rule] = (byRule[a.rule] ?? 0) + 1;
  const biggest = db
    .prepare(
      `SELECT session_id, tool, MAX(project) AS project, COUNT(*) AS calls,
              COALESCE(SUM(CASE WHEN ${TOKEN_FILTER} THEN total_tokens END), 0) AS tokens, SUM(cost_usd) AS cost
       FROM usage_events WHERE ts >= ? AND session_id IS NOT NULL${seedClause}
       GROUP BY tool, session_id ORDER BY tokens DESC LIMIT 1`,
    )
    .get(from) as Digest['biggestSession'] | undefined;
  const days = getTimeseries(db, range, includeSeed, now)
    .map((p) => ({ bucket: p.bucket, tokens: (Object.keys(ZERO_BY_TOOL) as Tool[]).reduce((s, t) => s + (p[t] ?? 0), 0) }))
    .sort((a, b) => b.tokens - a.tokens);
  return {
    range,
    from,
    to: now,
    summary: getSummary(db, range, includeSeed),
    rewarm: getCacheRewarm(db, range, includeSeed),
    topProjects: getBreakdown(db, range, includeSeed, 'project').filter((r) => r.model).slice(0, 5),
    topModels: getBreakdown(db, range, includeSeed, 'model').slice(0, 5),
    incidents: {
      total: incidents.length,
      critical: incidents.filter((a) => a.severity === 'critical').length,
      warn: incidents.filter((a) => a.severity === 'warn').length,
      byRule,
    },
    biggestSession: biggest ?? null,
    busiestDay: days[0] && days[0].tokens > 0 ? days[0] : null,
  };
}

// ── the deep-completion read models (integration phase, tiers 3-8) ─────────
//
// Each surface the tier docs name for a reader: the People view's principal
// dimension, the ungated-call KPI, Blast Radius over the action-target and
// child ledgers, the Files tab's write classes, the ingress band, the posture
// ribbon, server-tool billing, observation lag and the Grok bulk-egress card.
// Every figure is verbatim from its ledger; NULL means unknown, never 0.

export interface PrincipalSummaryRow {
  principal_key: string;
  display: string;
  sessions: number;
  calls: number;
  tokens: number | null;
  cost_usd: number | null;
  incidents: { info: number; warn: number; critical: number };
  /** binding triple: session_proved / ambient / unbound (+ sessions with no identity row at all) */
  binding: { session_proved: number; ambient: number; unbound: number; no_identity_row: number };
  account_classes: { tool: Tool | null; account_class: string | null; sessions: number }[];
}

/**
 * The People view's principal dimension. The join is pure SQL, never a hash in
 * the reader: usage_events.session_id -> session_identity.principal_key ->
 * principals. (The old join matched the cleartext usage_events.user against
 * the keyed principals.principal_key — p:<HMAC> — and matched nothing.)
 * MUST stay in lockstep with DB.swift byPrincipal().
 */
export function getByPrincipal(db: DB, _range: Range, includeSeed: boolean): {
  principals: PrincipalSummaryRow[];
  originUnknown: { calls: number; tokens: number | null };
} {
  const src = includeSeed ? '' : "AND e.source = 'live'";
  const keys = db
    .prepare(
      `SELECT DISTINCT si.principal_key FROM usage_events e
       JOIN session_identity si ON si.session_id = e.session_id
       WHERE si.principal_key IS NOT NULL ${src}`,
    )
    .all() as { principal_key: string }[];
  const principals: PrincipalSummaryRow[] = [];
  for (const { principal_key: key } of keys) {
    const p = db
      .prepare('SELECT principal_key, display FROM principals WHERE principal_key = ?')
      .get(key) as { principal_key: string; display: string } | undefined;
    const agg = db
      .prepare(
        `SELECT COUNT(DISTINCT e.session_id) AS sessions, COUNT(*) AS calls,
                SUM(e.total_tokens) AS tokens, SUM(e.cost_usd) AS cost
         FROM usage_events e JOIN session_identity si ON si.session_id = e.session_id
         WHERE si.principal_key = ? ${src}`,
      )
      .get(key) as { sessions: number; calls: number; tokens: number | null; cost_usd: number | null };
    const inc = db
      .prepare(
        `SELECT severity, COUNT(*) AS n FROM anomalies a
         JOIN session_identity si ON si.session_id = a.session_id
         WHERE si.principal_key = ? GROUP BY severity`,
      )
      .all(key) as { severity: string; n: number }[];
    const classes = db
      .prepare(
        `SELECT tool, account_class, COUNT(DISTINCT session_id) AS n FROM session_identity
         WHERE principal_key = ? GROUP BY tool, account_class ORDER BY n DESC`,
      )
      .all(key) as { tool: Tool | null; account_class: string | null; n: number }[];
    const bind = db
      .prepare('SELECT binding_evidence, COUNT(*) AS n FROM session_identity WHERE principal_key = ? GROUP BY binding_evidence')
      .all(key) as { binding_evidence: string | null; n: number }[];
    const binding = { session_proved: 0, ambient: 0, unbound: 0, no_identity_row: 0 };
    for (const b of bind) {
      if (b.binding_evidence === 'session_proved') binding.session_proved = b.n;
      else if (b.binding_evidence === 'ambient') binding.ambient = b.n;
      else binding.unbound += b.n;
    }
    // no_identity_row is 0 by construction: every session counted here was
    // reached THROUGH its session_identity row. Live sessions with no
    // identity row at all fall to the origin-unknown bucket below.
    principals.push({
      principal_key: p?.principal_key ?? `unknown:${key}`,
      display: p?.display ?? key,
      sessions: agg.sessions,
      calls: agg.calls,
      tokens: agg.tokens,
      cost_usd: agg.cost_usd,
      incidents: {
        info: inc.find((i) => i.severity === 'info')?.n ?? 0,
        warn: inc.find((i) => i.severity === 'warn')?.n ?? 0,
        critical: inc.find((i) => i.severity === 'critical')?.n ?? 0,
      },
      binding,
      account_classes: classes.map((c) => ({ tool: c.tool, account_class: c.account_class, sessions: c.n })),
    });
  }
  const unknown = db
    .prepare(
      `SELECT COUNT(*) AS calls, SUM(e.total_tokens) AS tokens
       FROM usage_events e LEFT JOIN session_identity si ON si.session_id = e.session_id
       WHERE si.principal_key IS NULL ${src}`,
    )
    .get() as { calls: number; tokens: number | null };
  return { principals: principals.sort((a, b) => b.calls - a.calls || (a.principal_key < b.principal_key ? -1 : 1)), originUnknown: { calls: unknown.calls, tokens: unknown.tokens } };
}

/** The ungated-call KPI: calls that ran with no gate at all (bypass_no_gate). */
export function ungatedCalls(db: DB, range: Range): { calls: number; totalCalls: number } {
  const from = rangeStart(range);
  const total = (db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE ts >= ?').get(from) as { n: number }).n;
  const ungated = (db
    .prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE ts >= ? AND authorization_basis = 'bypass_no_gate'")
    .get(from) as { n: number }).n;
  return { calls: ungated, totalCalls: total };
}

export interface BlastRadiusRow {
  target_kind: string;
  target_label: string | null;
  locality: string | null;
  env_class: string | null;
  calls: number;
  /** child-ledger corroboration: writes / vcs / packages touching the same scope */
  writes: number;
  vcs_actions: number;
  package_execs: number;
}

/** Blast Radius: action_targets joined to the child ledgers' scope reach. */
export function blastRadius(db: DB, range: Range): BlastRadiusRow[] {
  const from = rangeStart(range);
  const targets = db
    .prepare(
      `SELECT target_kind, target_label, locality, env_class, COUNT(DISTINCT call_key) AS calls
       FROM action_targets WHERE last_seen >= ? GROUP BY target_kind, target_label, locality, env_class`,
    )
    .all(from) as BlastRadiusRow[];
  const writeTotal = (db
    .prepare('SELECT COUNT(*) AS n FROM file_writes WHERE ts >= ?')
    .get(from) as { n: number }).n;
  const scopeCount = (sql: string): number =>
    (db.prepare(sql).get(from) as { n: number }).n;
  const vcs = scopeCount('SELECT COUNT(*) AS n FROM vcs_actions WHERE ts >= ?');
  const pkgs = scopeCount('SELECT COUNT(*) AS n FROM package_execs WHERE ts >= ?');
  return targets
    .map((t) => ({ ...t, writes: writeTotal, vcs_actions: vcs, package_execs: pkgs }))
    .sort((a, b) => b.calls - a.calls || (a.target_kind < b.target_kind ? -1 : 1));
}

/** The Files tab: writes split by write_class, unresolved targets counted, never dropped. */
export function filesByWriteClass(db: DB, range: Range): { write_class: string; writes: number; unresolved: number }[] {
  const from = rangeStart(range);
  const rows = db
    .prepare(
      `SELECT COALESCE(write_class, 'unresolved') AS write_class, COUNT(*) AS n
       FROM file_writes WHERE ts >= ? GROUP BY write_class ORDER BY n DESC`,
    )
    .all(from) as { write_class: string; n: number }[];
  const unresolved = (db
    .prepare('SELECT COUNT(*) AS n FROM file_writes WHERE ts >= ? AND path IS NULL')
    .get(from) as { n: number }).n;
  return rows.map((r) => ({ write_class: r.write_class, writes: r.n, unresolved }));
}

/** The ingress band: fetch ingress by host, with NULL-status counts (unknown, not zero). */
export function ingressBand(db: DB, range: Range): { url_host: string | null; calls: number; bytes: number | null; statusUnknown: number }[] {
  const from = rangeStart(range);
  return db
    .prepare(
      `SELECT url_host, COUNT(*) AS calls, SUM(bytes) AS bytes,
              SUM(CASE WHEN status IS NULL THEN 1 ELSE 0 END) AS statusUnknown
       FROM fetch_ingress WHERE ts >= ? GROUP BY url_host ORDER BY calls DESC`,
    )
    .all(from) as { url_host: string | null; calls: number; bytes: number | null; statusUnknown: number }[];
}

export interface PostureRibbonRow {
  session_id: string;
  autonomy: string | null;
  started_at: number;
  ended_at: number;
  calls: number;
  denied: number;
  errors: number;
  mode_raw: string | null;
}

/** The posture ribbon: the autonomy timeline, newest intervals first. */
export function postureRibbon(db: DB, range: Range, limit = 200): PostureRibbonRow[] {
  const from = rangeStart(range);
  return db
    .prepare(
      `SELECT session_id, autonomy, started_at, ended_at, calls, denied, errors, mode_raw
       FROM autonomy_intervals WHERE ended_at >= ? ORDER BY ended_at DESC LIMIT ?`,
    )
    .all(from, limit) as PostureRibbonRow[];
}

/** Server-tool billing: the event_links request counters the vendors bill on. */
export function serverToolBilling(db: DB, range: Range): { link_kind: string; requests: number }[] {
  const from = rangeStart(range);
  return db
    .prepare(
      `SELECT link_kind, SUM(CAST(link_id AS INTEGER)) AS requests FROM event_links
       WHERE link_kind IN ('web_search_requests','web_fetch_requests') AND first_seen >= ? GROUP BY link_kind`,
    )
    .all(from) as { link_kind: string; requests: number }[];
}

export interface ObservationLagRow {
  tool: Tool;
  p50_ms: number | null;
  p95_ms: number | null;
  observed_rows: number;
}

/** Observation lag: per tool, observed_at minus ts (the collection-delay read model). */
export function observationLag(db: DB, range: Range): ObservationLagRow[] {
  const from = rangeStart(range);
  const rows = db
    .prepare(
      `SELECT tool, observed_at - ts AS lag FROM usage_events
       WHERE ts >= ? AND observed_at IS NOT NULL AND source = 'live'`,
    )
    .all(from) as { tool: Tool; lag: number }[];
  const byTool = new Map<Tool, number[]>();
  for (const r of rows) {
    const arr = byTool.get(r.tool);
    if (arr) arr.push(r.lag);
    else byTool.set(r.tool, [r.lag]);
  }
  const pct = (sorted: number[], p: number): number | null =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : null;
  return [...byTool.entries()]
    .map(([tool, lags]) => {
      const sorted = [...lags].sort((a, b) => a - b);
      return { tool, p50_ms: pct(sorted, 50), p95_ms: pct(sorted, 95), observed_rows: sorted.length };
    })
    .sort((a, b) => (a.tool < b.tool ? -1 : 1));
}

export interface BulkEgressRow {
  upload_key: string;
  repo_path: string | null;
  turn: number | null;
  max_file_bytes: number | null;
  /** NULL = never enqueued — the count the Bulk Egress card prints. */
  size_bytes: number | null;
  gcs_path: string | null;
  blobs: number | null;
  uploads_enabled: number | null;
  upload_reason: string | null;
  telemetry_source: string | null;
}

/** Grok's repo_state uploads (tier 5 #7): the Bulk Egress card on Posture. */
export function bulkEgress(db: DB): BulkEgressRow[] {
  return db
    .prepare(
      `SELECT b.upload_key, b.repo_path, b.turn, b.max_file_bytes, b.size_bytes, b.gcs_path, b.blobs,
              d.uploads_enabled, d.upload_reason, d.telemetry_source
       FROM bulk_uploads b LEFT JOIN upload_decisions d ON d.upload_key = b.upload_key
       ORDER BY b.started_at DESC`,
    )
    .all() as BulkEgressRow[];
}

/** The MCP dimension: configured servers grouped by identity, observed-only split. */
export function mcpServersGroup(db: DB): { server_name: string; mcp_identity: string; clients: number; transport: string | null; enabled: number | null }[] {
  return db
    .prepare(
      `SELECT server_name, mcp_identity, COUNT(DISTINCT client) AS clients, transport, MAX(enabled) AS enabled
       FROM posture_mcp_servers GROUP BY server_name, mcp_identity, transport
       ORDER BY server_name`,
    )
    .all() as { server_name: string; mcp_identity: string; clients: number; transport: string | null; enabled: number | null }[];
}

export interface AiSurfaceRow {
  surface_key: string;
  kind: string;
  name: string;
  path: string | null;
  sanctioned: string | null;
  version: string | null;
  first_seen: number;
  last_seen: number;
}

/** The ai_surfaces read model (the audit's missing getAiSurfaces). */
export function getAiSurfaces(db: DB, kind?: string): AiSurfaceRow[] {
  const rows = kind
    ? db.prepare('SELECT surface_key, kind, name, path, sanctioned, version, first_seen, last_seen FROM ai_surfaces WHERE kind = ? ORDER BY surface_key').all(kind)
    : db.prepare('SELECT surface_key, kind, name, path, sanctioned, version, first_seen, last_seen FROM ai_surfaces ORDER BY surface_key').all();
  return rows as AiSurfaceRow[];
}
