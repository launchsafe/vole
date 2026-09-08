import type { Anomaly, RateLimitObservation, UsageEvent } from '../types';
import { detectBillableBurn } from './burn-rate';
import { detectRepeatLoops } from './loop';
import { detectErrorStorms } from './error-storm';
import { detectRateLimitPressure } from './rate-limit';
import { detectContextPressure } from './context-pressure';
import { detectReroutedModels } from './rerouted-model';
import { IDENTITY_RULE_IDS } from '../identity/rules';

export { detectBillableBurn, detectRepeatLoops, detectErrorStorms, detectRateLimitPressure, detectContextPressure, detectReroutedModels };
export { contextOf, windowOf } from './context-pressure';
export * from './util';

/**
 * The rule registry's identity: every rule id, in a stable order. Detection is
 * insert-gated for cost, so a NEW rule would never see historical rows — the
 * collector compares this list each pass and forces one full detect run when it
 * changes (a rule epoch). This is the Tier 6 detection_epochs concept, scoped to
 * what exists today.
 */
export const RULE_IDS = [
  'billable_burn_spike',
  'repeat_call_loop',
  'error_storm',
  'rate_limit_pressure',
  'context_pressure',
  'rerouted_model',
  // ── scanner-fired rules: rows insert via insertAnomalies from the scanner
  // lane, but their ids live here so a rule epoch forces one full detect pass
  // over history (the collector compares this list each pass).
  'coverage_degraded',
  'foreign_root_transcript',
  'agent_home_moved',
  'evidence_expiring',
  'secret_reappeared_after_rotation',
  // ── identity (tier 3): see identity/rules.ts
  ...IDENTITY_RULE_IDS,
  // ── claim violations (tier 5 #51), fired from the collect loop
  'sandbox_claim_violated',
  'network_claim_violated',
  // ── vendor plane (tier 8): DB-driven, run via rulesAfterPull
  'shadow_account_spend',
  'reconcile_gap',
  // ── lifecycle (tier 8)
  'activity_after_departure',
  // ── budgets (tier 8): verdicts computed in the collect pass
  'budget_exceeded',
  'budget_indeterminate',
] as const;

/** Runs every rule. Pure: no DB access, so rules stay unit-testable in isolation. */
export function detectAll(
  events: UsageEvent[],
  rateLimits: RateLimitObservation[] = [],
  now: number = Date.now(),
): Anomaly[] {
  return [
    ...detectBillableBurn(events, now),
    ...detectRepeatLoops(events, now),
    ...detectErrorStorms(events, now),
    ...detectRateLimitPressure(rateLimits, now),
    ...detectContextPressure(events, now),
    ...detectReroutedModels(events, now),
  ];
}

/**
 * Runs the rules separately per data source.
 *
 * Seed and live rows must never share a baseline: a 30-day synthetic history would
 * otherwise redefine what "normal" means for real usage (and vice versa), so a real
 * spike could be masked by demo data. Keeping the partitions apart is what makes the
 * demo data genuinely removable rather than merely separately stored.
 *
 * The source is also folded into `anomaly_key`, so a live and a seed incident occupying
 * the same time bucket cannot collide on the UNIQUE constraint.
 */
export function detectBySource(
  events: UsageEvent[],
  rateLimitsBySource: Partial<Record<string, RateLimitObservation[]>>,
  now: number = Date.now(),
): Anomaly[] {
  const bySource = new Map<string, UsageEvent[]>();
  for (const e of events) {
    const arr = bySource.get(e.source);
    if (arr) arr.push(e);
    else bySource.set(e.source, [e]);
  }

  const out: Anomaly[] = [];
  for (const [source, evs] of bySource) {
    const rl = rateLimitsBySource[source] ?? [];
    for (const a of detectAll(evs, rl, now)) {
      out.push({
        ...a,
        source: source as Anomaly['source'],
        anomaly_key: `${source}:${a.anomaly_key}`,
      });
    }
  }
  return out;
}
