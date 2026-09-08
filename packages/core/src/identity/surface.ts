/**
 * Tier 3 — surface_principal (feature 39): attributing a surface that has no
 * session, and saying how weakly. Every artifact behind a homegrown surface
 * has a filesystem owner and an mtime, and a repo has a git identity — that is
 * ALL the attribution available when there is no session to bind to.
 *
 * One new binding rank, 'file_owner', deliberately below every session-derived
 * rank in the ladder, so a homegrown surface can never outrank a real session.
 * (The BindingEvidence union in types.ts is foundation-owned; 'file_owner' is
 * declared here and the integrator widens the union in the coordinated edit.)
 *
 * File ownership is not authorship: a cloned repo carries a teammate's
 * committer identity, CI and sudo write files as other uids, and on a
 * single-user Mac every row resolves to the same uid — endpoint-level signal
 * and nothing more.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hmacIdentity } from './accounts';

/** The full ladder with the surface rank in place. Exported for the integrator's union widening. */
export type SurfaceBindingEvidence = 'session_proved' | 'store_origin' | 'ambient' | 'file_owner' | 'unbound';

export interface SurfacePrincipal {
  /** st_uid of the artifact. */
  uid: number;
  /** File mtime as evidence_ts. */
  evidence_ts: number;
  /** For repo-scoped rows: user.email domain + HMAC only — the address itself is never stored. */
  git_email_domain: string | null;
  git_email_hmac: string | null;
  binding_evidence: SurfaceBindingEvidence;
}

/**
 * Attributes one artifact path: stat(2) uid and mtime, and for a repo root
 * the .git/config user.email domain + HMAC under the existing identity key.
 * Returns null when the file does not exist — absence, never a guess.
 */
export function surfacePrincipal(path: string, repoRoot?: string | null): SurfacePrincipal | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  let git_email_domain: string | null = null;
  let git_email_hmac: string | null = null;
  const root = repoRoot ?? (existsSync(join(path, '.git')) ? path : null);
  if (root) {
    try {
      const cfg = readFileSync(join(root, '.git', 'config'), 'utf8');
      const email = cfg.match(/^\s*email\s*=\s*(\S+)\s*$/m)?.[1];
      if (email?.includes('@')) {
        git_email_domain = email.split('@')[1]!.toLowerCase();
        git_email_hmac = hmacIdentity(email.toLowerCase());
      }
    } catch {
      /* no .git/config or unreadable */
    }
  }
  return {
    uid: st.uid,
    evidence_ts: Math.round(st.mtimeMs),
    git_email_domain,
    git_email_hmac,
    binding_evidence: 'file_owner',
  };
}

/** Rank helper so callers can compare a surface attribution against session rows. */
export const BINDING_RANK: Record<SurfaceBindingEvidence, number> = {
  session_proved: 4,
  store_origin: 3,
  ambient: 2,
  file_owner: 1,
  unbound: 0,
};

/** Convenience: does a file-owner attribution outrank an existing binding? */
export function outranks(candidate: SurfaceBindingEvidence, existing: string | null): boolean {
  return (BINDING_RANK[candidate] ?? 0) > (BINDING_RANK[(existing ?? 'unbound') as SurfaceBindingEvidence] ?? 0);
}

/** The default repo-root probe for a path: walk up at most 4 parents looking for .git. */
export function repoRootOf(path: string, home = homedir()): string | null {
  let dir = path;
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir || !dir.startsWith(home)) return null;
    dir = parent;
  }
  return null;
}
