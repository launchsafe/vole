import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db';
import { paths } from '../paths';

/**
 * The where-it-landed chain's terms half (tier 4 #131): the contract tier per
 * surface and the processing-terms register with its as-of lookup. Everything
 * here is DECLARED, never inferred: a plan comes from the vendor's own
 * account record (vendor_identities.plan) or from the admin's terms pack,
 * and processing terms carry the as-of date they were true on. A surface with
 * no declaration keeps NULL — the chain draws its break there rather than
 * inventing a basis.
 *
 * The pack format (installed under packPaths() as terms*.json):
 *   { "version": 1, "as_of": 1760000000000,
 *     "entries": [ { "surface_key": "cli:gemini", "kind": "plan"|"processing_terms"|"region"|..., "value": "..." } ] }
 */

export interface TermsPackEntry {
  surface_key: string;
  kind: string;
  value: string;
}

export interface TermsPack {
  version: number | null;
  asOf: number | null;
  source: string;
  entries: TermsPackEntry[];
}

/** Loads the first well-formed terms pack on the pack path (admin root wins). */
export function loadTermsPack(): TermsPack | null {
  for (const dir of paths.packPaths()) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch { continue; }
    for (const f of files) {
      if (!/^terms.*\.json$/i.test(f)) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, f), 'utf8')) as {
          version?: number; as_of?: number; entries?: Partial<TermsPackEntry>[];
        };
        const entries = (parsed.entries ?? [])
          .filter((e) => typeof e.surface_key === 'string' && typeof e.kind === 'string' && typeof e.value === 'string')
          .map((e) => ({ surface_key: e.surface_key!, kind: e.kind!, value: e.value! }));
        return {
          version: typeof parsed.version === 'number' ? parsed.version : null,
          asOf: typeof parsed.as_of === 'number' ? parsed.as_of : null,
          source: join(dir, f),
          entries,
        };
      } catch { /* malformed pack: ignored, never fatal */ }
    }
  }
  return null;
}

/** Which pack kinds become rows in which table — 'region' belongs to residency.ts's evidence pass. */
const PACK_KIND_TABLE = new Set(['plan', 'processing_terms', 'training_opt_out', 'retention', 'data_use', 'residency']);

/**
 * Populates terms_basis (contract tier per surface) and processing_terms
 * (the register with its as-of). Sources, in evidence-rank order:
 *   vendor_identities.plan — the vendor's own account record, keyed by the
 *     ai_surfaces.vendor join;
 *   the admin terms pack — declared, versioned, as-of stamped.
 */
export function collectTermsChain(db: DB, now = Date.now()): {
  basis: number; terms: number; notes: string[];
} {
  const notes: string[] = [];
  const basisUpsert = db.prepare(`
    INSERT INTO terms_basis (surface_key, basis, source, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(surface_key, basis) DO UPDATE SET last_seen = excluded.last_seen`);
  const termsUpsert = db.prepare(`
    INSERT INTO processing_terms (surface_key, kind, value, as_of, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(surface_key, kind) DO UPDATE SET
      last_seen = excluded.last_seen,
      value     = COALESCE(processing_terms.value, excluded.value),
      as_of     = COALESCE(processing_terms.as_of, excluded.as_of)`);

  const surfaces = db.prepare(
    'SELECT surface_key, vendor FROM ai_surfaces',
  ).all() as unknown as { surface_key: string; vendor: string | null }[];
  const surfaceByVendor = new Map<string, string>();
  for (const s of surfaces) if (s.vendor) surfaceByVendor.set(s.vendor, s.surface_key);

  let basisCount = 0;
  let termsCount = 0;

  // 1. The vendor's own account record: vendor_identities.plan, an HMAC-keyed
  //    row another module writes; here it is only ever read.
  const identities = db.prepare(
    'SELECT vendor, plan, auth_path FROM vendor_identities WHERE plan IS NOT NULL',
  ).all() as unknown as { vendor: string; plan: string; auth_path: string | null }[];
  for (const v of identities) {
    const surfaceKey = surfaceByVendor.get(v.vendor);
    if (!surfaceKey) continue;
    basisUpsert.run(surfaceKey, v.plan,
      `vendor_identities${v.auth_path ? ` (${v.auth_path.replace(/^\/Users\/[^/]+/, '~')})` : ''}`, now, now);
    basisCount++;
  }

  // 2. The admin terms pack: declared entries, each as-of stamped.
  const pack = loadTermsPack();
  if (pack) {
    const known = new Set(surfaces.map((s) => s.surface_key));
    let unknown = 0;
    for (const e of pack.entries) {
      if (!PACK_KIND_TABLE.has(e.kind)) continue;
      if (!known.has(e.surface_key)) { unknown++; continue; }
      if (e.kind === 'plan') {
        basisUpsert.run(e.surface_key, e.value,
          `terms_pack${pack.version !== null ? ` v${pack.version}` : ''} (${pack.source.replace(/^\/Users\/[^/]+/, '~')})`,
          now, now);
        basisCount++;
      } else {
        termsUpsert.run(e.surface_key, e.kind, e.value, pack.asOf, now, now);
        termsCount++;
      }
    }
    notes.push(`terms pack: ${pack.entries.length} entr(ies)${pack.version !== null ? `, v${pack.version}` : ''}` +
      (unknown ? `, ${unknown} naming unknown surfaces` : ''));
  } else {
    notes.push('no terms pack installed — processing terms stay NULL (declared, never inferred)');
  }

  return { basis: basisCount, terms: termsCount, notes };
}
