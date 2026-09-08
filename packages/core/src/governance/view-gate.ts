import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { DB } from '../db';
import { paths } from '../paths';
import type { DeploymentMode } from './deployment-mode';

/**
 * Per-person view governance: three switches over one view, so a works council
 * has a single named artifact instead of scattered defaults.
 *
 * 1. The gate — the People view refuses to render a multi-person table unless
 *    a people_view {enabled, granted_to, reason} block exists in the identity
 *    policy file. Its absence is a HARD OFF, not a warning. With exactly one
 *    principal in the store, the view collapses to a 'This is you' self-card
 *    and is allowed without the block (there is no other person to protect).
 * 2. The access log — every allowed per-person view appends to access_log
 *    (append-only, never UPDATEd) with the accessor, purpose and view.
 * 3. productivity_views — on in personal mode, off in managed mode.
 *
 * A local admin holding the SQLite file bypasses every gate — this is default
 * behaviour plus an audit trail, not a boundary against the machine's owner.
 */

export interface PeopleViewBlock {
  enabled: boolean;
  granted_to: string;
  reason: string;
}

export interface PeopleViewPolicy {
  block: PeopleViewBlock | null;
  source: string | null;
  hash: string | null;
}

/** Reads the people_view block from the identity policy files (admin wins, user refines). */
export function loadPeopleViewPolicy(files: string[] = paths.identityPolicyPaths()): PeopleViewPolicy {
  for (let i = files.length - 1; i >= 0; i--) {
    const p = files[i];
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw) as { people_view?: Partial<PeopleViewBlock> };
      const b = parsed.people_view;
      const hash = createHash('sha256').update(raw).digest('hex');
      if (!b) return { block: null, source: p, hash };
      // A malformed block is a hard off too — enabled is not a default.
      const enabled = b.enabled === true;
      if (!enabled) return { block: { enabled: false, granted_to: String(b.granted_to ?? ''), reason: String(b.reason ?? '') }, source: p, hash };
      if (!b.granted_to || !b.reason) {
        // enabled without granted_to/reason: the policy is incomplete → off.
        return { block: null, source: p, hash };
      }
      return { block: { enabled: true, granted_to: String(b.granted_to), reason: String(b.reason) }, source: p, hash };
    } catch {
      /* malformed layer ignored */
    }
  }
  return { block: null, source: null, hash: null };
}

export function principalCount(db: DB): number {
  return (db.prepare('SELECT COUNT(DISTINCT principal_key) AS n FROM principals').get() as { n: number }).n;
}

export type ViewGateBasis =
  | 'single_principal_self'
  | 'policy_block'
  | 'refused_no_policy'
  | 'refused_policy_disabled';

export interface ViewGateDecision {
  allowed: boolean;
  basis: ViewGateBasis;
  policyHash: string | null;
  message: string;
}

/**
 * The gate itself. `accessor` is who is asking (a label, never an email) and
 * `purpose` is mandatory when the view is allowed — the access_log row is the
 * record, not the control.
 */
export function gatePeopleView(
  db: DB,
  accessor: string,
  opts: { policy?: PeopleViewPolicy; purpose?: string; view?: string; now?: number } = {},
): ViewGateDecision {
  const policy = opts.policy ?? loadPeopleViewPolicy();
  const n = principalCount(db);
  if (n <= 1) {
    const d: ViewGateDecision = {
      allowed: true,
      basis: 'single_principal_self',
      policyHash: policy.hash,
      message: `this store holds ${n} principal(s) — the view renders as a 'This is you' self-card`,
    };
    logAccess(db, accessor, opts.purpose ?? 'self-view', opts.view ?? 'people', opts.now);
    return d;
  }
  if (!policy.block) {
    return {
      allowed: false,
      basis: 'refused_no_policy',
      policyHash: policy.hash,
      message:
        'the store holds more than one principal and no people_view {enabled, granted_to, reason} block exists — the per-person view is a hard off, not a warning',
    };
  }
  if (!policy.block.enabled) {
    return {
      allowed: false,
      basis: 'refused_policy_disabled',
      policyHash: policy.hash,
      message: 'people_view policy block present but disabled',
    };
  }
  if (!policy.block.granted_to || !policy.block.reason) {
    // enabled without granted_to/reason: an incomplete block is absent — hard off.
    return {
      allowed: false,
      basis: 'refused_no_policy',
      policyHash: policy.hash,
      message: 'people_view block enabled but missing granted_to/reason — treated as absent',
    };
  }
  logAccess(db, accessor, opts.purpose ?? policy.block.reason, opts.view ?? 'people', opts.now);
  return {
    allowed: true,
    basis: 'policy_block',
    policyHash: policy.hash,
    message: `per-person view enabled by policy ${policy.hash} — granted to ${policy.block.granted_to}, reason: ${policy.block.reason}`,
  };
}

export interface AccessLogRow {
  id: number;
  accessor: string;
  purpose: string;
  view: string;
  ts: number;
}

/** Append-only by contract: the only statement against access_log is INSERT (and SELECT). */
export function logAccess(
  db: DB,
  accessor: string,
  purpose: string,
  view: string,
  now = Date.now(),
): void {
  db.prepare('INSERT INTO access_log (accessor, purpose, view, ts) VALUES (?, ?, ?, ?)').run(
    accessor,
    purpose,
    view,
    now,
  );
}

/** The who-looked log (People view gate, Privacy Center). Newest first. */
export function recentAccess(db: DB, limit = 50): AccessLogRow[] {
  return db
    .prepare('SELECT id, accessor, purpose, view, ts FROM access_log ORDER BY id DESC LIMIT ?')
    .all(limit) as AccessLogRow[];
}

/** productivity_views: on in personal mode, off in managed mode. */
export function productivityViewsEnabled(mode: DeploymentMode['mode']): boolean {
  return mode === 'personal';
}

/**
 * The subject notice: what a data subject is told about per-person views of
 * their rows. In personal mode nothing to say; when a policy block enables
 * the multi-person view, every subject sees who can look, why, under which
 * policy hash — the notice is generated, not a static string.
 */
export function subjectNotice(policy: PeopleViewPolicy, mode: DeploymentMode['mode']): string {
  if (mode === 'personal') return 'personal mode: per-person views are your own rows only; no access log, no notices, no purpose binding.';
  if (!policy.block?.enabled) return 'managed mode: no people_view policy is in force — per-person views of your rows are off.';
  return `managed mode: your per-person rows are viewable by ${policy.block.granted_to} under the reason "${policy.block.reason}" (policy ${policy.hash?.slice(0, 12) ?? 'unknown'}). Every view is recorded in the access log with its purpose.`;
}
