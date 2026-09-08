import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { DB } from '../db';
import builtin from '../data/advisories.json';
import { fingerprintOf } from '../dlp/keychain';

/**
 * The shipped offline advisory floor table (tier 6 #57), version residency
 * (tier 6 #58) and hunt-time fingerprinting (tier 6 #31).
 *
 * The floor table is only as current as the Vole build: it can never claim a
 * version is safe, only that no shipped advisory names it — the UI must read
 * 'no advisory data' rather than 'clean'. Vole makes no network call to
 * refresh it. An admin-authored override (~/.vole/advisories.json) merges on
 * top exactly as pricing.json's does, and only that override may carry a
 * burned value for the fingerprint compare: the value lives in the pack, in
 * memory, never in the store.
 */

export interface Advisory {
  id: string;
  tool: string;
  cve: string | null;
  fixed_in: string[];
  affects_range: string | null;
  title: string;
  url: string | null;
  published: string | null;
  class: string | null;
  /** Admin-authored override only: the already-public burned credential value. */
  value?: string;
}

export interface AdvisoryFile {
  as_of: string;
  source: string;
  entries: Advisory[];
}

export function loadAdvisories(
  overridePath?: string,
): { file: AdvisoryFile; path: string; overridden: boolean } {
  const base = builtin as AdvisoryFile;
  if (!overridePath || !existsSync(overridePath)) {
    return { file: base, path: base.source, overridden: false };
  }
  try {
    const ov = JSON.parse(readFileSync(overridePath, 'utf8')) as AdvisoryFile;
    if (!Array.isArray(ov.entries)) return { file: base, path: base.source, overridden: false };
    const byId = new Map(base.entries.map((e) => [e.id, e]));
    for (const e of ov.entries) if (e.id) byId.set(e.id, e);
    return { file: { ...base, ...ov, entries: [...byId.values()] }, path: overridePath, overridden: true };
  } catch {
    // A malformed override is ignored — advisories must never break a hunt.
    return { file: base, path: base.source, overridden: false };
  }
}

/** Content signature of the effective advisory set (feeds hunt_runs). */
export function advisoriesSignature(entries: Advisory[]): string {
  return createHash('sha256')
    .update(entries.map((e) => `${e.id}|${e.affects_range ?? ''}|${e.fixed_in.join(',')}`).join('\n'))
    .digest('hex');
}

// ── semver: the smallest correct comparator for the ranges the table uses ────

function versionParts(v: string): number[] {
  return v.split('.').map((p) => Number(p.replace(/[^0-9].*$/, '')) || 0);
}

/** Numeric dot-version compare; prerelease suffixes are ignored (none in the table). */
export function versionCmp(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Matches a version against an affects_range like "<0.1.14", "=1.84.0",
 * ">=2.0 <3.0" or a comma list. NULL range or unparseable clause → NULL —
 * uncomputable, never false, never 'safe'.
 */
export function rangeMatches(range: string | null, version: string): boolean | null {
  if (range === null || range.trim() === '') return null;
  let anyClause = false;
  for (const clause of range.split(/[\s,]+/).filter(Boolean)) {
    const m = clause.match(/^(<=|>=|<|>|=)?(.+)$/);
    if (!m) return null;
    const op = m[1] ?? '=';
    const c = versionCmp(version, m[2]!);
    const ok = op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '>=' ? c >= 0 : c === 0;
    if (!ok) return false;
    anyClause = true;
  }
  return anyClause ? true : null;
}

// ── Version residency (tier 6 #58) ───────────────────────────────────────────

export interface VersionResidency {
  tool: string;
  version: string;
  first_seen: number;
  last_seen: number;
  sessions: number;
  /** first_seen sits at the answerable_from floor: a left-open band, never a start date. */
  left_open: boolean;
}

/**
 * Exposure intervals per version from usage_events.cli_version. An interval is
 * bounded by answerable_from: a version that ran before the oldest retained
 * row is invisible, and the first retained line reports first-observed, not
 * first-run.
 */
export function versionResidency(db: DB, horizonTs: number | null): VersionResidency[] {
  let rows: Array<{ tool: string; version: string; f: number; l: number; s: number }>;
  try {
    rows = db
      .prepare(
        `SELECT tool, cli_version AS version,
                MIN(COALESCE(observed_at, ts)) AS f, MAX(ts) AS l,
                COUNT(DISTINCT session_id) AS s
           FROM usage_events WHERE cli_version IS NOT NULL
          GROUP BY tool, cli_version`,
      )
      .all() as typeof rows;
  } catch {
    return [];
  }
  return rows.map((r) => ({
    tool: r.tool,
    version: r.version,
    first_seen: r.f,
    last_seen: r.l,
    sessions: r.s,
    left_open: horizonTs !== null && r.f <= horizonTs,
  }));
}

export type AdvisoryVerdict = 'confirmed' | 'cleared' | 'unanswerable' | 'not_seen';

export interface AdvisoryExposure {
  advisory: Advisory;
  verdict: AdvisoryVerdict;
  /** The version bands inside the affected range (empty unless confirmed). */
  intervals: VersionResidency[];
  /** The figures that produced the verdict. */
  basis: string;
}

/**
 * Intersects each advisory's affected range with the observed version
 * intervals. `unanswerable` is the honest verdict whenever every relevant band
 * is left-open at the answerable floor — the machine may have been on the
 * vulnerable version earlier and the store cannot see it.
 */
export function advisoryExposure(
  advisories: Advisory[],
  residency: VersionResidency[],
  horizonTs: number | null,
): AdvisoryExposure[] {
  return advisories.map((a) => {
    const rows = residency.filter((r) => r.tool === a.tool);
    if (!rows.length) {
      return {
        advisory: a,
        verdict: 'not_seen',
        intervals: [],
        basis: `no version recorded for ${a.tool}` +
          (horizonTs !== null ? `; answerable only from ${new Date(horizonTs).toISOString().slice(0, 10)}` : ''),
      };
    }
    const inRange = rows.filter((r) => rangeMatches(a.affects_range, r.version) === true);
    if (inRange.length) {
      return {
        advisory: a,
        verdict: 'confirmed',
        intervals: inRange,
        basis: inRange
          .map((r) => `${r.version} observed ${new Date(r.first_seen).toISOString().slice(0, 10)}–${new Date(r.last_seen).toISOString().slice(0, 10)} (${r.sessions} session(s))`)
          .join('; '),
      };
    }
    const leftOpen = rows.some((r) => r.left_open);
    return {
      advisory: a,
      verdict: leftOpen ? 'unanswerable' : 'cleared',
      intervals: [],
      basis: leftOpen
        ? `no version in "${a.affects_range ?? 'uncomputable'}" observed, but the first observed version sits at the answerable floor — earlier versions unknown`
        : `observed versions (${rows.map((r) => r.version).join(', ')}) all outside "${a.affects_range ?? 'uncomputable'}"`,
    };
  });
}

// ── Hunt-time fingerprinting (tier 6 #31) ────────────────────────────────────

export interface FingerprintMatch {
  advisory_id: string;
  fingerprint: string;
  epoch: number;
  first_seen: number;
  last_seen: number;
  sink_key: string;
  path: string;
  byte_offset: number;
}

export interface FingerprintHuntResult {
  advisory_id: string;
  matches: FingerprintMatch[];
  /** The "value not stored" receipt naming the hunt that proved it. */
  receipt: string;
}

const EPOCH_MS = 30 * 24 * 3600_000;

/**
 * Compares an advisory's burned value against the epoch-rotated fingerprints
 * already in secret_sightings. The fingerprint is computed HERE, at hunt time,
 * under the epochs the store actually holds — the value never touches the
 * store, and a negative means "no fingerprint of this exists", not "this key
 * was never in a transcript" (a shape no shipped detector recognised was never
 * fingerprinted).
 */
export function huntFingerprints(
  db: DB,
  advisories: Advisory[],
  fp: (value: string, now?: number) => string = fingerprintOf,
  now: number = Date.now(),
): FingerprintHuntResult[] {
  const out: FingerprintHuntResult[] = [];
  let epochs: number[];
  try {
    epochs = [
      ...new Set(
        (db.prepare('SELECT DISTINCT fingerprint FROM secret_sightings').all() as Array<{ fingerprint: string }>)
          .map((r) => Number(r.fingerprint.match(/^fp(\d+):/)?.[1]))
          .filter((n) => Number.isFinite(n)),
      ),
    ];
  } catch {
    epochs = [];
  }
  const currentEpoch = Math.floor(now / EPOCH_MS);
  if (!epochs.includes(currentEpoch)) epochs.push(currentEpoch);
  for (const a of advisories) {
    if (!a.value) continue;
    const matches: FingerprintMatch[] = [];
    for (const epoch of epochs) {
      const fingerprint = fp(a.value, epoch * EPOCH_MS + 1);
      let rows: Array<{
        first_seen: number;
        last_seen: number;
        sink_key: string;
        path: string;
        byte_offset: number;
      }>;
      try {
        rows = db
          .prepare('SELECT first_seen, last_seen, sink_key, path, byte_offset FROM secret_sightings WHERE fingerprint = ?')
          .all(fingerprint) as typeof rows;
      } catch {
        continue;
      }
      for (const r of rows) {
        matches.push({ advisory_id: a.id, fingerprint, epoch, ...r });
      }
    }
    out.push({
      advisory_id: a.id,
      matches,
      receipt: 'value not stored — fingerprint recomputed at hunt time under the sighting epochs',
    });
  }
  return out;
}
