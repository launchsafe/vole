import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { paths } from '../paths';
import type { DB } from '../db';

/**
 * The fingerprint key, held in the macOS Keychain (#127) — not in a file, not
 * in the store, rotatable by epoch. A fingerprint is HMAC-SHA256(key, value)
 * truncated to 128 bits: enough to correlate the same secret across sinks and
 * across time, and useless for reconstructing the value. Epoch rotation keeps
 * a leaked fingerprint from being linkable forever: the key rotates every 30
 * days, and sightings record the epoch they were minted under in the
 * fingerprint prefix (fp<epoch>:…), so pre-rotation fingerprints stay
 * queryable but never silently merge into the new epoch.
 *
 * When the Keychain is unavailable (non-macOS, headless CI, a locked
 * keychain), the collector falls back to a 0600 file under ~/.vole and every
 * consumer can see the weaker guarantee via keyStore() — visible, not silent.
 * Any process running as the same user can read either store once the ACL is
 * granted; this defends against file-scraping agents and repo scanners, not
 * against malware already running as the user.
 */

const SERVICE = 'vole-dlp-fingerprint';
const EPOCH_MS = 30 * 24 * 3600_000;

function currentEpoch(now = Date.now()): number {
  return Math.floor(now / EPOCH_MS);
}

/** The epoch a fingerprint minted `now` would carry (correlation's reference). */
export function currentFingerprintEpoch(now = Date.now()): number {
  return currentEpoch(now);
}

/** The 0600-file fallback's location — derived from the store's own root. */
function fallbackKeyPath(): string {
  return join(dirname(paths.db()), 'dlp-fingerprint.key');
}

let keyCache: { epoch: number; key: string; store: 'keychain' | 'file' } | null = null;
let keyOverride: string | null = null;

/** Test/CI seam: pins the key so no Keychain item and no file is ever touched. */
export function setFingerprintKeyOverride(key: string | null): void {
  keyOverride = key;
  keyCache = null;
}

function freshKeyMaterial(): string {
  return randomBytes(32).toString('hex');
}

function readFromFile(epoch: number): string {
  const dir = dirname(fallbackKeyPath());
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const account = `epoch-${epoch}`;
  const file = fallbackKeyPath();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    if (parsed[account]) return parsed[account];
  } catch {
    /* absent or malformed: (re)create below */
  }
  const key = freshKeyMaterial();
  const parsed = existsSync(file)
    ? (() => { try { return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>; } catch { return {}; } })()
    : {};
  parsed[account] = key;
  writeFileSync(file, JSON.stringify(parsed), { mode: 0o600 });
  chmodSync(file, 0o600); // umask cannot loosen what the badge prints
  return key;
}

/** Reads (creating on first use) the Keychain-held key for this epoch. */
export function fingerprintKey(now = Date.now()): string {
  return keyWithStore(now).key;
}

/** The key plus WHERE it lives — 'file' renders red in Settings -> Privacy. */
export function keyWithStore(now = Date.now()): { key: string; store: 'keychain' | 'file' } {
  const epoch = currentEpoch(now);
  if (keyOverride) return { key: keyOverride, store: 'keychain' };
  if (keyCache && keyCache.epoch === epoch) return { key: keyCache.key, store: keyCache.store };
  const account = `epoch-${epoch}`;
  const read = spawnSync(
    'security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
    { encoding: 'utf8', timeout: 4000 },
  );
  if (read.status === 0 && read.stdout.trim()) {
    keyCache = { epoch, key: read.stdout.trim(), store: 'keychain' };
    return { key: keyCache.key, store: 'keychain' };
  }
  if (read.status !== 0 && /could not be found/i.test(read.stderr ?? '')) {
    // Create: 32 random bytes, stored in the Keychain.
    const key = freshKeyMaterial();
    try {
      execFileSync(
        'security',
        ['add-generic-password', '-s', SERVICE, '-a', account, '-w', key, '-U'],
        { timeout: 4000, stdio: ['ignore', 'ignore', 'ignore'] },
      );
      keyCache = { epoch, key, store: 'keychain' };
      return { key, store: 'keychain' };
    } catch {
      // Keychain present but not writable (locked, no UI session): the 0600
      // file fallback — recorded, never silent.
      const fileKey = readFromFile(epoch);
      keyCache = { epoch, key: fileKey, store: 'file' };
      return { key: fileKey, store: 'file' };
    }
  }
  // No Keychain at all (non-macOS, security(1) missing): the 0600 file.
  const fileKey = readFromFile(epoch);
  keyCache = { epoch, key: fileKey, store: 'file' };
  return { key: fileKey, store: 'file' };
}

/** Where the key currently lives — the Settings badge's data source. */
export function keyStore(now = Date.now()): 'keychain' | 'file' {
  return keyWithStore(now).store;
}

/** A truncated, epoch-stamped HMAC — the only form a secret may take in Vole. */
export function fingerprintOf(value: string, now = Date.now()): string {
  return `fp${currentEpoch(now)}:${createHmac('sha256', fingerprintKey(now)).update(value).digest('hex').slice(0, 32)}`;
}

/** The epoch a fingerprint was minted under (from its prefix); null if malformed. */
export function epochOfFingerprint(fingerprint: string): number | null {
  const m = /^fp(\d+):/.exec(fingerprint);
  return m ? parseInt(m[1]!, 10) : null;
}

/**
 * Rotation governance (#127): the count of sighting rows that would become
 * uncorrelatable if the key rotated now — the number the Rotate button must
 * quote before anyone clicks it. Correlation under a new epoch is by design
 * impossible for these rows (that is what rotation is for), so they are
 * excluded from cross-sink correlation and flagged, never silently merged.
 */
export function uncorrelatableCount(db: DB, now = Date.now()): number {
  const epoch = currentEpoch(now);
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM secret_sightings WHERE fingerprint NOT LIKE 'fp' || ? || ':%'")
    .get(String(epoch)) as { n: number };
  return row.n;
}

/**
 * Mints the NEXT epoch's key early (the current epoch keeps signing until it
 * ticks over). Returns the epoch that will become current — the caller quotes
 * it and the uncorrelatable count in the confirm step.
 */
export function rotateEpoch(now = Date.now()): { nextEpoch: number; store: 'keychain' | 'file' } {
  const nextEpoch = currentEpoch(now) + 1;
  const { store } = keyWithStore(nextEpoch * EPOCH_MS + 1);
  return { nextEpoch, store };
}
