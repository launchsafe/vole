/**
 * The evidence bundle (Tier 7): a JSON manifest with the custody sentence —
 * what the bundle contains, which packs produced it, and what it is allowed
 * to claim about itself. Deny-by-default fields only; the registry is shared
 * with the export path.
 */
import { openDb } from '../db';
import { exportJson } from './export';
import { custodySentence } from '../packs';

const db = openDb();

const manifest = {
  bundle_version: 1,
  generated_at: new Date().toISOString(),
  custody_sentence: custodySentence(db),
  contents: {
    export: JSON.parse(exportJson()),
  },
  chain_of_evidence: {
    store_schema: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    packs: db.prepare('SELECT kind, version, checksum FROM content_packs').all(),
    scanners: db.prepare('SELECT scanner, last_started_at FROM scan_state').all(),
  },
};

console.log(JSON.stringify(manifest, null, 1));
