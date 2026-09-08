import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, insertAnomalies, type DB, type Scanner } from '../db';
import type { Anomaly, AnomalyRule } from '../types';
import { enumerateSinks } from './sinks';
import {
  toFingerprint, classifyFixture, packIdentity, directionOf,
  type RawSighting,
} from './engine';
import { DETECTORS, PACK_VERSION } from './pack';
import { epochOfFingerprint, currentFingerprintEpoch } from './keychain';
import { scanSinkResumable, type SinkCursor } from './cursors';
import { registerPack } from '../packs';
import { paths } from '../paths';

/**
 * The DLP scanner (tier 4): rides the cadence lane (10-minute cadence — a scan
 * is exactly the expensive out-of-path work that must never join the 5s poll),
 * scans sinks OLDEST-FIRST so the evidence closest to expiry is captured before
 * the vendor deletes it, resumes each sink from its dlp_scan_state cursor so
 * the byte budget makes forward progress across passes, and writes only
 * fingerprints. The value stays in the file; the just-in-time viewer re-reads
 * it at view time.
 */

const BYTE_BUDGET = 24 * 1024 * 1024; // per pass, across all sinks

/** Rules this batch needs — now carried by the AnomalyRule union (types.ts). */
function insertDlpAnomalies(db: DB, rows: Anomaly[]): void {
  insertAnomalies(db, rows);
}

// ── evidence expiry (#133): the vendor deletes its own transcripts ──────────

export interface ClaudeRetention {
  /** The effective retention in days; null = no deletion horizon is known. */
  days: number | null;
  /** Where the number came from — 'settings' is read, 'vendor_default' is the documented tool default. */
  source: 'settings' | 'vendor_default';
  /** ~/.claude/.last-cleanup parsed to epoch-ms, when present. */
  lastCleanup: number | null;
}

export function claudeRetention(): ClaudeRetention {
  const dir = paths.claudeConfigDir();
  for (const p of [join(dir, 'managed-settings.json'), join(dir, 'settings.json')]) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { cleanupPeriodDays?: unknown };
      if (typeof parsed.cleanupPeriodDays === 'number' && parsed.cleanupPeriodDays > 0) {
        return { days: parsed.cleanupPeriodDays, source: 'settings', lastCleanup: readLastCleanup(dir) };
      }
      if (parsed.cleanupPeriodDays === 0) {
        return { days: null, source: 'settings', lastCleanup: readLastCleanup(dir) };
      }
    } catch {
      /* malformed settings: the documented default applies */
    }
  }
  // Unset (the common case): the tool default applies — labelled as such.
  return { days: 30, source: 'vendor_default', lastCleanup: readLastCleanup(dir) };
}

function readLastCleanup(dir: string): number | null {
  const p = join(dir, '.last-cleanup');
  if (!existsSync(p)) return null;
  try {
    const ts = Date.parse(readFileSync(p, 'utf8').trim());
    return Number.isNaN(ts) ? null : ts;
  } catch {
    return null;
  }
}

// ── the scanner itself ───────────────────────────────────────────────────────

export const dlpScanner: Scanner = {
  name: 'dlp-scan',
  cadenceMs: 10 * 60_000,
  run: () => {
    const db = openDb();
    const now = Date.now();
    const pack = packIdentity();
    // Register the pack load (idempotent on kind+version) so content_packs is
    // the registry of which rule set produced each scan.
    registerPack(db, { kind: 'dlp_detectors', version: pack.version, checksum: pack.checksum });
    const retention = claudeRetention();

    // Triage first, evidence second: finding_actions reflect the disposition
    // as of pass start, so a sighting THIS pass can still flip 'rotated' to
    // 'reappeared' — the newer fact wins within the pass.
    applyFindingActions(db);

    const upsert = db.prepare(`
      INSERT INTO secret_sightings (
        fingerprint, detector, sink_key, path, byte_offset, byte_length,
        direction, status, first_seen, last_seen,
        occurrences, provider, class_entry_id, validator_checked, fixture_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(fingerprint, sink_key) DO UPDATE SET
        last_seen = excluded.last_seen,
        occurrences = COALESCE(secret_sightings.occurrences, 0) + 1,
        provider = COALESCE(secret_sightings.provider, excluded.provider),
        class_entry_id = COALESCE(secret_sightings.class_entry_id, excluded.class_entry_id),
        validator_checked = COALESCE(secret_sightings.validator_checked, excluded.validator_checked),
        fixture_reason = COALESCE(secret_sightings.fixture_reason, excluded.fixture_reason),
        byte_offset = MIN(secret_sightings.byte_offset, excluded.byte_offset),
        byte_length = MAX(secret_sightings.byte_length, excluded.byte_length),
        status = CASE WHEN secret_sightings.status = 'rotated' THEN 'reappeared'
                      ELSE secret_sightings.status END`);
    const prevStatus = db.prepare(
      'SELECT status FROM secret_sightings WHERE fingerprint = ? AND sink_key = ?',
    );
    const stateUpsert = db.prepare(`
      INSERT INTO dlp_scan_state (
        sink_key, bytes_scanned, bytes_skipped, bytes_unreadable, last_seen_at, completed,
        cursor_kind, cursor_text, cursor_int, inode, backfill_done, pack_rev
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sink_key) DO UPDATE SET
        bytes_scanned = excluded.bytes_scanned,
        bytes_skipped = excluded.bytes_skipped,
        bytes_unreadable = excluded.bytes_unreadable,
        last_seen_at = excluded.last_seen_at,
        completed = excluded.completed,
        cursor_kind = excluded.cursor_kind,
        cursor_text = excluded.cursor_text,
        cursor_int = excluded.cursor_int,
        inode = excluded.inode,
        backfill_done = MAX(COALESCE(dlp_scan_state.backfill_done, 0), excluded.backfill_done),
        pack_rev = excluded.pack_rev`);
    const readState = db.prepare(
      'SELECT cursor_kind, cursor_text, cursor_int, inode, backfill_done, last_seen_at FROM dlp_scan_state WHERE sink_key = ?',
    );

    const anomalies: Anomaly[] = [];
    let budget = BYTE_BUDGET;
    let scanned = 0;
    let skipped = 0;
    let unreadable = 0;
    let newSightings = 0;
    let backfilling = 0;

    // Oldest first (#133): the sink whose evidence expires first is scanned first.
    const sinks = enumerateSinks().sort((a, b) => oldestOf(a.path) - oldestOf(b.path));

    for (const sink of sinks) {
      if (budget <= 0) { backfilling++; continue; }
      const st = readState.get(sink.key) as (Record<string, unknown> | undefined);
      const cursor: SinkCursor = st
        ? {
          cursorKind: (st.cursor_kind as SinkCursor['cursorKind']) ?? null,
          cursorText: (st.cursor_text as string | null) ?? null,
          cursorInt: (st.cursor_int as number | null) ?? null,
          inode: (st.inode as number | null) ?? null,
          backfillDone: !!st.backfill_done,
          lastSeenAt: (st.last_seen_at as number | null) ?? null,
        }
        : { cursorKind: null, cursorText: null, cursorInt: null, inode: null, backfillDone: false, lastSeenAt: null };

      const out = scanSinkResumable(sink.key, sink.path, budget, cursor, {
        // The vendor's own horizon where the sink declares one, else Claude's
        // effective cleanupPeriodDays — the dominant deletion sweep.
        retentionDays: sink.expiresInDays ?? retention.days,
        now,
      });
      budget -= out.bytesScanned;
      scanned += out.bytesScanned;
      skipped += out.bytesSkipped;
      unreadable += out.bytesUnreadable;
      if (!out.completed) backfilling++;

      stateUpsert.run(
        sink.key, out.bytesScanned, out.bytesSkipped, out.bytesUnreadable, now, out.completed ? 1 : 0,
        out.next.cursorKind, out.next.cursorText, out.next.cursorInt, out.next.inode,
        out.next.backfillDone ? 1 : 0, PACK_VERSION,
      );

      for (const s of out.sightings) {
        const fp = toFingerprint(s, now);
        const { status, fixtureReason } = classifyFixture(sink.path, s);
        const prev = prevStatus.get(fp, out.sinkKey) as { status: string } | undefined;
        // occurrences is an upper bound on transcript copies: Claude Code writes
        // each assistant message 2-3 times as it streams (#131's stated limit).
        upsert.run(
          fp, s.detector, out.sinkKey, out.path, s.byteOffset, s.byteLength,
          directionOf('sink_at_rest'), status, now, now,
          providerFor(s), s.classEntryId, s.validatorChecked, fixtureReason,
        );
        if (!prev && status === 'candidate') {
          newSightings++;
          anomalies.push({
            anomaly_key: `secret_at_rest:${fp}`,
            rule: 'secret_at_rest',
            severity: 'critical',
            tool: 'claude_code',
            session_id: null,
            model: null,
            window_start: now,
            window_end: now,
            title: `Secret at rest: ${s.detector}`,
            detail:
              `A ${s.detector.replace(/-/g, ' ')} shape was found in ${sink.holds} ` +
              `(${out.path.replace(/^\/Users\/[^/]+/, '~')}, offset ${s.byteOffset}). ` +
              (s.validatorChecked ? `Offline checksum ${s.validatorChecked}. ` : '') +
              (s.provenance ? `Found after ${s.provenance.replace(/_/g, ' ')}. ` : '') +
              `The value is NOT stored — only its fingerprint; open the sighting to re-read the evidence in place.`,
            observed: 1,
            baseline: null,
            threshold: null,
            confidence: 'exact',
            source: 'live',
            detected_at: now,
          });
        }
        // At-rest vs live reappearance (#138): a rotated key sighted again is
        // its own incident — the fingerprint is what proves it is the same key.
        if (prev?.status === 'rotated') {
          anomalies.push({
            anomaly_key: `secret_reappeared:${fp}`,
            rule: 'secret_reappeared_after_rotation',
            severity: 'warn',
            tool: 'claude_code',
            session_id: null,
            model: null,
            window_start: now,
            window_end: now,
            title: `A rotated secret reappeared: ${s.detector}`,
            detail:
              `A fingerprint previously marked rotated was sighted again in ${out.path.replace(/^\/Users\/[^/]+/, '~')} ` +
              `(${s.detector}, sighting at offset ${s.byteOffset}). ` +
              `The value is NOT stored — only its fingerprint.`,
            observed: 1,
            baseline: null,
            threshold: null,
            confidence: 'exact',
            source: 'live',
            detected_at: now,
          });
        }
      }

      // Evidence-expiry countdown (#133): warn, never preserve — the
      // constraints forbid copying or deleting third-party stores.
      if (out.expiring && !out.completed) {
        const retentionDays = sink.expiresInDays ?? retention.days ?? 30;
        const dayBucket = Math.floor(now / 86_400_000); // UTC day: idempotent within the day
        anomalies.push({
          anomaly_key: `evidence_expiring:${sink.key}:${dayBucket}`,
          rule: 'evidence_expiring',
          severity: 'info',
          tool: 'claude_code',
          session_id: null,
          model: null,
          window_start: now,
          window_end: now,
          title: `Evidence expiring before the scan reaches it: ${sink.holds}`,
          detail:
            `${out.expiring.files} unscanned file(s) (${out.expiring.bytes} bytes) in ${out.path.replace(/^\/Users\/[^/]+/, '~')} ` +
            `sit within 3 days of the vendor's ${retentionDays}-day cleanup ` +
            `(retention ${retention.source === 'settings' ? 'read from settings' : 'unset — tool default applies'}` +
            `${retention.lastCleanup ? `, last cleanup ${new Date(retention.lastCleanup).toISOString()}` : ''}). ` +
            `Vole does not copy or move evidence — once deleted, the history is gone.`,
          observed: out.expiring.files,
          baseline: null,
          threshold: 3,
          confidence: 'exact',
          source: 'live',
          detected_at: now,
        });
      }
    }

    applyFindingActions(db); // idempotent no-op by now (already applied above)
    if (anomalies.length) insertDlpAnomalies(db, anomalies);

    const totalSinks = sinks.length;
    return {
      ok: true,
      notes:
        `pack v${pack.version} (sha ${pack.checksum.slice(0, 8)}…) · ${scanned} bytes over ${totalSinks} sink(s)` +
        (backfilling ? ` · ${backfilling} sink(s) still in backfill` : '') +
        (newSightings ? ` · ${newSightings} NEW sighting(s)` : '') +
        (skipped ? ` · ${skipped} bytes skipped by policy (counted, not hidden)` : '') +
        (unreadable ? ` · ${unreadable} bytes unreadable (the denominator)` : ''),
    };
  },
};

const PROVIDER_BY_DETECTOR = new Map<string, string | null>(DETECTORS.map((d) => [d.id, d.provider]));

function providerFor(s: RawSighting): string | null {
  // provider comes from the pack row (the vendor namespace), never inferred
  // from the value — a data class carries no provider and stays NULL.
  return PROVIDER_BY_DETECTOR.get(s.detector) ?? null;
}

function oldestOf(path: string): number {
  try {
    return Math.trunc(statSync(path).mtimeMs);
  } catch {
    return 0;
  }
}

// ── finding lifecycle (#138): triage actions and their semantics ────────────

/**
 * Applies finding_actions rows to the sighting ledger: mark_rotated sets
 * status='rotated' (a responder said the key is dead), mark_fixture sets
 * status='fixture'. Idempotent — re-running writes the same statuses — so the
 * whole history of actions stays append-only in finding_actions and the
 * ledger just reflects the latest disposition. A rotated fingerprint that is
 * sighted again flips to 'reappeared' by the upsert above and fires its own
 * incident, so rotation is never a way to make a leak invisible.
 */
export function applyFindingActions(db: DB): { rotated: number; fixtures: number } {
  const rows = db
    .prepare("SELECT action, anomaly_key, note FROM finding_actions WHERE action IN ('mark_rotated', 'mark_fixture')")
    .all() as { action: string; anomaly_key: string; note: string | null }[];
  let rotated = 0;
  let fixtures = 0;
  const rotate = db.prepare(
    "UPDATE secret_sightings SET status = 'rotated' WHERE fingerprint = ? AND status NOT IN ('rotated', 'reappeared')",
  );
  const fixture = db.prepare(
    "UPDATE secret_sightings SET status = 'fixture', fixture_reason = COALESCE(fixture_reason, 'triage') WHERE fingerprint = ? AND status <> 'fixture'",
  );
  for (const r of rows) {
    const fp = r.anomaly_key.startsWith('secret_at_rest:')
      ? r.anomaly_key.slice('secret_at_rest:'.length)
      : r.anomaly_key;
    if (r.action === 'mark_rotated') rotated += rotate.run(fp).changes;
    else if (r.action === 'mark_fixture') fixtures += fixture.run(fp).changes;
  }
  return { rotated, fixtures };
}

// ── read models: coverage, denominators, correlation, egress ────────────────

/** Per-sink coverage from the stored scan state (the Coverage strip's data). */
export interface SinkCoverage {
  sinkKey: string;
  bytesScanned: number;
  bytesSkipped: number;
  bytesUnreadable: number;
  completed: boolean;
  backfillDone: boolean;
  packRev: number | null;
  lastSeenAt: number | null;
}

export function dlpCoverage(db: DB): SinkCoverage[] {
  const rows = db
    .prepare('SELECT sink_key, bytes_scanned, bytes_skipped, bytes_unreadable, completed, backfill_done, pack_rev, last_seen_at FROM dlp_scan_state')
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    sinkKey: r.sink_key as string,
    bytesScanned: r.bytes_scanned as number,
    bytesSkipped: (r.bytes_skipped as number | null) ?? 0,
    bytesUnreadable: (r.bytes_unreadable as number | null) ?? 0,
    completed: !!r.completed,
    backfillDone: !!r.backfill_done,
    packRev: (r.pack_rev as number | null) ?? null,
    lastSeenAt: (r.last_seen_at as number | null) ?? null,
  }));
}

/**
 * The unreadable denominator (#135): no exposure figure may render without
 * the bytes Vole could not read. Every Leak Ledger / Data Exposure aggregate
 * must join this — the parity contract is that a scanned-bytes sum is never
 * selected without its companion columns.
 */
export interface ExposureCoverage {
  scannedBytes: number;
  unscannableBytes: number;
  unscannableRows: number;
  rowsWithoutByteCount: number;
  packVersion: number;
}

export function exposureCoverage(db: DB): ExposureCoverage {
  const s = db.prepare(
    'SELECT COALESCE(SUM(bytes_scanned), 0) AS scanned, COALESCE(SUM(bytes_unreadable), 0) AS unread FROM dlp_scan_state',
  ).get() as { scanned: number; unread: number };
  const p = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN scannable = 0 THEN COALESCE(bytes_on_disk, bytes_received, 0) ELSE 0 END), 0) AS unscannable_bytes,
       SUM(CASE WHEN scannable = 0 THEN 1 ELSE 0 END) AS unscannable_rows,
       SUM(CASE WHEN bytes_on_disk IS NULL AND bytes_received IS NULL THEN 1 ELSE 0 END) AS no_size
     FROM payload_sightings`,
  ).get() as { unscannable_bytes: number | null; unscannable_rows: number | null; no_size: number | null };
  return {
    scannedBytes: s.scanned,
    unscannableBytes: s.unread + (p.unscannable_bytes ?? 0),
    unscannableRows: p.unscannable_rows ?? 0,
    rowsWithoutByteCount: p.no_size ?? 0,
    packVersion: PACK_VERSION,
  };
}

/** Sighting evidence the vendor already deleted: paths gone from disk (#133). */
export function prunedEvidence(db: DB): { files: number; bytes: number; sightings: number } {
  const rows = db
    .prepare('SELECT path, byte_length FROM secret_sightings')
    .all() as { path: string; byte_length: number }[];
  const gone = new Map<string, number>();
  let sightings = 0;
  for (const r of rows) {
    if (!existsSync(r.path)) {
      gone.set(r.path, (gone.get(r.path) ?? 0) + r.byte_length);
      sightings++;
    }
  }
  let bytes = 0;
  for (const b of gone.values()) bytes += b;
  return { files: gone.size, bytes, sightings };
}

/** Cross-sink fingerprint correlation and first-origin (#132). */
export interface FingerprintRollup {
  fingerprint: string;
  epoch: number | null;
  /** False when minted under a previous key epoch: excluded from correlation, flagged, never silently merged. */
  correlatable: boolean;
  distinctSinks: number;
  occurrences: number | null;
  providers: string[];
  crossedProviderBoundary: boolean;
  alsoAtRestFiles: number;
  origin: { sinkKey: string; path: string; direction: string; firstSeen: number } | null;
}

export function correlateFingerprints(db: DB, now = Date.now()): FingerprintRollup[] {
  const currentEpoch = currentFingerprintEpoch(now);
  const rows = db
    .prepare('SELECT fingerprint, sink_key, path, direction, first_seen, occurrences, provider FROM secret_sightings ORDER BY first_seen')
    .all() as {
    fingerprint: string; sink_key: string; path: string; direction: string;
    first_seen: number; occurrences: number | null; provider: string | null;
  }[];
  const byFp = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byFp.get(r.fingerprint) ?? [];
    list.push(r);
    byFp.set(r.fingerprint, list);
  }
  const out: FingerprintRollup[] = [];
  for (const [fingerprint, list] of byFp) {
    const origin = list[0]!;
    out.push({
      fingerprint,
      epoch: epochOfFingerprint(fingerprint),
      correlatable: epochOfFingerprint(fingerprint) === currentEpoch,
      distinctSinks: new Set(list.map((r) => r.sink_key)).size,
      occurrences: list.reduce((n, r) => n + (r.occurrences ?? 0), 0),
      providers: [...new Set(list.map((r) => r.provider).filter((p): p is string => p !== null))],
      crossedProviderBoundary: new Set(list.map((r) => r.provider).filter((p): p is string => p !== null)).size > 1,
      alsoAtRestFiles: new Set(list.filter((r) => r.direction === 'at_rest').map((r) => r.path)).size,
      origin: { sinkKey: origin.sink_key, path: origin.path, direction: origin.direction, firstSeen: origin.first_seen },
    });
  }
  return out;
}

/** Known vendor endpoints for provider resolution (model_routes refines these). */
const VENDOR_ENDPOINTS: Record<string, string> = {
  anthropic: 'api.anthropic.com',
  openai: 'api.openai.com',
  aws: 'amazonaws.com',
  github: 'api.github.com',
  google: 'generativelanguage.googleapis.com',
  slack: 'slack.com',
};

export interface EgressRow {
  provider: string;
  /** The endpoint host the data class would egress to. */
  providerKey: string | null;
  transport: 'https' | null;
  /** model_routes row observed locally = measured; vendor default = assumed. */
  evidence: 'model_routes' | 'vendor_default' | 'unknown';
  sightingCount: number;
  dataClasses: string[];
}

/**
 * dlp_egress (tier 5, #153): data class → provider endpoint. Joins sightings
 * to the local model_routes census — a gateway alias with an api_base is
 * MEASURED evidence of where traffic goes; the vendor default is labelled
 * 'assumed' so the two never read the same. No network is touched.
 */
export function dlpEgress(db: DB): EgressRow[] {
  const sightings = db.prepare(
    `SELECT provider, COUNT(*) AS n, COUNT(DISTINCT COALESCE(class_entry_id, detector)) AS classes
     FROM secret_sightings WHERE provider IS NOT NULL GROUP BY provider`,
  ).all() as { provider: string; n: number; classes: number }[];
  if (sightings.length === 0) return [];
  const routes = db.prepare(
    'SELECT alias, target_model, api_base FROM model_routes WHERE api_base IS NOT NULL',
  ).all() as { alias: string; target_model: string | null; api_base: string }[];
  const classRows = db.prepare(
    'SELECT provider, class_entry_id, detector FROM secret_sightings WHERE provider IS NOT NULL',
  ).all() as { provider: string; class_entry_id: string | null; detector: string }[];

  const hostOf = (url: string): string => {
    try {
      return new URL(url).host;
    } catch {
      return url.replace(/^https?:\/\//, '').split('/')[0]!;
    }
  };

  return sightings.map((s) => {
    const route = routes.find((r) => hostOf(r.api_base).includes(s.provider));
    const classes = [
      ...new Set(classRows.filter((c) => c.provider === s.provider).map((c) => c.class_entry_id ?? c.detector)),
    ];
    if (route) {
      return {
        provider: s.provider, providerKey: hostOf(route.api_base), transport: 'https' as const,
        evidence: 'model_routes' as const, sightingCount: s.n, dataClasses: classes,
      };
    }
    const fallback = VENDOR_ENDPOINTS[s.provider];
    return {
      provider: s.provider,
      providerKey: fallback ?? null,
      transport: fallback ? ('https' as const) : null,
      evidence: fallback ? ('vendor_default' as const) : ('unknown' as const),
      sightingCount: s.n,
      dataClasses: classes,
    };
  });
}
