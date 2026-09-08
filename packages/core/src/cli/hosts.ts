/**
 * Tier 8: the per-active-agent-host meter, computed and auditable offline.
 * A seat count cannot be verified from a laptop while an active host can,
 * so the meter counts DISTINCT user || '@' || machine over sessions with at
 * least one live row — and ships the underlying rows, so a customer audits
 * their own invoice without contacting anyone: no activation call, no
 * phone-home, the same figure on the invoice derivable from their own
 * database. Collection, rules and every read model behave identically in
 * all three editions.
 *
 * A host that never runs the collector is never counted, so the meter is a
 * floor and never an inventory; the MDM's own device list is the expected
 * set to reconcile against.
 */
import { openDb } from '../db';

const args = process.argv.slice(2);
const rangeArg = args.find((a) => a.startsWith('--range='));
const range = rangeArg ? rangeArg.split('=')[1]! : '30d';
const m = range.match(/^(\d+)([dwm])$/);
const n = m ? Number(m[1]) : 30;
const unitMs = m?.[2] === 'w' ? 7 * 86_400_000 : m?.[2] === 'm' ? 30 * 86_400_000 : 86_400_000;
const from = Date.now() - n * unitMs;

const FREE_TIER_HOSTS = 10;

const db = openDb();
const hosts = db.prepare(
  `SELECT user, machine, COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS calls,
          COUNT(DISTINCT tool) AS tools, MAX(ts) AS last_ts
   FROM usage_events
   WHERE source = 'live' AND user IS NOT NULL AND machine IS NOT NULL AND ts >= ?
   GROUP BY user, machine
   ORDER BY calls DESC`,
).all(from) as { user: string; machine: string; sessions: number; calls: number; tools: number; last_ts: number }[];

const edition =
  hosts.length <= FREE_TIER_HOSTS ? 'Core (free tier)' : hosts.length <= 100 ? 'Enterprise' : 'Fleet';

console.log('Vole active agent hosts');
console.log('────────────────────────────');
console.log(`  range                 last ${n}${m?.[2] ?? 'd'}`);
console.log(`  active hosts          ${hosts.length}`);
console.log(`  free tier             ${FREE_TIER_HOSTS} hosts`);
console.log(`  edition (at this count) ${edition}`);
console.log('  meter                 a floor, never an inventory — a host that never');
console.log('                         runs the collector is never counted');
console.log('');
for (const h of hosts) {
  console.log(
    `  ${`${h.user}@${h.machine}`.padEnd(34)} sessions=${String(h.sessions).padStart(4)}  calls=${String(h.calls).padStart(6)}  tools=${h.tools}  last=${new Date(h.last_ts).toISOString()}`,
  );
}
if (args.includes('--json')) {
  console.log('\n' + JSON.stringify({ range, active_hosts: hosts.length, edition, hosts }, null, 1));
}
