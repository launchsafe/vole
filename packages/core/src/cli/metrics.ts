/**
 * Tier 7: MTTA/MTTR from Vole's own clocks — how long until a human
 * acknowledged an incident, and how long until it was muted/resolved.
 * Unattended is a first-class state: an incident nobody touched is not a
 * zero-time response, it is an absence.
 */
import { openDb } from '../db';

const db = openDb();
const rows = db
  .prepare(
    `SELECT a.rule, a.detected_at,
            MIN(CASE WHEN f.action = 'acknowledged' THEN f.created_at END) AS ack_at,
            MIN(CASE WHEN f.action = 'muted' THEN f.created_at END) AS muted_at
     FROM anomalies a
     LEFT JOIN finding_actions f ON f.anomaly_key = a.anomaly_key
     WHERE a.source = 'live' AND a.detected_at > ?
     GROUP BY a.anomaly_key`,
  )
  .all(Date.now() - 30 * 24 * 3600_000) as {
  rule: string; detected_at: number; ack_at: number | null; muted_at: number | null;
}[];

let acked = 0, mttaSum = 0, muted = 0, mttrSum = 0;
for (const r of rows) {
  if (r.ack_at) {
    acked++;
    mttaSum += r.ack_at - r.detected_at;
  }
  if (r.muted_at) {
    muted++;
    mttrSum += r.muted_at - r.detected_at;
  }
}
const total = rows.length;
const unattended = total - acked;

console.log('Vole response metrics (30d)');
console.log('────────────────────────');
console.log(`  incidents            ${total}`);
console.log(`  acknowledged         ${acked} (${total ? Math.round((acked / total) * 100) : 0}%)`);
console.log(`  MTTA                 ${acked ? (mttaSum / acked / 60000).toFixed(1) : '—'} min (acknowledged only)`);
console.log(`  muted                ${muted}`);
console.log(`  MTTR                 ${muted ? (mttrSum / muted / 60000).toFixed(1) : '—'} min`);
console.log(`  unattended           ${unattended} (${total ? Math.round((unattended / total) * 100) : 0}%) — no human touched them;`);
console.log(`                       this is an absence, not a zero-time response`);
