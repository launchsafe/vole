import { statSync } from 'node:fs';
import { openDb, insertAnomalies } from '../db';
import type { Scanner } from '../db';
import { enumerateSinks, scanSink } from './sinks';
import { toFingerprint, classifyStatus, packIdentity } from './engine';
import { builtinDlpPack, registerPack } from '../packs';

/**
 * The DLP scanner: rides the cadence lane (10-minute cadence — a scan is
 * exactly the expensive out-of-path work that must never join the 5s poll),
 * scans sinks OLDEST-FIRST so the evidence closest to expiry is captured before
 * the vendor deletes it, and writes only fingerprints. The value stays in the
 * file; the just-in-time viewer re-reads it at view time.
 */

const BYTE_BUDGET = 24 * 1024 * 1024; // per pass, across all sinks

export const dlpScanner: Scanner = {
  name: 'dlp-scan',
  cadenceMs: 10 * 60_000,
  run: () => {
    const db = openDb();
    const now = Date.now();
    const pack = packIdentity();
    const sinks = enumerateSinks().sort((a, b) => oldestOf(a.path) - oldestOf(b.path)); // oldest first (#133)

    let budget = BYTE_BUDGET;
    let scanned = 0;
    let unreadable = 0;
    let newSightings = 0;
    const upsert = db.prepare(`
      INSERT INTO secret_sightings (fingerprint, detector, sink_key, path, byte_offset, byte_length, direction, status, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, 'at_rest', ?, ?, ?)
      ON CONFLICT(fingerprint, sink_key) DO UPDATE SET last_seen = excluded.last_seen`);
    const fresh = db.prepare(
      'SELECT first_seen FROM secret_sightings WHERE fingerprint = ? AND sink_key = ?',
    );

    for (const sink of sinks) {
      if (budget <= 0) break;
      const r = scanSink(sink, budget);
      budget -= r.bytesScanned;
      scanned += r.bytesScanned;
      unreadable += r.bytesUnreadable;

      for (const s of r.sightings) {
        const fp = toFingerprint(s, now);
        const status = classifyStatus(sink.path);
        const existed = fresh.get(fp, r.sinkKey) as { first_seen: number } | undefined;
        upsert.run(fp, s.detector, r.sinkKey, r.path, s.byteOffset, s.byteLength, status, now, now);
        if (!existed && status === 'candidate') {
          newSightings++;
          // One incident per NEW candidate fingerprint — not per file, not per pass.
          insertAnomalies(db, [{
            anomaly_key: `secret_at_rest:${fp}`,
            rule: 'new_ai_surface' as never, // inventory-rule family until the AnomalyRule enum grows a dlp member
            severity: 'critical',
            tool: 'claude_code' as never,
            session_id: null,
            model: null,
            window_start: now,
            window_end: now,
            title: `Secret at rest: ${s.detector}`,
            detail:
              `A ${s.detector.replace(/-/g, ' ')} shape was found in ${sink.holds} ` +
              `(${r.path.replace(/^\/Users\/[^/]+/, '~')}, offset ${s.byteOffset}). ` +
              `The value is NOT stored — only its fingerprint; open the sighting to re-read the evidence in place.`,
            observed: 1,
            baseline: null,
            threshold: null,
            confidence: 'exact',
            source: 'live',
            detected_at: now,
          }]);
        }
      }

      db.prepare(`
        INSERT INTO dlp_scan_state (sink_key, bytes_scanned, bytes_skipped, bytes_unreadable, last_seen_at, completed)
        VALUES (?, ?, 0, ?, ?, ?)
        ON CONFLICT(sink_key) DO UPDATE SET
          bytes_scanned = excluded.bytes_scanned,
          bytes_unreadable = excluded.bytes_unreadable,
          last_seen_at = excluded.last_seen_at,
          completed = excluded.completed`)
        .run(r.sinkKey, r.bytesScanned, r.bytesUnreadable, now, r.completed ? 1 : 0);
    }

    const totalSinks = sinks.length;
    return {
      ok: true,
      notes:
        `pack v${pack.version} (sha ${pack.checksum.slice(0, 8)}…) · ${scanned} bytes over ${totalSinks} sink(s)` +
        (newSightings ? ` · ${newSightings} NEW sighting(s)` : '') +
        (unreadable ? ` · ${unreadable} bytes unreadable (the denominator)` : ''),
    };
  },
};

function oldestOf(path: string): number {
  try {
    return Math.trunc(statSync(path).mtimeMs);
  } catch {
    return 0;
  }
}
