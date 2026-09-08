import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Content } from '../content';
import { contentOf, hashOf } from '../content';
import { paths } from '../paths';
import type { Direction } from '../types';
import { DETECTORS, PACK_VERSION, packChecksum, exampleHashOf, classEntryIdOf } from './pack';
import { runValidator } from './validators';
import { variants, type NormalisationBadge } from './normalise';
import { fingerprintOf } from './keychain';

/**
 * The out-of-path scan engine (#123): keyword prefilter → provider regex →
 * entropy with stopwords, under a hard byte budget, with exclusions enforced at
 * open() (one chokepoint, a counted skip receipt) and a pre-match
 * normalisation layer so encoded secrets are found, not just plain ones.
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
  /** Provenance badge: the normalisation view that found it ('' = raw text). */
  provenance: string;
  /** The data-class entry id (dlp pack row) that produced this sighting. */
  classEntryId: string | null;
  /** Which offline checksum ran and its outcome, e.g. 'luhn:ok' (never the value). */
  validatorChecked: string | null;
  /** Set when the VALUE is a known public example (AKIAIOSFODNN7EXAMPLE…). */
  fixtureReason: string | null;
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

/**
 * The exclusion manifest (tier 4, #120): the inalienable floor declaring
 * personal work out of scope. Either a bare array of absolute roots or
 * { "roots": [...] }. Cached per process — a scanner restart picks up edits.
 * ponytail: mtime-checked reload if admins hot-swap the manifest mid-day.
 */
let exclusionCache: { roots: string[]; stamp: string } | null = null;
export function loadExclusions(): string[] {
  // Revalidate on manifest mtime so an admin edit takes effect without a
  // restart — the chokepoint is called per file, so the stat is the whole cost.
  const files = paths.exclusionPaths();
  let stamp = '';
  for (const p of files) {
    try {
      const st = statSync(p);
      stamp += `${p}:${Math.trunc(st.mtimeMs)}:${st.size};`;
    } catch {
      stamp += `${p}:-;`;
    }
  }
  if (exclusionCache && exclusionCache.stamp === stamp) return exclusionCache.roots;
  const roots: string[] = [];
  for (const p of files) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { roots?: unknown }).roots)
          ? (parsed as { roots: unknown[] }).roots
          : null;
      if (!list) continue;
      roots.push(...list.filter((r): r is string => typeof r === 'string' && r.startsWith('/')));
    } catch {
      /* malformed manifest: that layer contributes nothing */
    }
  }
  exclusionCache = { roots, stamp };
  return roots;
}

export type OpenResult =
  | { kind: 'ok'; path: string; text: Content; size: number }
  | { kind: 'excluded'; path: string; size: number }
  | { kind: 'unreadable'; path: string; size: number | null; errno: string | null };

/**
 * THE chokepoint (tier 4, #120): every file the DLP engine opens goes through
 * here, and an excluded path is never opened — read-then-filter would leak the
 * fact that Vole could read it. Skips are counted, not hidden: the caller
 * books `size` into bytes_skipped so the denominator can prove the skip.
 */
export function openRootFile(absPath: string): OpenResult {
  let size: number | null = null;
  try {
    size = statSync(absPath).size;
  } catch {
    return { kind: 'unreadable', path: absPath, size: null, errno: 'ENOENT-or-ancestor' };
  }
  if (isExcluded(absPath, loadExclusions())) {
    return { kind: 'excluded', path: absPath, size };
  }
  try {
    const text = contentOf(readFileSync(absPath, 'utf8'));
    return { kind: 'ok', path: absPath, text, size };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { kind: 'unreadable', path: absPath, size, errno: err.code ?? String(err.message) };
  }
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

/** A hard ceiling on raw matches per detector per buffer. Without it, a binary
 *  sink (77MB of SQLite) produces millions of entropy candidates and the scan
 *  never finishes — the collector's FIRST pass hangs forever, the poll interval
 *  never arms, and the app reads as stale. Bounded work or no work. */
const MAX_MATCHES_PER_DETECTOR = 2000;

/** True when the buffer looks like binary (SQLite pages, encrypted blobs): the
 *  expensive entropy catch-all is skipped; the specific provider shapes still
 *  run — they are anchored prefixes, cheap even on binary. */
export function looksBinary(buf: string): boolean {
  const sample = buf.length > 8192 ? buf.slice(0, 8192) : buf;
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) control++;
  }
  return sample.length > 0 && control / sample.length > 0.05;
}

function scanOne(
  buf: Content,
  bufferByteOffset: number,
  provenance: string,
  binary: boolean,
  out: RawSighting[],
): void {
  const lower = buf.toLowerCase();
  for (const d of DETECTORS) {
    // The entropy catch-all is text-only: on binary it matches millions of
    // candidates and each pays a shannon() — the hang this guard exists for.
    if (binary && d.minEntropy !== undefined) continue;

    // Prefilter: the whole buffer is lowercased once per detector's keyword set;
    // a keyword miss skips the regex entirely (the Gitleaks two-step). Data-class
    // rows carry an EMPTY keyword list — always run — because a card number has
    // no keyword to lean on; their validator is the filter.
    if (d.keywords.length && !d.keywords.some((k) => lower.includes(k.toLowerCase()))) continue;

    d.pattern.lastIndex = 0;
    let matched = 0;
    for (const m of buf.matchAll(d.pattern)) {
      if (matched >= MAX_MATCHES_PER_DETECTOR) break;
      const value = m[1] ?? m[0];
      if (!value || value.length < 12) continue;
      if (d.stopwords?.test(value)) continue;
      if (d.minEntropy !== undefined && shannon(value) < d.minEntropy) continue;

      // Offline checksum: gates the sighting for every public scheme. crc32_tail
      // is computed and recorded but gates nothing — GitHub's placement is not
      // public, so a miss demotes nothing (see validators.ts).
      let validatorChecked: string | null = null;
      if (d.validator) {
        const ok = runValidator(d.validator, value);
        validatorChecked = `${d.validator}:${ok ? 'ok' : 'fail'}`;
        if (d.validator !== 'crc32_tail' && !ok) continue;
      }

      const byteOffset = bufferByteOffset + Buffer.byteLength(buf.slice(0, m.index ?? 0), 'utf8');
      out.push({
        detector: d.id,
        value,
        byteOffset,
        byteLength: Buffer.byteLength(value, 'utf8'),
        provenance,
        classEntryId: classEntryIdOf(d),
        validatorChecked,
        fixtureReason: d.exampleHashes.length && d.exampleHashes.includes(exampleHashOf(value))
          ? 'public_example_value'
          : null,
      });
      matched++;
    }
  }
}

/**
 * Scans one buffer through the normalisation layer: the raw text first, then
 * every distinct transform (JSON-unescape, percent-decode, base64-run decode,
 * zero-width strip, homoglyph fold), each sighting carrying the badge of the
 * view that found it. The content is branded (`Content`) — it can only be
 * measured, hashed or fingerprinted here, and it leaves this function as a
 * fingerprint. Byte offsets refer to the file for raw-view sightings and to
 * the normalised view otherwise (the stated one-decode-level limit).
 */
export function scanBuffer(buf: Content, bufferByteOffset = 0): RawSighting[] {
  const out: RawSighting[] = [];
  const binary = looksBinary(buf);
  const seen = new Set<string>();
  for (const v of variants(buf)) {
    const sub: RawSighting[] = [];
    scanOne(v.text, bufferByteOffset, v.badges.join('+'), binary, sub);
    for (const s of sub) {
      const key = `${s.detector}|${s.value}|${s.byteOffset}|${s.provenance}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
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

/** A fixture classification (#138): test paths and public examples never page anyone. */
export function classifyStatus(path: string): 'fixture' | 'candidate' {
  return /(?:^|\/)(?:test|tests|fixtures?|__tests__|__mocks__|\.spec|examples?|docs)(?:\/|\.|-|_)/i.test(path)
    ? 'fixture'
    : 'candidate';
}

/**
 * Fixture auto-classification with a REASON (tier 4, #138): the path glob or a
 * known public-example value (checked by the pack at match time via
 * `fixtureReason` on the sighting). The reason is always displayed, never
 * hidden, because a real key under tests/ is exactly the heuristic's blind spot.
 */
export function classifyFixture(
  path: string,
  sighting: Pick<RawSighting, 'fixtureReason'>,
): { status: 'fixture' | 'candidate'; fixtureReason: string | null } {
  if (sighting.fixtureReason) return { status: 'fixture', fixtureReason: sighting.fixtureReason };
  if (classifyStatus(path) === 'fixture') return { status: 'fixture', fixtureReason: 'test_path' };
  return { status: 'candidate', fixtureReason: null };
}

/**
 * Direction tagging (tier 4, #128), normalised across all content-bearing
 * collectors: 'a key was in a file we read' and 'a key was sent to Anthropic'
 * are never the same row. Collectors map their entry shape to one of these
 * and pass it to the sighting write — at-rest sinks use 'sink_at_rest'.
 *
 * NULL means "this surface exposes no direction" (Cursor, Antigravity) — the
 * schema's direction column is currently NOT NULL DEFAULT 'at_rest', so
 * collectors with no direction must widen that column first (integration
 * seam); until then they should not call this with 'unknown'.
 */
export type DirectionShape =
  | 'sink_at_rest'        // a file on disk the tool itself wrote
  | 'request_body'        // inside an outgoing request to a provider
  | 'response_body'       // inside a provider response (model_echoed class)
  | 'user_prompt'         // Claude user.message.content[].text, Codex userMessage
  | 'pasted_content'      // Claude last-prompt / history.jsonl pastedContents
  | 'tool_input'          // assistant tool_use.input, custom_tool_call.input
  | 'assistant_message';  // agent-authored prose

const DIRECTIONS: Record<DirectionShape, Direction> = {
  sink_at_rest: 'at_rest',
  request_body: 'at_wire',
  response_body: 'at_wire',
  user_prompt: 'human_pasted',
  pasted_content: 'human_pasted',
  tool_input: 'agent_typed',
  assistant_message: 'agent_typed',
};

export function directionOf(shape: DirectionShape): Direction {
  return DIRECTIONS[shape];
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

export type { NormalisationBadge };
