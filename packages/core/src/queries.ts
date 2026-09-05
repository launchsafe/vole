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
              MIN(confidence) AS confidence
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
  rule: string;
  severity: string;
  tool: Tool;
  session_id: string | null;
  model: string | null;
  window_start: number;
  window_end: number;
  title: string;
  detail: string;
  confidence: Confidence;
  source: string;
}

// ponytail: the dashboard counts what this returns, so the cap is the count's ceiling;
// add a COUNT(*) alongside if a feed ever outgrows it.
export function getAnomalies(db: DB, range: Range, includeSeed: boolean, limit = 500): IncidentRow[] {
  const from = rangeStart(range);
  const seedClause = includeSeed ? '' : " AND source = 'live'";
  return db
    .prepare(
      `SELECT id, rule, severity, tool, session_id, model, window_start, window_end,
              title, detail, confidence, source
       FROM anomalies WHERE window_end >= ?${seedClause}
       ORDER BY window_start DESC LIMIT ?`,
    )
    .all(from, limit) as IncidentRow[];
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
