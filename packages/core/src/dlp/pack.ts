import { createHash } from 'node:crypto';

/**
 * The DLP detector pack — versioned, checksummed, verifiable offline.
 *
 * Lineage: keyword prefilter → provider regex → entropy with stopwords, the
 * Gitleaks/detect-secrets shape. Every rule names what it matches and what it
 * must never match, because a false positive in a security product is a
 * pager-incident: entropy rules carry stopwords and a length floor, and the
 * whole pack carries a sha256 the loader verifies before any byte is scanned.
 *
 * The pack is data, not code: a bump re-scores retained evidence (content_rev
 * on incidents is the Tier 6 continuation of this property).
 */

export interface Detector {
  id: string;
  /** Prefilter: at least one of these words must appear within the window. */
  keywords: string[];
  /** The value shape itself. */
  pattern: RegExp;
  /** Minimum entropy (Shannon, per character) for catch-alls. */
  minEntropy?: number;
  /** Known token shapes that are NOT secrets (test fixtures, placeholders). */
  stopwords?: RegExp;
  severity: 'critical' | 'warn' | 'info';
  note: string;
}

export const PACK_VERSION = 1;

export const DETECTORS: Detector[] = [
  {
    id: 'aws-access-key',
    keywords: ['AKIA', 'aws'],
    pattern: /\b(AKIA[0-9A-Z]{16})\b/g,
    severity: 'critical',
    note: 'AWS access key id — the 20-char AKIA shape',
  },
  {
    id: 'openai-api-key',
    keywords: ['sk-', 'openai', 'api_key', 'apikey'],
    pattern: /\b(sk-[A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/g,
    stopwords: /sk-(test|example|your|xxx|placeholder|123456)/i,
    severity: 'critical',
    note: 'OpenAI-style API key',
  },
  {
    id: 'anthropic-api-key',
    keywords: ['sk-ant-', 'anthropic'],
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/g,
    severity: 'critical',
    note: 'Anthropic API key',
  },
  {
    id: 'github-token',
    keywords: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'github', 'token'],
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,})(?![A-Za-z0-9])/g,
    severity: 'critical',
    note: 'GitHub token (classic or fine-grained)',
  },
  {
    id: 'private-key-block',
    keywords: ['PRIVATE KEY'],
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    severity: 'critical',
    note: 'A private key block header — the key material follows',
  },
  {
    id: 'google-api-key',
    keywords: ['AIza', 'google'],
    pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/g,
    severity: 'warn',
    note: 'Google API key shape',
  },
  {
    id: 'slack-token',
    keywords: ['xox'],
    pattern: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    severity: 'warn',
    note: 'Slack token',
  },
  {
    id: 'high-entropy-assignment',
    keywords: ['api_key', 'apikey', 'secret', 'password', 'token', 'credential', 'auth_token'],
    pattern: /\b([A-Za-z0-9_\-]{32,64})\b/g,
    minEntropy: 3.5,
    stopwords: /(test|example|placeholder|your[_-]?key|changeme|xxxxxxxx)/i,
    severity: 'warn',
    note: 'high-entropy value assigned to a credential-shaped name — entropy with stopwords, never a bare length guess',
  },
];

/** The pack's offline checksum: over ids + patterns, stable across processes. */
export function packChecksum(): string {
  const canonical = DETECTORS
    .map((d) => `${d.id}|${d.keywords.join(',')}|${String(d.pattern)}|${d.minEntropy ?? ''}|${d.severity}`)
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}
