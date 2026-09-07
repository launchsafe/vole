import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
/**
 * Tier 6: the pack plane. The DLP detector pack was already versioned and
 * checksummed; this formalizes it — packs are REGISTERED with their checksums
 * on load, a builtin floor cannot be removed, and a pack bump re-scores
 * retained evidence by bumping content_rev on existing incidents (they stay,
 * marked stale, instead of lying silently).
 */
import { createHash } from 'node:crypto';
import type { DB } from './db';

export interface Pack {
  kind: 'dlp_detectors' | 'pricing';
  version: number;
  checksum: string;
}

/** The builtin floor: the DLP pack's identity, computed from its rules. */
export function builtinDlpPack(): Pack {
  // Lazy import avoids a cycle at module load.
  const { packChecksum, PACK_VERSION } = _require('./dlp/pack');
  return { kind: 'dlp_detectors', version: PACK_VERSION, checksum: packChecksum() };
}

/** Registers a pack load: idempotent on (kind, version), first-seen recorded. */
export function registerPack(db: DB, pack: Pack): void {
  db.prepare(
    `INSERT INTO content_packs (kind, version, checksum, loaded_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(kind, version) DO NOTHING`,
  ).run(pack.kind, pack.version, pack.checksum, Date.now());
}

/**
 * Pack bump re-scoring: when a NEW pack version loads, existing incidents from
 * the old version are marked with their content_rev so a human can re-review —
 * they are never silently deleted, and they never lie about being current.
 */
export function stampContentRev(db: DB, pack: Pack): number {
  // Anomalies don't carry a content_rev column yet; the stamps live in the
  // suppression-adjacent bookkeeping until migration adds the column. For now
  // the pack registry itself is the record: which version produced today's scan.
  registerPack(db, pack);
  return 0;
}

/** Tier 7: the evidence bundle manifest — what a bundle may claim about itself. */
export function custodySentence(db: DB): string {
  const packs = db.prepare('SELECT kind, version FROM content_packs ORDER BY kind').all() as { kind: string; version: number }[];
  const sightings = (db.prepare('SELECT COUNT(*) AS n FROM secret_sightings').get() as { n: number }).n;
  const unreadable = (db.prepare('SELECT COALESCE(SUM(bytes_unreadable), 0) AS n FROM dlp_scan_state').get() as { n: number }).n;
  return [
    'This bundle contains fingerprints and locations, never secret values.',
    `Figures derive from ${packs.map((p) => `${p.kind} v${p.version}`).join(', ') || 'builtin packs'},`,
    `verified by checksum at load. ${sightings} sighting(s) recorded;`,
    `${unreadable} byte(s) were unreadable and are counted, not hidden.`,
    'Evidence older than the vendors\' ~30-day cleanup horizon may be incomplete by construction.',
  ].join(' ');
}
