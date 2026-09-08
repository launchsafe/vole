import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths';

/**
 * The asset resolution chain (feature 44): one resolver stamped at insert by
 * action_targets and the write/target ledgers. First hit wins, and the winning
 * link is stored in asset_match. The register is the admin-authored assets.json
 * (t6-repos-envelope owns writing it); until it exists this resolves everything
 * to NULL asset_id — 'unresolved', never a guessed identity.
 *
 * ponytail: the chain is repo-remote then label/domain pattern — the spec's
 * full chain (path globs with cwd ancestry) lands with the register itself;
 * add link kinds there, not here.
 */

export interface AssetEntry {
  id: string;
  kind?: string; // repo | domain | path | dsn | store | class
  tier?: number; // the spec's asset_tier numbering
  rev?: number;
  match?: string[]; // domains / normalised repo remotes / path globs
}

export interface AssetResolution {
  asset_id: string | null;
  asset_tier: number | null;
  asset_match: string | null; // the winning link: repo_remote | label_match
  asset_rev: number | null;
}

const EMPTY: AssetResolution = { asset_id: null, asset_tier: null, asset_match: null, asset_rev: null };

/** Lowercase the host, strip user-info and a trailing .git, so `git@h:x/y.git`
 *  and `https://H/x/y` collapse to one identity. */
export function normaliseRemote(url: string): string {
  let u = url.trim();
  const scpForm = /^[\w.-]+@([\w.-]+):(.+)$/.exec(u);
  if (scpForm) u = `https://${scpForm[1]}/${scpForm[2]}`;
  try {
    const parsed = new URL(u);
    u = `${parsed.host.toLowerCase()}${parsed.pathname}`;
  } catch {
    // A bare host/path with no scheme: normalise the host part only.
    u = u.replace(/^[^/]*@/, '').toLowerCase();
  }
  return u.replace(/\.git$/, '').replace(/\/+$/, '');
}

export function loadAssetRegister(files: string[] = paths.assetsPolicyPaths()): AssetEntry[] {
  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      const parsed = JSON.parse(readFileSync(f, 'utf8')) as { entries?: AssetEntry[] } | AssetEntry[];
      const entries = Array.isArray(parsed) ? parsed : (parsed.entries ?? []);
      if (entries.length) return entries;
    } catch {
      // An unreadable register resolves nothing — fall through to the next path.
    }
  }
  return [];
}

/** Read the remote origin URL of the repo containing `cwd` (ancestor .git/config). */
export function readGitRemote(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  let dir = cwd;
  for (;;) {
    const config = join(dir, '.git', 'config');
    if (existsSync(config)) {
      const m = /\[remote "origin"\][^[]*url\s*=\s*(\S+)/.exec(readFileSync(config, 'utf8').replace(/\n\s+/g, '\n'));
      return m?.[1] ?? null;
    }
    const parent = join(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The chain, first hit wins:
 *   1. repo_remote — the normalised remote (from session_meta or the cwd's
 *      .git/config) matches a register entry's match list.
 *   2. label_match — the target label (a host, repo slug or DSN) matches.
 * A null remote + null label resolves to nothing.
 */
export function resolveAsset(
  register: AssetEntry[],
  opts: { remote?: string | null; label?: string | null; cwd?: string | null },
): AssetResolution {
  const remote = opts.remote ?? readGitRemote(opts.cwd);
  if (remote) {
    const norm = normaliseRemote(remote);
    const hit = register.find((e) => (e.match ?? []).some((m) => normaliseRemote(m) === norm));
    if (hit) return { asset_id: hit.id, asset_tier: hit.tier ?? null, asset_match: 'repo_remote', asset_rev: hit.rev ?? null };
  }
  if (opts.label) {
    const label = opts.label.toLowerCase();
    const labelNorm = normaliseRemote(opts.label);
    const hit = register.find((e) =>
      (e.match ?? []).some((m) => {
        const ml = m.toLowerCase();
        return ml === label || normaliseRemote(m) === labelNorm;
      }),
    );
    if (hit) return { asset_id: hit.id, asset_tier: hit.tier ?? null, asset_match: 'label_match', asset_rev: hit.rev ?? null };
  }
  return EMPTY;
}
