/**
 * Tier 6 §7: pricing as a pack kind, and the user override that must lose in
 * managed mode.
 *
 * Precedence: managed/vendor pricing pack > user override (~/.vole/pricing.json
 * or $VOLE_PRICING) > builtin table. The resolved revision is stamped into
 * usage_events.cost_basis at insert as `pricing_rev`, so a developer on a
 * managed laptop cannot change their own showback without a record existing.
 * An ignored override is still listed, with its checksum.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { DB } from '../db';
import { paths } from '../paths';
import { activePack } from './registry';

export interface ResolvedPricing {
  /** Which layer won. */
  source: 'managed_pack' | 'user_override' | 'builtin';
  /** The pack/override revision in force. */
  pricing_rev: number;
  /** The definition of a dollar this revision states, for cost_basis stamps. */
  cost_basis: string;
  /** sha256 of the losing user override, when one was ignored (listed, never silently dropped). */
  ignored_override_sha256: string | null;
  models: Record<string, unknown>;
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Resolves the pricing pack in force. Reads the store (the registry must have
 * run) plus the user override path. A user override only wins when no managed
 * pack of kind 'pricing' has loaded.
 */
export function resolvePricing(db: DB): ResolvedPricing {
  const pack = activePack(db, 'pricing');
  const overrideFile = paths.pricingOverride();
  const overrideExists = existsSync(overrideFile);
  const overrideSha = overrideExists ? sha256File(overrideFile) : null;

  if (pack.trust !== 'builtin_floor') {
    return {
      source: 'managed_pack',
      pricing_rev: pack.version,
      cost_basis: `pricing_pack:v${pack.version}`,
      ignored_override_sha256: overrideSha,
      models: {},
    };
  }
  if (overrideExists) {
    // The user override carries no version of its own; its revision is the
    // leading 8 hex of its checksum — verifiable, never invented.
    let m: Record<string, unknown> = {};
    try {
      m = (JSON.parse(readFileSync(overrideFile, 'utf8')) as { models?: Record<string, unknown> }).models ?? {};
    } catch {
      m = {}; // a malformed override is ignored — pricing must never break collection
    }
    return {
      source: 'user_override',
      pricing_rev: parseInt((overrideSha ?? '0').slice(0, 8), 16),
      cost_basis: `pricing_override:${(overrideSha ?? '').slice(0, 8)}`,
      ignored_override_sha256: null,
      models: m,
    };
  }
  return {
    source: 'builtin',
    pricing_rev: pack.version,
    cost_basis: `pricing_builtin:v${pack.version}`,
    ignored_override_sha256: null,
    models: {},
  };
}

/** The pricing_rev integer for a pack revision, for usage_events.pricing_rev at insert. */
export function stampPricingRev(db: DB): { pricing_rev: number; cost_basis: string } {
  const r = resolvePricing(db);
  return { pricing_rev: r.pricing_rev, cost_basis: r.cost_basis };
}

export interface PricingPreflight {
  /** usage_events rows currently unpriced that this pack would price. */
  rows_gaining_rate: number;
  /** usage_events rows priced today that this pack would leave unpriced. */
  rows_losing_rate: number;
  /** Distinct models the candidate adds / drops rates for. */
  models_added: string[];
  models_dropped: string[];
  /** Distinct models in the store the sample covers — the preflight's sample size. */
  models_seen: string[];
}

/**
 * Preflight scoring of a candidate pricing pack: counts over usage_events,
 * which rows would gain or lose a rate. Read-only; nothing is written.
 */
export function preflightPricing(db: DB, candidate: { models?: Record<string, unknown> }): PricingPreflight {
  const models = Object.keys(candidate.models ?? {});
  const modelSet = new Set(models);
  const rows = db
    .prepare(
      `SELECT model, COUNT(*) AS n, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
       FROM usage_events WHERE source = 'live' AND model IS NOT NULL GROUP BY model`,
    )
    .all() as { model: string; n: number; unpriced: number }[];
  const priced = new Set(
    (db.prepare('SELECT DISTINCT model FROM usage_events WHERE cost_usd IS NOT NULL AND model IS NOT NULL').all() as { model: string }[]).map((r) => r.model),
  );
  let gain = 0;
  let lose = 0;
  const added: string[] = [];
  const dropped: string[] = [];
  for (const r of rows) {
    if (modelSet.has(r.model) && r.unpriced > 0) {
      gain += r.unpriced;
      added.push(r.model);
    }
    if (!modelSet.has(r.model) && priced.has(r.model)) {
      lose += r.n;
      dropped.push(r.model);
    }
  }
  return { rows_gaining_rate: gain, rows_losing_rate: lose, models_added: added, models_dropped: dropped, models_seen: rows.map((r) => r.model) };
}
