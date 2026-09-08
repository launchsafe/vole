import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { ValidatorName } from './validators';

/**
 * The DLP detector pack — versioned, checksummed, verifiable offline
 * (tier 4, #117).
 *
 * Detectors are rows, not code: the pack lives in data/dlp-detectors.toml
 * (bundled like data/pricing.json), is parsed once here, and carries a sha256
 * over its canonical rows that the loader can verify before any byte is
 * scanned. A pack bump is a reviewable diff, and the pack version is stamped
 * onto dlp_scan_state so a bump can queue a re-scan of retained evidence.
 *
 * Lineage: keyword prefilter → provider regex → entropy with stopwords, the
 * Gitleaks/detect-secrets shape. Data-class rows additionally carry an offline
 * checksum validator (luhn/mod-97/mod-11/CRC32/JWT/PEM) because entropy alone
 * is a known false-positive engine, and salted hashes of known public example
 * values so a documentation fixture auto-classifies as a fixture.
 */

export interface Detector {
  id: string;
  /** credential | payment_card | iban | bank_account | jwt | private_key. */
  klass: string;
  /** Vendor namespace for credential shapes; null for data classes. */
  provider: string | null;
  /** Prefilter: at least one of these must appear (case-folded). Empty = always run. */
  keywords: string[];
  /** The value shape itself. */
  pattern: RegExp;
  /** Minimum entropy (Shannon, per character) for catch-alls. */
  minEntropy?: number;
  /** Known token shapes that are NOT secrets (test fixtures, placeholders). */
  stopwords?: RegExp;
  /** Offline checksum validator; gates the sighting (except crc32_tail). */
  validator?: ValidatorName;
  severity: 'critical' | 'warn' | 'info';
  note: string;
  /** Salted sha256 hashes of known public example values (fixture classifier). */
  exampleHashes: string[];
}

/** The salt for public-example literal hashes — public by design (the literals are public). */
export const PACK_SALT = 'vole:dlp:pack:v2';

interface RawDetector {
  version?: number;
  id: string;
  class: string;
  provider: string | null;
  keywords: string[];
  pattern: string;
  entropy?: number;
  stopwords?: string;
  validator?: ValidatorName;
  severity: 'critical' | 'warn' | 'info';
  note: string;
  examples?: string[];
}

/**
 * A TOML-subset reader: `key = value` lines under `[[detector]]` tables.
 * Supports raw single-quoted strings, double-quoted strings, integers, and
 * arrays of single-quoted strings — exactly what data/dlp-detectors.toml
 * uses, no more. Malformed input throws: a security rule set must fail loud.
 * ponytail: swap for a real TOML parser only if the pack needs nested tables.
 */
function parseToml(text: string): { version: number; detectors: RawDetector[] } {
  let version = 1;
  const detectors: RawDetector[] = [];
  let current: RawDetector | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const section = line.match(/^\[\[(\w+)\]\]$/);
    if (section) {
      current = section[1] === 'detector'
        ? { id: '', class: '', provider: null, keywords: [], pattern: '', severity: 'warn', note: '', exampleHashes: [] }
        : null;
      if (current) detectors.push(current);
      continue;
    }
    const kv = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!kv) throw new Error(`dlp-detectors.toml: unexpected line: ${line}`);
    const [, key, rhs] = kv;
    if (!current) {
      if (key !== 'version') throw new Error(`dlp-detectors.toml: top-level key outside a table: ${key}`);
      version = parseInt(rhs!.trim(), 10);
      continue;
    }
    const value = (() => {
      const t = rhs!.trim();
      if (t.startsWith('[')) {
        const items = t.match(/'([^']*)'|"([^"]*)"|[0-9]+/g) ?? [];
        return items.map((i) => (i.startsWith("'") || i.startsWith('"') ? i.slice(1, -1) : parseInt(i, 10)));
      }
      if (t.startsWith("'")) return t.slice(1, -1);
      if (t.startsWith('"')) {
        try {
          return JSON.parse(t) as string;
        } catch {
          return t.slice(1, -1);
        }
      }
      if (/^-?\d+$/.test(t)) return parseInt(t, 10);
      if (t === 'null') return null;
      return t;
    })();
    switch (key) {
      case 'version': version = value as number; break;
      case 'id': current.id = value as string; break;
      case 'class': current.class = value as string; break;
      case 'provider': current.provider = value as string | null; break;
      case 'keywords': current.keywords = value as string[]; break;
      case 'pattern': current.pattern = value as string; break;
      case 'entropy': current.entropy = value as number; break;
      case 'stopwords': current.stopwords = value as string; break;
      case 'validator': current.validator = value as ValidatorName; break;
      case 'severity': current.severity = value as RawDetector['severity']; break;
      case 'note': current.note = value as string; break;
      case 'examples': current.examples = value as string[]; break;
      default: throw new Error(`dlp-detectors.toml: unknown key ${key}`);
    }
  }
  return { version, detectors };
}

function loadPack(): { version: number; detectors: Detector[] } {
  const file = new URL('../data/dlp-detectors.toml', import.meta.url);
  const text = readFileSync(file, 'utf8');
  const parsed = parseToml(text);
  const detectors: Detector[] = parsed.detectors.map((d) => ({
    id: d.id,
    klass: d.class,
    provider: d.provider,
    keywords: d.keywords,
    pattern: new RegExp(d.pattern, 'g'),
    minEntropy: d.entropy,
    stopwords: d.stopwords ? new RegExp(d.stopwords, 'i') : undefined,
    validator: d.validator,
    severity: d.severity,
    note: d.note,
    exampleHashes: d.examples ?? [],
  }));
  if (detectors.some((d) => !d.id || !d.pattern.source)) {
    throw new Error('dlp-detectors.toml: a detector row is missing id or pattern');
  }
  return { version: parsed.version, detectors };
}

const PACK = loadPack();

export const PACK_VERSION = PACK.version;
export const DETECTORS: Detector[] = PACK.detectors;

/** All salted public-example hashes in the pack — the fixture classifier's set. */
export const PUBLIC_EXAMPLE_HASHES: Set<string> = new Set(
  DETECTORS.flatMap((d) => d.exampleHashes),
);

/** The salted hash of a matched value, for the fixture classifier. */
export function exampleHashOf(value: string): string {
  return createHash('sha256').update(PACK_SALT + value).digest('hex');
}

/** The pack's offline checksum: over the canonical rows, stable across processes. */
export function packChecksum(): string {
  const canonical = DETECTORS
    .map((d) =>
      [d.id, d.klass, d.provider ?? '', d.keywords.join(','), d.pattern.source,
       d.minEntropy ?? '', d.validator ?? '', d.stopwords?.source ?? '', d.severity,
       d.note, d.exampleHashes.join(',')].join('|'))
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

/** The data-class entry id a sighting records (class_entry_id). */
export function classEntryIdOf(d: Detector): string {
  return `${d.klass}:${d.id}`;
}
