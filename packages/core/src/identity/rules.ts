/**
 * Tier 3 — the identity rule set, in the shape the detection registry
 * consumes: one ID list (for the rule-epoch comparison in collect) and one
 * entry point that runs every rule over the store. The anomaly keys carry
 * user/machine identity, so two employees sharing one store never collapse
 * into a single UNIQUE row, and each rule partitions by source.
 *
 * Registration in detect/index.ts's RULE_IDS and behaviour.ts's
 * LEDGER_RULE_IDS is the integrator's single coordinated edit — the literals
 * already exist in the AnomalyRule union.
 */
import type { DB } from '../db';
import type { Anomaly } from '../types';
import { detectPrincipalConflicts } from './chain';
import { detectAccountSwitched, detectShadowAccountOnCorporateRepo } from './accounts';
import { loadIdentityPolicy, type IdentityPolicy } from './policy';

export const IDENTITY_RULE_IDS = [
  'account_switched',
  'principal_conflict',
  'shadow_account_on_corporate_repo',
] as const;

export interface IdentityDetectResult {
  anomalies: Anomaly[];
  /** Why shadow_account is inert, when it is (no policy loaded). */
  inertReason: string | null;
  /** The policy hash every incident can name as the version that judged it. */
  policySha256: string | null;
}

/** Every identity rule over the store, in one pass. Policy-dependent rules are inert without the policy, by design. */
export function detectIdentityRules(db: DB, now = Date.now()): IdentityDetectResult {
  const policy: IdentityPolicy | null = loadIdentityPolicy();
  const shadow = detectShadowAccountOnCorporateRepo(db, policy, now);
  return {
    anomalies: [
      ...detectAccountSwitched(db, now),
      ...detectPrincipalConflicts(db, now),
      ...shadow.anomalies,
    ],
    inertReason: shadow.inertReason,
    policySha256: policy?.sha256 ?? null,
  };
}
