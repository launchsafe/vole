/**
 * Tier 3 CLI — `vole identity propose`, `vole whoami`, `vole pilot …` and the
 * callable verify --identity (features 27/42/32/4). Dispatch is plain argv so
 * the integrator can register package.json scripts verbatim:
 *   "identity": "tsx src/cli/identity.ts",
 *   "whoami":   "tsx src/cli/identity.ts whoami",
 *   "pilot":    "tsx src/cli/identity.ts pilot"
 *
 * whoami and the identity check honour the policy gate: on a multi-principal
 * store they return only the caller's own principal unless people_view is
 * granted (feature 42).
 */
import { existsSync } from 'node:fs';
import { openDbReadOnly, type DB } from '../db';
import { paths } from '../paths';
import { principalKey } from '../identity';
import { resolvePrincipal, whoamiModel, principalRows, detectPrincipalConflicts } from '../identity/chain';
import { identityPropose, loadIdentityPolicy } from '../identity/policy';
import { pilotStart, pilotStatus, tenancyAnchor, preTenancyCount, fileSha256 } from '../identity/tenancy';
import { verifyIdentity } from '../identity/verify';
import { logAccess, restrictToCallerPrincipal } from '../identity/access';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? '';
const principalKeyOf = principalKey; // reimported name reads better at the call site

function arg(name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
}

function openReader(): DB | null {
  if (!existsSync(paths.db())) {
    console.error(`No Vole store at ${paths.db()} yet — run the collector first: pnpm collect --once`);
    return null;
  }
  return openDbReadOnly();
}

function main(): void {
  if (cmd === 'propose') {
    const db = openReader();
    if (!db) process.exit(1);
    console.log(identityPropose(db));
    console.error(`\n# Candidate only — written nowhere. Save (edited) to ${paths.identityPolicyPaths()[1]}`);
    return;
  }

  if (cmd === 'whoami') {
    const db = openReader();
    if (!db) process.exit(1);
    logReadonly(db, 'whoami');
    const resolved = resolvePrincipal();
    const policy = loadIdentityPolicy();
    // Feature 42's gate: on a multi-principal store, only the caller's own
    // principal unless people_view is granted.
    const restricted = restrictToCallerPrincipal(db, policy);
    const model = whoamiModel(db, restricted ? principalKeyOf(resolved.username) : null);
    console.log(`principal : ${model.principal.label}${restricted ? ' (this store holds more than one principal; showing only yours)' : ''}`);
    console.log(`source    : ${model.principal.source} (${model.principal.evidence})${model.principal.declared ? '' : '  ⚠ bare OS username — unverified'}`);
    console.log(`machine   : ${model.machine.machine_uuid ?? 'no IOPlatformUUID (hostname is the only key)'} · ${model.machine.hostname ?? 'unknown'}`);
    const anchor = tenancyAnchor();
    const pre = preTenancyCount(db, anchor);
    console.log(`tenancy   : ${anchor ? `anchored ${new Date(anchor.ts).toISOString()} (basis ${anchor.basis})` : 'no anchor on this machine'}`);
    if (pre !== null && pre > 0) console.log(`            ${pre} row(s) predate this principal's tenancy — excluded, holder unknown`);
    const rows = principalRows(db, false);
    console.log(`store     : ${rows.principals.length} principal(s), ${rows.originUnknown.calls} row(s) with origin unknown`);
    console.log('tools:');
    for (const t of model.tools) {
      console.log(`  ${t.tool.padEnd(12)} class=${t.account_class} plan=${t.plan} org=${t.org_id} binding=${t.binding_evidence}`);
    }
    if (model.tools.length === 0) console.log('  (no session identity rows yet)');
    const conflicts = detectPrincipalConflicts(db);
    if (conflicts.length > 0) console.log(`conflicts : ${conflicts.length} principal_conflict incident(s) — per-person figures are held back`);
    return;
  }

  if (cmd === 'verify') {
    // The callable form of `verify --identity`; cli/verify.ts's registration
    // delegates here so the check has exactly one implementation.
    if (!existsSync(paths.db())) {
      console.error(`No Vole store at ${paths.db()} — nothing to scan.`);
      process.exit(1);
    }
    const db = openReader();
    if (!db) process.exit(1);
    const r = verifyIdentity(db);
    console.log(`verify --identity: ${r.columnsChecked} identity column(s), ${r.rowsChecked} non-NULL value(s) scanned`);
    for (const f of r.findings) console.log(`  FINDING: ${f}`);
    console.log(r.ok ? '  PASS — no email or name stored in any identity column' : '  FAIL');
    process.exit(r.ok ? 0 : 1);
  }

  if (cmd === 'pilot') {
    const sub = argv[1] ?? 'status';
    if (sub === 'start') {
      const until = arg('until');
      const partner = arg('partner');
      if (!until || !partner) {
        console.error('usage: vole pilot start --until=<date> --partner=<name> [--features=a,b]');
        process.exit(1);
      }
      const policy = loadIdentityPolicy();
      const record = pilotStart({
        until,
        partner,
        features: arg('features')?.split(','),
        policyHash: policy?.sha256 ?? fileSha256(paths.identityPolicyPaths()[1] ?? '') ?? null,
      });
      console.log(`pilot started: partner=${record.partner} until=${new Date(record.until).toISOString()} features=${record.features.join(',')}`);
      console.log(`record appended to ${paths.basisRecord()} (append-only)`);
      return;
    }
    const s = pilotStatus();
    if (!s.record) {
      console.log('no pilot record — this install is not in pilot mode');
      return;
    }
    console.log(`pilot: partner=${s.record.partner} ${s.active ? `ACTIVE, ${s.days_remaining} day(s) remaining` : 'ENDED — every pilot-only path has reverted to off (local-only)'}`);
    for (const [f, on] of Object.entries(s.gates)) console.log(`  ${on ? 'on ' : 'off'}  ${f}`);
    if (!s.active) console.log('  (auto-reverted at the hard expiry; the banner reads "pilot ended, local-only")');
    return;
  }

  if (cmd === '' || cmd === 'help') {
    console.log('usage: vole identity <propose|whoami|verify> · vole pilot <start|status>');
    return;
  }
  console.error(`unknown subcommand: ${cmd}`);
  process.exit(1);
}

/** Readers log their look into access_log when the store is writable; a read-only mount must not fail the read. */
function logReadonly(db: DB, view: string): void {
  try {
    logAccess(db, `cli:${typeof process.getuid === 'function' ? process.getuid() : 'unknown'}`, 'self_view', view);
  } catch {
    /* read-only mount: the read proceeds unlogged rather than not at all */
  }
}

main();
