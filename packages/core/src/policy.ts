import { readFileSync, existsSync } from 'node:fs';
import { paths } from './paths';

/**
 * The sanctioned-surface policy: an admin's declaration of which AI surfaces are
 * allowed on this fleet. Without it, "unsanctioned" is undefined — Vole's opinion
 * is not evidence — so every consumer must treat `null` as inert, never as
 * "everything is unsanctioned".
 */

export interface SurfacePolicy {
  /** Glob patterns matched against ai_surfaces.surface_key (e.g. "app:com.anthropic.*"). */
  allowed: string[];
  /** Where the effective declaration came from, for the incident's provenance. */
  source: string;
}

/** Loads the merged declaration; null when no policy file exists anywhere. */
export function loadSurfacePolicy(): SurfacePolicy | null {
  let merged: { allowed: string[] } | null = null;
  let source = '';
  for (const p of paths.surfacePolicyPaths()) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { allowed?: string[] };
      if (!Array.isArray(parsed.allowed)) continue;
      // Later files win entirely: the admin file is the baseline, the user file
      // refines it — one coherent list, not a union of both opinions.
      merged = { allowed: parsed.allowed };
      source = p;
    } catch {
      /* malformed policy: ignore that layer, same as pricing.json */
    }
  }
  if (!merged || merged.allowed.length === 0) return null;
  return { ...merged, source };
}

/** Glob match with `*` only (no `?`/`[...]`): enough for surface keys, no surprises. */
export function surfaceMatches(pattern: string, key: string): boolean {
  if (pattern === key) return true;
  const parts = pattern.split('*');
  if (parts.length === 1) return false;
  // Anchored segments: first must prefix, last must suffix, middles in order.
  let rest = key;
  const [first, ...tail] = parts;
  if (first && !rest.startsWith(first)) return false;
  rest = rest.slice(first!.length);
  const last = tail.pop()!;
  for (const mid of tail) {
    const i = rest.indexOf(mid);
    if (i === -1) return false;
    rest = rest.slice(i + mid.length);
  }
  if (last && !rest.endsWith(last)) return false;
  return rest.length >= last.length;
}

/** Is this surface allowed under the policy? null when no policy is loaded. */
export function isSanctioned(policy: SurfacePolicy | null, surfaceKey: string): boolean | null {
  if (!policy) return null;
  return policy.allowed.some((p) => surfaceMatches(p, surfaceKey));
}
