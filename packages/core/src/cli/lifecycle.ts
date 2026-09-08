/**
 * Tier 8: the lifecycle CLI — declarations, the at-exit credential sweep,
 * the departure evidence pack, and the mover scope diff. principal_lifecycle
 * is a declared state, never an inferred one: this is the personal-mode
 * writer (managed mode reads the lifecycle[] block of identity.json; both
 * land in the same append-only ledger).
 *
 *   vole lifecycle set --principal <key> --state <state> --from <epoch|iso> --by <who> --basis <text>
 *   vole lifecycle list
 *   vole lifecycle sweep [--principal <key>]        credential residency + liveness
 *   vole lifecycle pack --principal <key> --window 30d --basis <text> [--freeze] [--delta]
 *   vole lifecycle scope-diff --principal <key>
 */
import { openDb } from '../db';
import {
  declareLifecycle, stateAt, currentStates, activityAfterDeparture,
  credentialSweep, buildDeparturePack, scopeDiff, syncLifecycleFromPolicy,
} from '../privacy/departure';
import { insertAnomalies } from '../db';
import type { PrincipalState } from '../types';

const STATES: PrincipalState[] = ['active', 'departing', 'departed', 'scope_changed', 'suspended'];

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : '') : undefined;
};
const cmd = args[0] ?? 'list';
const db = openDb();

if (cmd === 'set') {
  const principal = flag('--principal');
  const state = flag('--state') as PrincipalState | undefined;
  const fromRaw = flag('--from');
  const from = fromRaw ? (/^\d+$/.test(fromRaw) ? Number(fromRaw) : Date.parse(fromRaw)) : NaN;
  if (!principal || !state || !STATES.includes(state) || !Number.isFinite(from)) {
    console.error('usage: vole lifecycle set --principal <key> --state active|departing|departed|scope_changed|suspended --from <epoch-ms|iso> [--to <..>] [--by <who>] [--basis <text>]');
    console.error('A declaration is who said so, when, on what basis. Vole cannot know anyone left.');
    process.exit(2);
  }
  const n = declareLifecycle(db, {
    principal_key: principal,
    state,
    effective_from: from,
    effective_to: flag('--to') ? Number(flag('--to')) : null,
    declared_by: flag('--by') ?? null,
    basis: flag('--basis') ?? null,
    source: 'cli',
  });
  console.log(n === 1 ? `Declared ${principal} ${state} from ${new Date(from).toISOString()} (append-only).` : 'Declaration already recorded (idempotent no-op).');
  process.exit(0);
}

if (cmd === 'list') {
  // Policy declarations sync into the ledger first so list shows both sources.
  const synced = syncLifecycleFromPolicy(db);
  const rows = db.prepare(
    `SELECT principal_key, state, effective_from, effective_to, declared_by, basis, decl_hash, source, first_seen
     FROM principal_lifecycle ORDER BY effective_from`,
  ).all();
  console.log(`principal_lifecycle — ${rows.length} declaration(s)${synced ? `, ${synced} synced from policy` : ''}`);
  for (const r of rows as Record<string, unknown>[]) {
    console.log(
      `  ${String(r.principal_key).padEnd(20)} ${String(r.state).padEnd(14)} from ${new Date(Number(r.effective_from)).toISOString()}` +
      `  by ${r.declared_by ?? '—'}  basis ${r.basis ?? '—'}  [${r.source}]`,
    );
  }
  const departed = currentStates(db).filter((s) => s.state === 'departed');
  if (departed.length > 0) {
    const fired = insertAnomalies(db, activityAfterDeparture(db)).inserted;
    console.log(`\n  ${departed.length} departed principal(s); activity_after_departure fired ${fired} new incident(s).`);
  }
  process.exit(0);
}

if (cmd === 'sweep') {
  const rows = credentialSweep();
  console.log('Credential residency and liveness sweep (names and metadata only, never a value)');
  console.log('──────────────────────────────────────────────────────────────────────────────');
  for (const r of rows) {
    const refreshed = r.last_refresh === null ? '' : ` refreshed ${new Date(r.last_refresh).toISOString()}`;
    console.log(`  ${`${r.where}:${r.name}`.padEnd(52)} ${r.state}${refreshed}`);
    console.log(`      ${r.note}`);
  }
  if (rows.length === 0) console.log('  nothing enumerated — absence is not proof nothing was ever there');
  process.exit(0);
}

if (cmd === 'pack') {
  const principal = flag('--principal')!;
  const windowRaw = flag('--window') ?? '30d';
  const wm = windowRaw.match(/^(\d+)d$/);
  const basis = flag('--basis') ?? 'unspecified';
  const st = stateAt(db, principal, Date.now());
  const pack = buildDeparturePack(db, {
    principalKey: principal,
    windowDays: wm ? Number(wm[1]) : 30,
    basis,
    freeze: args.includes('--freeze'),
    delta: args.includes('--delta') || (st !== null && (st.state === 'departing' || st.state === 'departed')),
  });
  console.log(JSON.stringify(pack, null, 1));
  process.exit(0);
}

if (cmd === 'scope-diff') {
  const principal = flag('--principal')!;
  const st = stateAt(db, principal, Date.now());
  const from = flag('--from') ? Number(flag('--from')) : st?.effective_from;
  if (!from) {
    console.error('no scope_changed declaration for this principal — pass --from <epoch-ms> or declare one first');
    process.exit(2);
  }
  const rows = scopeDiff(db, principal, from);
  const residual = rows.filter((r) => r.state === 'residual');
  console.log(`Scope diff for ${principal} from ${new Date(from).toISOString()} — residual reach pinned first (${residual.length} row(s))`);
  for (const r of residual) console.log(`  RESIDUAL  ${r.dimension.padEnd(24)} ${r.value}  ${r.evidence ?? ''}`);
  for (const r of rows.filter((r) => r.state !== 'residual')) {
    console.log(`  ${r.state.padEnd(9)} ${r.dimension.padEnd(24)} ${r.value}`);
  }
  console.log('  Residual is a floor, never the full entitlement set: a permission granted');
  console.log('  server-side and never exercised locally is invisible.');
  process.exit(0);
}

console.error('usage: vole lifecycle <set|list|sweep|pack|scope-diff> [...]');
process.exit(2);
