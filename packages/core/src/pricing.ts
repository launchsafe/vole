/**
 * Equivalent-API-value pricing.
 *
 * These are Anthropic list rates. On a Claude subscription plan you are NOT billed per
 * token, so every dollar figure in this product is "what this usage would have cost at
 * list price" and is labelled as such in the UI. It is a magnitude signal, not a bill.
 *
 * The rates live in a data file (./data/pricing.json), not in code, so new models can be
 * added without a release. A per-installation override file (~/.vole/pricing.json, or
 * $VOLE_PRICING) is merged on top: any model it defines wins, and it may add models the
 * built-in table lacks. A malformed override is ignored — pricing must never break
 * collection.
 */
import { existsSync, readFileSync } from 'node:fs';
import builtin from './data/pricing.json';
import { paths } from './paths';

export interface ModelRate {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read tokens, when a model deviates from the global read multiplier. */
  cache_read?: number;
  effective_from: string;
  note?: string;
}

interface PricingFile {
  cache_multipliers: { read: number; write5m: number; write1h: number };
  models: Record<string, ModelRate>;
  /** Tokens of context each model accepts, keyed like `models`. */
  context_windows: Record<string, number>;
  unpriced: Record<string, string>;
}

const BUILTIN = builtin as PricingFile;

function loadPricing(): PricingFile {
  const file = paths.pricingOverride();
  try {
    if (!existsSync(file)) return BUILTIN;
    const o = JSON.parse(readFileSync(file, 'utf8')) as Partial<PricingFile>;
    return {
      cache_multipliers: { ...BUILTIN.cache_multipliers, ...(o.cache_multipliers ?? {}) },
      models: { ...BUILTIN.models, ...(o.models ?? {}) },
      context_windows: { ...BUILTIN.context_windows, ...(o.context_windows ?? {}) },
      unpriced: { ...BUILTIN.unpriced, ...(o.unpriced ?? {}) },
    };
  } catch {
    return BUILTIN;
  }
}

const P = loadPricing();

/**
 * Cache pricing is a fixed multiple of the model's base input rate, so one table covers
 * every model. Verified against current Anthropic docs rather than recalled.
 */
export const CACHE_MULTIPLIERS = P.cache_multipliers;

export const PRICING: Record<string, ModelRate> = P.models;

/**
 * Models we knowingly cannot price. Kept explicit so the UI can distinguish
 * "we have exact tokens but no rate" from "we failed to parse this".
 */
export const UNPRICED_MODELS: Record<string, string> = P.unpriced;

/**
 * Looks up a rate by model id. Dated snapshot ids (`claude-haiku-4-5-20251001`) are priced
 * as their alias — the suffix names the same model at the same rate.
 */
export function rateFor(model: string | null): ModelRate | undefined {
  if (!model) return undefined;
  return PRICING[model] ?? PRICING[model.replace(/-\d{8}$/, '')];
}

/**
 * Context window for a model id, or null when it is not known — never a guess. Only
 * first-party ids resolve: an OpenCode `provider/model` id resolves only for the
 * `anthropic` provider, because a proxy provider may cap the window below the
 * model's own. Codex reports its window per event, so its rows never come here.
 */
export function contextWindow(model: string | null): number | null {
  if (!model) return null;
  let id = model;
  const slash = id.indexOf('/');
  if (slash !== -1) {
    if (!id.startsWith('anthropic/')) return null;
    id = id.slice(slash + 1);
  }
  id = id.replace(/-\d{8}$/, '').replace(/(\d)\.(\d)/g, '$1-$2');
  return P.context_windows[id] ?? null;
}

export interface TokenCounts {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_write_5m_tokens?: number | null;
  cache_write_1h_tokens?: number | null;
  cache_read_tokens?: number | null;
}

/**
 * Exact cost, not an approximation: Claude Code reports cache creation already split by
 * TTL, so each component is multiplied by its own real rate.
 *
 * Returns null when the model is unknown or deliberately unpriced. Callers must render
 * null as an em dash, never coerce it to 0.
 */
export function computeCost(model: string | null, t: TokenCounts): number | null {
  const rate = rateFor(model);
  if (!rate) return null;

  const input = t.input_tokens ?? 0;
  const output = t.output_tokens ?? 0;
  const w5m = t.cache_write_5m_tokens ?? 0;
  const w1h = t.cache_write_1h_tokens ?? 0;
  const read = t.cache_read_tokens ?? 0;

  const usd =
    (input * rate.input +
      w5m * rate.input * CACHE_MULTIPLIERS.write5m +
      w1h * rate.input * CACHE_MULTIPLIERS.write1h +
      read * (rate.cache_read ?? rate.input * CACHE_MULTIPLIERS.read) +
      output * rate.output) /
    1_000_000;

  return usd;
}

/** Human-readable reason a model has no cost, for tooltips. */
export function unpricedReason(model: string | null): string | null {
  if (!model) return 'No model recorded.';
  if (rateFor(model)) return null;
  return UNPRICED_MODELS[model] ?? `No published rate loaded for "${model}".`;
}

// ── cost_basis: which definition of a dollar a cost_usd carries (tier 8 #2) ───

/**
 * A cost_usd is meaningless without naming which dollar it counts. Three
 * definitions exist in the store today, and v1's bare SUM mixed them:
 * - anthropic_list    — what the usage would have cost at Anthropic list price
 *                       (computeCost). Claude Code rows.
 * - provider_reported — the provider's own figure from its own store
 *                       (opencode.ts:143 reads data.cost). OpenCode rows.
 * - declared_unit     — priced through an admin's ~/.vole/units.json
 *                       declaration (tier 8 #27). No writer yet until
 *                       integration wires the conversion; kept in the union so
 *                       the encoder and read models recognise it.
 * NULL = no dollar definition at all (unpriced rows, activity-only rows).
 */
export type CostBasis = 'anthropic_list' | 'provider_reported' | 'declared_unit';

/** The basis a tool's non-NULL cost_usd carries. NULL = the tool's costs, if any, carry no basis this code can name. */
export function basisFor(tool: string): CostBasis | null {
  if (tool === 'claude_code') return 'anthropic_list';
  if (tool === 'opencode') return 'provider_reported';
  return null;
}

/**
 * The one-shot widening UPDATE the spec demands (tier 8 #2 limit): historical
 * rows have no basis and must be stamped NULL-only — never re-derived over a
 * stored value — and the collect loop's upsert cannot do it (it only rewrites
 * a row when total_tokens grows). Keyed on event_key's table column; safe to
 * run repeatedly, a no-op once every row is stamped.
 */
export function stampCostBasis(db: {
  prepare(sql: string): { run(...p: unknown[]): { changes: number } };
}): number {
  const r = db
    .prepare(
      `UPDATE usage_events SET cost_basis = CASE tool
         WHEN 'claude_code' THEN 'anthropic_list'
         WHEN 'opencode' THEN 'provider_reported'
       END
       WHERE cost_basis IS NULL AND tool IN ('claude_code', 'opencode')`,
    )
    .run();
  return r.changes;
}

// ── uncosted classification: local and free-tier, never $0.00 (tier 8 #25) ───

export type UncostedClass = 'local' | 'free_tier' | 'uncosted_unknown';

/**
 * A provider-reported 0.0 is ambiguous between genuinely-free, not-yet-computed
 * and self-hosted, so only the classes with CONFIDENT local evidence are
 * distinguished — a loopback/runtime provider id is local (an H200 running a
 * 27B model has a real hourly cost nobody billed), an OpenRouter `:free` id is
 * a rate-limited free-tier entitlement — and everything else is
 * uncosted-unknown rather than a guess. All three render an em dash, never
 * $0.00.
 */
export function uncostedClass(model: string | null): UncostedClass {
  if (!model) return 'uncosted_unknown';
  const id = model.toLowerCase();
  if (/(^|\/)(ollama|lmstudio|llamacpp|local)(\/|$)/.test(id) || /qwen-h200|unsloth-studio/.test(id)) return 'local';
  if (id.endsWith(':free')) return 'free_tier';
  return 'uncosted_unknown';
}

// ── cache economics: the 5m-versus-1h split (tier 8 #18) ─────────────────────

export interface CacheClassTotals {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_write_5m_tokens: number | null;
  cache_write_1h_tokens: number | null;
  cache_read_tokens: number | null;
}

export interface CacheEconomics {
  /** What re-warming today's context would cost, priced per TTL class (fixes the always-×write5m bug). */
  rewarm_usd_5m: number | null;
  rewarm_usd_1h: number | null;
  /** Cache-read tokens over fresh input tokens — the hit ratio. NULL when either side is unknown. */
  read_fresh_ratio: number | null;
  /** The three vendor-billed multipliers the bars render. */
  multipliers: { read: number; write5m: number; write1h: number };
  /** Split is only observable where the tool reports both TTL classes; NULL when the tool cannot. */
  ttl_split_observed: boolean;
}

/**
 * Cache economics over a token aggregate, for the model given. The re-warm
 * cost prices each TTL class with its own multiplier — v1 multiplied 1h writes
 * by the 5m rate (queries.ts rewarm_cost), under-pricing by the 1h premium.
 * Returns NULL dollars (never 0) when the model is unpriced.
 */
export function cacheEconomics(model: string | null, t: Partial<CacheClassTotals>): CacheEconomics {
  const rate = rateFor(model);
  const read = t.cache_read_tokens ?? 0;
  const fresh = t.input_tokens ?? 0;
  const split =
    (t.cache_write_5m_tokens !== null && t.cache_write_5m_tokens !== undefined) ||
    (t.cache_write_1h_tokens !== null && t.cache_write_1h_tokens !== undefined);
  return {
    rewarm_usd_5m: rate ? (t.cache_write_5m_tokens ?? 0) * rate.input * CACHE_MULTIPLIERS.write5m / 1_000_000 : null,
    rewarm_usd_1h: rate ? (t.cache_write_1h_tokens ?? 0) * rate.input * CACHE_MULTIPLIERS.write1h / 1_000_000 : null,
    read_fresh_ratio: fresh > 0 ? read / fresh : null,
    multipliers: CACHE_MULTIPLIERS,
    ttl_split_observed: split,
  };
}

/**
 * The burn-rate rule's exposure number (tier 8 #18): cache reads are billed at
 * 0.1×, so raw total_tokens lets a window that is ~99% cache reads fire the
 * same as one that is all fresh tokens. Billable exposure counts fresh input
 * plus output only. NULL propagates — no tokens, no number.
 */
export function billableTokens(t: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  /** Cache reads are billed at the cache-read rate, not the input rate — excluded here. */
  cache_read_tokens?: number | null;
}): number | null {
  if (t.input_tokens == null && t.output_tokens == null) return null;
  return (t.input_tokens ?? 0) + (t.output_tokens ?? 0);
}

// ── budgets scoped by cost_basis, with the indeterminate verdict (tier 8 #29) ─

export interface BudgetDeclaration {
  /** All present keys must match the row (project prefix, model, tool, user). Absent = unconstrained. */
  scope: { project?: string; model?: string; tool?: string; user?: string };
  /** Which dollar a limit_usd counts. Required for a USD limit; a token budget omits it (or sets null). */
  cost_basis?: CostBasis | null;
  limit_usd?: number;
  limit_tokens?: number;
  /** Trailing window in days (default 30). */
  window_days?: number;
  note?: string;
  author?: string;
}

export type BudgetVerdict = 'ok' | 'exceeded' | 'indeterminate';

export interface BudgetResult {
  scope: BudgetDeclaration['scope'];
  cost_basis: CostBasis | null;
  limit_usd: number | null;
  limit_tokens: number | null;
  spent_usd: number | null;
  spent_tokens: number | null;
  window_start: number;
  /** Exact-confidence calls in scope whose cost_usd is NULL — the calls the percentage silently drops. */
  unpriced_calls: number;
  /** Activity-only calls in scope — uncountable by a token budget. */
  uncounted_calls: number;
  verdict: BudgetVerdict;
}

/**
 * Evaluates one declaration against a window of live rows. A budget binds only
 * on rows sharing its basis: burn is summed over cost_basis = the declared
 * basis and nothing else, so an anthropic_list budget for a repo never absorbs
 * OpenCode's provider dollars. Where the scope holds unpriced exact calls
 * (or, for a token budget, activity-only calls), the verdict is
 * `indeterminate` — refusing to show a percentage is the feature, not a
 * limitation to engineer around.
 */
export function evaluateBudget(
  decl: BudgetDeclaration,
  rows: {
    tool: string;
    model: string | null;
    project: string | null;
    user: string | null;
    cost_usd: number | null;
    cost_basis: string | null;
    total_tokens: number | null;
    confidence: string;
  }[],
  windowStart: number,
): BudgetResult {
  const inScope = rows.filter(
    (r) =>
      (!decl.scope.project || (r.project ?? '').startsWith(decl.scope.project)) &&
      (!decl.scope.model || r.model === decl.scope.model) &&
      (!decl.scope.tool || r.tool === decl.scope.tool) &&
      (!decl.scope.user || r.user === decl.scope.user),
  );
  const basisRows = decl.limit_usd != null ? inScope.filter((r) => r.cost_basis === decl.cost_basis) : [];
  const spent_usd = decl.limit_usd != null ? basisRows.reduce((s, r) => s + (r.cost_usd ?? 0), 0) : null;
  const spent_tokens = decl.limit_tokens != null
    ? inScope.reduce((s, r) => s + (r.total_tokens ?? 0), 0)
    : null;
  const unpriced_calls = inScope.filter((r) => r.confidence === 'exact' && r.cost_usd == null).length;
  const uncounted_calls = decl.limit_tokens != null ? inScope.filter((r) => r.confidence === 'activity_only').length : 0;
  let verdict: BudgetVerdict;
  if (decl.limit_usd != null) verdict = unpriced_calls > 0 ? 'indeterminate' : (spent_usd ?? 0) > decl.limit_usd ? 'exceeded' : 'ok';
  else if (decl.limit_tokens != null) verdict = uncounted_calls > 0 ? 'indeterminate' : (spent_tokens ?? 0) > decl.limit_tokens ? 'exceeded' : 'ok';
  else verdict = 'indeterminate';
  return {
    scope: decl.scope,
    cost_basis: decl.cost_basis ?? null,
    limit_usd: decl.limit_usd ?? null,
    limit_tokens: decl.limit_tokens ?? null,
    spent_usd,
    spent_tokens,
    window_start: windowStart,
    unpriced_calls,
    uncounted_calls,
    verdict,
  };
}

/** Reads budget declarations from the policy paths (first file that parses wins; a malformed file yields []). */
export function loadBudgets(read: (p: string) => string | null, paths: string[]): BudgetDeclaration[] {
  for (const p of paths) {
    const text = read(p);
    if (text == null) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      const arr = Array.isArray(parsed) ? parsed : (parsed as { budgets?: unknown[] }).budgets;
      if (Array.isArray(arr)) return arr.filter((d): d is BudgetDeclaration => {
        const b = d as BudgetDeclaration;
        return b != null && typeof b === 'object' && b.scope != null && typeof b.scope === 'object';
      });
    } catch {
      /* malformed declarations are ignored, like a malformed pricing override */
    }
  }
  return [];
}

// ── billing-unit declarations: the declared bridge or an em dash (tier 8 #27) ─

export interface UnitDeclaration {
  vendor: string;
  unit: string;
  usd_per_unit: number | null;
  effective_from: number | null;
  note?: string;
  author?: string;
}

/** Reads unit declarations: the admin override (paths.unitsOverride) merged over the builtin data/units.json (which ships empty, by design). */
export function loadUnitDeclarations(read: (p: string) => string | null, overridePath: string): UnitDeclaration[] {
  const out: UnitDeclaration[] = [];
  const push = (text: string | null): void => {
    if (text == null) return;
    try {
      const parsed = JSON.parse(text) as { declarations?: unknown };
      if (Array.isArray(parsed.declarations)) out.push(...parsed.declarations.filter((d): d is UnitDeclaration => {
        const u = d as UnitDeclaration;
        return u != null && typeof u === 'object' && typeof u.vendor === 'string' && typeof u.unit === 'string';
      }));
    } catch {
      /* a malformed units file is ignored — pricing must never break collection */
    }
  };
  push(read(new URL('./data/units.json', import.meta.url).pathname));
  push(read(overridePath));
  return out;
}

/**
 * The conversion in force for (vendor, unit) at a timestamp: the declaration
 * with the latest effective_from at or before `at`; NULL (an em dash) when none
 * is declared. A NULL usd_per_unit in a declaration also yields null — a
 * seat-price allocation is never spend.
 */
export function usdPerUnit(declarations: UnitDeclaration[], vendor: string, unit: string, at: number): number | null {
  let best: UnitDeclaration | null = null;
  for (const d of declarations) {
    if (d.vendor !== vendor || d.unit !== unit) continue;
    if (d.effective_from != null && d.effective_from > at) continue;
    if (!best || (d.effective_from ?? 0) > (best.effective_from ?? 0)) best = d;
  }
  return best?.usd_per_unit ?? null;
}
