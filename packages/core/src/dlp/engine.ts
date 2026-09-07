import { createHash } from 'node:crypto';
import { contentOf, type Content, hashOf } from '../content';
import { DETECTORS, PACK_VERSION, packChecksum, type Detector } from './pack';
import { fingerprintOf } from './keychain';

/**
 * The out-of-path scan engine (#123): keyword prefilter → provider regex →
 * entropy with stopwords, under a hard byte budget, with exclusions enforced at
 * open() and a counted receipt for everything skipped or unreadable.
 *
 * A scan never stores content: the sighting is (fingerprint, location, length)
 * and the value stays in the file — the just-in-time evidence viewer re-reads
 * it at view time, so "no content stored" survives a secret scanner living
 * inside the store's own process.
 */

export interface RawSighting {
  detector: string;
  /** The matched value — in scope ONLY here, fingerprinted immediately. */
  value: string;
  byteOffset: number;
  byteLength: number;
}

export interface ScanReceipt {
  bytesScanned: number;
  bytesSkipped: number;      // exclusions: never opened
  bytesUnreadable: number;   // the honest denominator: opened but not read
  filesScanned: number;
  filesSkipped: number;
  filesUnreadable: number;
  packVersion: number;
  packChecksum: string;
}

/** Exclusion enforced BEFORE open: these paths are never read at all. */
export function isExcluded(path: string, exclusions: string[]): boolean {
  return exclusions.some((e) => path === e || path.startsWith(e.endsWith('/') ? e : e + '/'));
}

/** Shannon entropy per character — the catch-all's guard, not a guess. */
export function shannon(value: string): number {
  if (!value.length) return 0;
  const freq = new Map<string, number>();
  for (const c of value) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Scans one buffer. The content is branded (`Content`) — it can only be
 * measured, hashed or fingerprinted here, and it leaves this function as a
 * fingerprint. Line/column mapping is the CALLER's concern (sinks know their
 * geometry); we work in byte offsets within the given buffer.
 */
export function scanBuffer(buf: Content, bufferByteOffset = 0): RawSighting[] {
  const out: RawSighting[] = [];
  for (const d of DETECTORS) {
    // Prefilter: the whole buffer is lowercased once per detector's keyword set;
    // a keyword miss skips the regex entirely (the Gitleaks two-step).
    const lower = buf.toLowerCase();
    if (!d.keywords.some((k) => lower.includes(k.toLowerCase()))) continue;

    d.pattern.lastIndex = 0;
    for (const m of buf.matchAll(d.pattern)) {
      const value = m[1] ?? m[0];
      if (!value || value.length < 12) continue;
      if (d.stopwords?.test(value)) continue;
      if (d.minEntropy !== undefined && shannon(value) < d.minEntropy) continue;

      const byteOffset = bufferByteOffset + Buffer.byteLength(buf.slice(0, m.index ?? 0), 'utf8');
      out.push({
        detector: d.id,
        value,
        byteOffset,
        byteLength: Buffer.byteLength(value, 'utf8'),
      });
    }
  }
  return out;
}

/** The full pack identity, verified before any scan runs. */
export function packIdentity(): { version: number; checksum: string } {
  return { version: PACK_VERSION, checksum: packChecksum() };
}

/** Fingerprint a sighting's value — the ONLY transformation into the store. */
export function toFingerprint(s: RawSighting, now = Date.now()): string {
  return fingerprintOf(s.value, now);
}

/** A fixture classification (#138): test paths never page anyone. */
export function classifyStatus(path: string): 'fixture' | 'candidate' {
  return /(?:^|\/)(?:test|tests|fixtures?|__tests__|\.spec|examples?)(?:\/|\.|-|_)/i.test(path)
    ? 'fixture'
    : 'candidate';
}

/** The stable digest a sink uses for its scan cursor (no content retained). */
export function sinkDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Escapes the branded type at the sink boundary: raw bytes become Content. */
export function asContent(raw: string): Content {
  return contentOf(raw);
}

/** The digest form the engine may retain for dedupe (never the text). */
export function digestOf(c: Content): string {
  return hashOf(c);
}
