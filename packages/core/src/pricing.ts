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
