/**
 * Tier 6: the pack plane — facade.
 *
 * The implementation lives in ./packs/*; this module keeps the names the
 * scanner and the evidence bundle already import (builtinDlpPack,
 * registerPack, stampContentRev, custodySentence) and re-exports the rest.
 */
import type { DB } from './db';

export * from './packs/registry';
export * from './packs/pricing-pack';
export * from './packs/suppression';
export * from './packs/rescore';
export * from './packs/policy';
export * from './packs/comparability';
export * from './packs/baseline';
export * from './packs/controls';
export * from './packs/preflight';

import { builtinPacks, activePack } from './packs/registry';

/** Legacy shape the DLP scanner imports: the builtin floor pack identity. */
export interface Pack {
  kind: 'dlp_detectors' | 'pricing';
  version: number;
  checksum: string;
}

export function builtinDlpPack(): Pack {
  const p = builtinPacks().find((b) => b.kind === 'dlp_detectors');
  return { kind: 'dlp_detectors', version: p?.version ?? 1, checksum: p?.checksum ?? '' };
}

/** Registers a pack load: idempotent on (kind, version), first-seen recorded. */
export function registerPack(db: DB, pack: Pack): void {
  db.prepare(
    `INSERT INTO content_packs (kind, version, checksum, loaded_at, trust, signature, path, active)
     VALUES (?, ?, ?, ?, 'builtin_floor', NULL, NULL, 1)
     ON CONFLICT(kind, version) DO NOTHING`,
  ).run(pack.kind, pack.version, pack.checksum, Date.now());
}

/**
 * Pack bump re-scoring: existing incidents from the old version are stamped
 * with the pack revision that produced them (NULL-only widening) so a human
 * can re-review — they are never silently deleted, and they never lie about
 * being current. See packs/rescore.ts for the bump orchestration.
 */
export function stampContentRev(db: DB, pack: Pack): number {
  const prev = (db.prepare('SELECT MAX(version) AS v FROM content_packs WHERE kind = ?').get(pack.kind) as { v: number | null }).v;
  return stamp(db, pack, prev ?? pack.version);
}

import { stampContentRev as stamp } from './packs/rescore';

/** Tier 7: the evidence bundle manifest — what a bundle may claim about itself. */
export function custodySentence(db: DB): string {
  const kinds = (db.prepare('SELECT DISTINCT kind FROM content_packs ORDER BY kind').all() as { kind: string }[]).map((k) => k.kind);
  const packs = kinds.map((k) => {
    const p = activePack(db, k);
    return `${k} v${p.version}`;
  });
  const sightings = (db.prepare('SELECT COUNT(*) AS n FROM secret_sightings').get() as { n: number }).n;
  const unreadable = (db.prepare('SELECT COALESCE(SUM(bytes_unreadable), 0) AS n FROM dlp_scan_state').get() as { n: number }).n;
  return [
    'This bundle contains fingerprints and locations, never secret values.',
    `Figures derive from ${packs.join(', ') || 'builtin packs'},`,
    `verified by checksum at load. ${sightings} sighting(s) recorded;`,
    `${unreadable} byte(s) were unreadable and are counted, not hidden.`,
    'Evidence older than the vendors\' ~30-day cleanup horizon may be incomplete by construction.',
  ].join(' ');
}
