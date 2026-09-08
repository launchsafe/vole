/**
 * Tier 3 — ~/.vole/policy/identity.json (feature 27): the corporate
 * declaration every identity rule needs, hash-stamped so every incident can
 * name the policy version that judged it. Vole never guesses the contents:
 * the propose step reads what it has actually observed and prints a candidate
 * for a human to edit and commit. Absent the file, every identity rule is
 * inert and the People view shows account classes with no verdict.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DB } from '../db';
import { paths } from '../paths';
import { readClaudeJson } from './accounts';

export interface IdentityPolicy {
  corporate_org_uuids: string[];
  corporate_email_domains: string[];
  corporate_repo_owners: string[];
  /** Which account classes the company sanctioned (the others are shadow spend candidates). */
  sanctioned_account_classes: string[];
  git_remote_hosts?: string[];
  repo_globs?: string[];
  /** Plain per-tool seat declarations (feature 3). */
  seats_purchased?: Record<string, { plan?: string; seats: number; price_usd?: number }>;
  /** The per-person view gate (feature 20): absent block = hard off, not a warning. */
  people_view?: { enabled: boolean; granted_to?: string; reason?: string };
  source: string;
  sha256: string;
}

/** Loads the merged declaration; null when no policy file exists anywhere. Managed is the baseline, the user file refines it. */
export function loadIdentityPolicy(): IdentityPolicy | null {
  let merged: Partial<IdentityPolicy> | null = null;
  let source = '';
  let sha = '';
  for (const p of paths.identityPolicyPaths()) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf8');
      merged = JSON.parse(raw) as Partial<IdentityPolicy>;
      source = p;
      sha = createHash('sha256').update(raw).digest('hex');
    } catch {
      /* malformed layer: skip, same as pricing.json */
    }
  }
  if (!merged || source === '') return null;
  return {
    corporate_org_uuids: merged.corporate_org_uuids ?? [],
    corporate_email_domains: merged.corporate_email_domains ?? [],
    corporate_repo_owners: merged.corporate_repo_owners ?? [],
    sanctioned_account_classes: merged.sanctioned_account_classes ?? [],
    git_remote_hosts: merged.git_remote_hosts,
    repo_globs: merged.repo_globs,
    seats_purchased: merged.seats_purchased,
    people_view: merged.people_view,
    source,
    sha256: sha,
  };
}

/**
 * `vole identity propose`: reads the org UUIDs actually observed in
 * session_identity rows and the repo owners from ~/.claude.json
 * githubRepoPaths, and prints a candidate file to stdout for a human to edit
 * and commit. Writes nothing. A repo no agent ever touched never appears —
 * the propose step can only suggest what it has already seen.
 */
export function identityPropose(db: DB, home = homedir()): string {
  const orgIds = (
    db.prepare('SELECT DISTINCT org_id FROM session_identity WHERE org_id IS NOT NULL').all() as { org_id: string }[]
  ).map((r) => r.org_id);
  const owners = new Set<string>();
  for (const v of Object.values(readClaudeJson(home)?.githubRepoPaths ?? {})) {
    if (v.owner) owners.add(v.owner);
  }
  const domains = new Set<string>();
  const claude = readClaudeJson(home);
  if (claude?.emailDomain) domains.add(claude.emailDomain);
  const candidate = {
    _comment: 'Proposed by `vole identity propose` from what Vole has observed on this machine. Edit, then save as ~/.vole/policy/identity.json. Until this file exists, every identity rule (shadow_account included) is inert.',
    corporate_org_uuids: orgIds.sort(),
    corporate_email_domains: [...domains].sort(),
    corporate_repo_owners: [...owners].sort(),
    sanctioned_account_classes: ['org_oauth', 'team_seat'],
    seats_purchased: {} as Record<string, { plan: string; seats: number }>,
    people_view: { enabled: false },
  };
  return JSON.stringify(candidate, null, 2);
}
