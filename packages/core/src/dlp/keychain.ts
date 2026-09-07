import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

/**
 * The fingerprint key, held in the macOS Keychain (#127) — not in a file, not
 * in the store, rotatable by epoch. A fingerprint is HMAC-SHA256(key, value)
 * truncated to 128 bits: enough to correlate the same secret across sinks and
 * across time, and useless for reconstructing the value. Epoch rotation keeps
 * a leaked fingerprint from being linkable forever: the key rotates every 30
 * days, and sightings record the epoch they were minted under.
 *
 * Falls back to nothing on non-macOS (the product is macOS-only; a missing
 * Keychain is a hard error for a security feature, not a silent downgrade).
 */

const SERVICE = 'vole-dlp-fingerprint';
const EPOCH_MS = 30 * 24 * 3600_000;

function currentEpoch(now = Date.now()): number {
  return Math.floor(now / EPOCH_MS);
}

/** Reads (creating on first use) the Keychain-held key for this epoch. */
export function fingerprintKey(now = Date.now()): string {
  const epoch = currentEpoch(now);
  const account = `epoch-${epoch}`;
  const read = spawnSync(
    'security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
    { encoding: 'utf8', timeout: 4000 },
  );
  if (read.status === 0 && read.stdout.trim()) return read.stdout.trim();
  if (read.status !== 0 && /could not be found/i.test(read.stderr ?? '')) {
    // Create: 32 hex chars of randomness, stored in the Keychain.
    const key = createHmac('sha256', String(epoch) + process.pid + Math.random())
      .update(SERVICE)
      .digest('hex');
    execFileSync(
      'security',
      ['add-generic-password', '-s', SERVICE, '-a', account, '-w', key, '-U'],
      { timeout: 4000, stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return key;
  }
  throw new Error(`Keychain unavailable for the DLP fingerprint key: ${read.stderr?.trim() ?? 'unknown'}`);
}

/** A truncated, epoch-stamped HMAC — the only form a secret may take in Vole. */
export function fingerprintOf(value: string, now = Date.now()): string {
  return `fp${currentEpoch(now)}:${createHmac('sha256', fingerprintKey(now)).update(value).digest('hex').slice(0, 32)}`;
}
