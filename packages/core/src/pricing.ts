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

/** A price or multiplier: a real, finite, non-negative number. Nothing else prices. */
function isRate(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Keeps only the parts of an override that can actually price a token.
 *
 * The override is a hand-edited file, and a bad value there is silent rather than
 * loud: a negative rate yields a negative cost that *reduces* reported spend, and
 * a string or NaN propagates through every aggregate. "Malformed is ignored" has
 * to mean semantically malformed, not merely unparseable JSON — so each entry is
 * checked on its own and a bad one falls back to the built-in table instead of
 * poisoning it.
 */
export function sanitiseOverride(raw: unknown): Partial<PricingFile> {
  const out: Partial<PricingFile> = {};
  if (!raw || typeof raw !== 'object') return out;
  const o = raw as Record<string, unknown>;

  if (o.models && typeof o.models === 'object') {
    const models: Record<string, ModelRate> = {};
    for (const [id, v] of Object.entries(o.models as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const r = v as Partial<ModelRate>;
      if (!isRate(r.input) || !isRate(r.output)) continue;
      if (r.cache_read !== undefined && !isRate(r.cache_read)) continue;
      models[id] = r as ModelRate;
    }
    out.models = models;
  }

  if (o.cache_multipliers && typeof o.cache_multipliers === 'object') {
    const mult: Record<string, number> = {};
    for (const [k, v] of Object.entries(o.cache_multipliers as Record<string, unknown>)) {
      if (isRate(v)) mult[k] = v;
    }
    out.cache_multipliers = mult as PricingFile['cache_multipliers'];
  }

  if (o.context_windows && typeof o.context_windows === 'object') {
    const win: Record<string, number> = {};
    for (const [k, v] of Object.entries(o.context_windows as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) win[k] = v;
    }
    out.context_windows = win;
  }

  if (o.unpriced && typeof o.unpriced === 'object') {
    const un: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.unpriced as Record<string, unknown>)) {
      if (typeof v === 'string') un[k] = v;
    }
    out.unpriced = un;
  }

  return out;
}

function loadPricing(): PricingFile {
  const file = paths.pricingOverride();
  try {
    if (!existsSync(file)) return BUILTIN;
    const o = sanitiseOverride(JSON.parse(readFileSync(file, 'utf8')));
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
/**
 * Whether a model is unpriced ON PURPOSE — a flat-rate or subscription SKU that has no
 * per-token rate to find. Distinct from "no rate loaded yet", which is a gap worth
 * closing; asking a user to invent a rate for a flat-rate product is nagging, not help.
 */
export function isDeliberatelyUnpriced(model: string | null): boolean {
  return !!model && model in UNPRICED_MODELS;
}

export function unpricedReason(model: string | null): string | null {
  if (!model) return 'No model recorded.';
  if (rateFor(model)) return null;
  return UNPRICED_MODELS[model] ?? `No published rate loaded for "${model}".`;
}
