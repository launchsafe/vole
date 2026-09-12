/**
 * Waste detection for `vole optimize`.
 *
 * Every detector is built on a signal the product already measures — cache re-warm,
 * yield, pricing coverage — rather than on new analysis invented for this command. A
 * finding here must be traceable to a number the user can check elsewhere in Vole, or
 * it is just advice with a dollar sign on it.
 *
 * Findings are proposals. Only the ones marked `mechanical` have a fix this tool can
 * safely apply on its own; the rest describe a change in how someone works, and
 * pretending otherwise would be the dishonest part of a feature like this.
 */
import type { DB } from '../db';
import { getCacheRewarm } from '../queries';
import { isDeliberatelyUnpriced } from '../pricing';

export type FindingKind = 'cache_rewarm' | 'abandoned_spend' | 'unpriced_model';

export interface Finding {
  /** Stable across runs, so re-detecting the same problem updates rather than duplicates. */
  key: string;
  kind: FindingKind;
  title: string;
  /** What was measured, with the figures that produced it. */
  detail: string;
  /** Paste-ready remedy. Null when there is nothing to paste. */
  fix: string | null;
  /** True only when this tool can apply the fix itself, reversibly. */
  mechanical: boolean;
  /** Dollars per period this could plausibly save. 0 when the finding is about visibility. */
  predictedUsd: number;
  /** The measured figure the prediction is derived from, so verification has a baseline. */
  baselineUsd: number;
  /** Structured payload for a mechanical fix — what to write, and what to undo. */
  payload?: unknown;
}

/** Below this a finding is not worth a user's attention. */
const MIN_FINDING_USD = 1;

/**
 * Context re-written to cache after an idle gap.
 *
 * The clearest waste in the product because it is money spent re-sending something the
 * model already had: a cache write costs 1.25x (or 2x at the 1-hour tier) where a read
 * costs 0.1x. The fix is behavioural — shorter gaps, or the longer cache TTL — so it is
 * proposed, never applied.
 */
export function detectCacheRewarm(db: DB, now: number): Finding[] {
  const r = getCacheRewarm(db, '30d', false);
  const cost = r.cost ?? 0;
  if (cost < MIN_FINDING_USD || r.gaps === 0) return [];

  // Only the portion attributable to gaps is claimable; the first write of a session
  // was always going to happen.
  const predicted = cost * 0.5;
  return [
    {
      key: 'cache_rewarm:30d',
      kind: 'cache_rewarm',
      title: 'Context re-sent after idle gaps',
      detail:
        `${r.gaps} idle gap(s) in the last 30 days forced the whole context to be written ` +
        `to cache again, costing ${fmtUsd(cost)}. A cache write is 1.25x the input rate ` +
        `(2x at the 1-hour tier); a read is 0.1x. This is money spent re-sending ` +
        `something the model already had.`,
      fix:
        'Keep a working session alive rather than returning to it after the cache has ' +
        'expired, or split long gaps into separate shorter sessions so less context is ' +
        're-warmed. Check the cache countdown in `pnpm top` before stepping away.',
      mechanical: false,
      predictedUsd: round2(predicted),
      baselineUsd: round2(cost),
    },
  ];
}

/**
 * Sessions that cost real money and produced no commit.
 *
 * Reuses the yield primitive rather than re-deriving the git correlation. Deliberately
 * not called "wasted": research, reading and planning sessions legitimately end without
 * a commit, which is why the wording asks a question rather than making an accusation.
 */
export function detectAbandonedSpend(db: DB, now: number): Finding[] {
  if (!hasTable(db, 'session_yield')) return [];
  const rows = db
    .prepare(
      `SELECT y.session_id, y.tool, y.repo_root, c.cost, c.calls
         FROM session_yield y
         JOIN (SELECT session_id, tool, SUM(cost_usd) AS cost, COUNT(*) AS calls, MAX(ts) AS last_ts
                 FROM usage_events WHERE source = 'live' GROUP BY session_id, tool) c
           ON c.session_id = y.session_id AND c.tool = y.tool
        WHERE y.status = 'abandoned' AND c.cost IS NOT NULL AND c.last_ts >= ?
        ORDER BY c.cost DESC`,
    )
    .all(now - 30 * 24 * 3600_000) as {
    session_id: string; tool: string; repo_root: string | null; cost: number; calls: number;
  }[];

  const total = rows.reduce((n, r) => n + r.cost, 0);
  if (total < MIN_FINDING_USD || rows.length === 0) return [];

  const worst = rows.slice(0, 3)
    .map((r) => `${r.session_id.slice(0, 8)} (${fmtUsd(r.cost)}, ${r.calls} calls)`)
    .join(', ');

  return [
    {
      key: 'abandoned_spend:30d',
      kind: 'abandoned_spend',
      title: 'Spend with no commit behind it',
      detail:
        `${rows.length} session(s) in the last 30 days cost ${fmtUsd(total)} between them and ` +
        `left no commit in their repository within 30 minutes of finishing. Largest: ${worst}. ` +
        `Not necessarily waste — research and planning end this way too — but it is where ` +
        `to look first.`,
      fix:
        'Open the largest of those sessions with `pnpm top --since=43200` or the session ' +
        'drill-down and ask whether the task was scoped too broadly, or abandoned after ' +
        'the agent went in the wrong direction. Where it was the latter, a tighter initial ' +
        'prompt is the fix.',
      mechanical: false,
      // Half, not all: some of these were always going to be exploratory.
      predictedUsd: round2(total * 0.5),
      baselineUsd: round2(total),
    },
  ];
}

/**
 * Models with real usage and no rate, so their spend is invisible.
 *
 * A visibility gap rather than waste, and the only finding with a genuinely mechanical
 * fix: an alias in the pricing override is a small, reversible config write, and the
 * result is checkable — those rows either gain a cost afterwards or they do not.
 */
export function detectUnpricedModels(db: DB, now: number): Finding[] {
  const rows = db
    .prepare(
      `SELECT model, tool, COUNT(*) AS calls, SUM(total_tokens) AS tokens
         FROM usage_events
        WHERE source = 'live' AND cost_usd IS NULL AND total_tokens > 0
          AND model IS NOT NULL AND ts >= ?
        GROUP BY model, tool
        ORDER BY tokens DESC`,
    )
    .all(now - 30 * 24 * 3600_000) as {
    model: string; tool: string; calls: number; tokens: number;
  }[];

  const out: Finding[] = [];
  for (const r of rows) {
    // A flat-rate SKU has no per-token rate to find, so this is not a gap. Note the
    // distinction: `unpricedReason` answers for ANY unpriced model, including one that
    // simply has no rate loaded yet — using it here silently suppressed every finding.
    if (isDeliberatelyUnpriced(r.model)) continue;
    out.push({
      key: `unpriced_model:${r.tool}:${r.model}`,
      kind: 'unpriced_model',
      title: `Spend on ${r.model} is invisible`,
      detail:
        `${r.calls} call(s) and ${r.tokens.toLocaleString('en-US')} tokens on ${r.model} ` +
        `(${r.tool}) in the last 30 days carry no cost, because no rate is loaded for that ` +
        `model. The tokens are exact; only the dollars are missing.`,
      fix:
        `Add a rate to ~/.vole/pricing.json:\n\n` +
        `    { "models": { "${r.model}": { "input": 0.00, "output": 0.00, ` +
        `"effective_from": "${new Date(now).toISOString().slice(0, 10)}" } } }\n\n` +
        `Replace the zeros with the published per-million rates. Vole validates them and ` +
        `ignores anything impossible.`,
      mechanical: true,
      predictedUsd: 0, // visibility, not saving
      baselineUsd: 0,
      payload: { model: r.model, tool: r.tool },
    });
  }
  return out;
}

/** Every detector, newest signal first. */
export function detectAll(db: DB, now: number = Date.now()): Finding[] {
  return [
    ...detectCacheRewarm(db, now),
    ...detectAbandonedSpend(db, now),
    ...detectUnpricedModels(db, now),
  ];
}

function hasTable(db: DB, name: string): boolean {
  const r = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { ok: number } | undefined;
  return r?.ok === 1;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
