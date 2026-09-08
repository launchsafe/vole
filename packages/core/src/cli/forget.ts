/**
 * Tier 8: erasure that survives the next poll, the Art. 19 propagation
 * report, and device decommission (seal, attest, erase — three gates that
 * cannot be skipped or reordered).
 *
 *   vole forget --subject <principal_key> [--dry-run]
 *   vole forget --report [--recall-pending]       Art. 19: where the data went
 *   vole forget --decommission --principal <key> --out <archive.json>
 *
 * Erasure in Vole is not erasure on the machine — the agents' own
 * transcripts still hold the content, and rows a sink already accepted
 * cannot be recalled. The report says so rather than pretending otherwise.
 */
import { openDb } from '../db';
import { forgetSubject, art19Report, decommission, erasureRegister } from '../privacy/forget';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : '') : undefined;
};

const db = openDb();

if (flag('--report') !== undefined) {
  const report = art19Report(db, { recallPending: args.includes('--recall-pending') });
  console.log('Art. 19 propagation report — where the data went');
  console.log('────────────────────────────────────────────────');
  for (const s of report.sinks) {
    console.log(`  ${s.sink.padEnd(16)} docs=${String(s.docs).padStart(5)}  last=${s.last_send ? new Date(s.last_send).toISOString() : '—'}  recall: ${s.recall} (${s.reason})`);
  }
  console.log('');
  for (const l of report.limits) console.log(`  LIMIT: ${l}`);
  console.log('\n' + JSON.stringify(report, null, 1));
  process.exit(0);
}

if (flag('--decommission') !== undefined) {
  const principal = flag('--principal');
  const out = flag('--out');
  if (!principal || !out) {
    console.error('usage: vole forget --decommission --principal <key> --out <archive.json>');
    process.exit(2);
  }
  const receipt = decommission(db, principal, out, { setBy: 'vole decommission' });
  console.log('Device decommission — seal / attest / erase');
  console.log('─────────────────────────────────────────────');
  console.log(`  SEAL    archive ${out}`);
  for (const r of receipt.seal.rows_exported) console.log(`          ${r.table.padEnd(16)} ${r.rows} row(s) (deny-by-default encoder)`);
  console.log(`          freeze manifest: ${receipt.seal.freeze_manifest_rows} row(s)`);
  console.log(`          archive sha256 ${receipt.seal.archive_sha256}`);
  console.log(`  ATTEST  recomputed ${receipt.attest.recomputed_sha256} — ${receipt.attest.matches_seal ? 'MATCHES seal' : 'MISMATCH'}`);
  console.log(`          store epoch ${receipt.attest.store_epoch_id ?? '— (run the collector once to stamp one)'}`);
  if (receipt.erase.blocked_by_hold) {
    console.log(`  ERASE   BLOCKED by legal hold${receipt.erase.hold?.declared_by ? ` declared by ${receipt.erase.hold.declared_by}` : ''}` +
      `${receipt.erase.hold?.expires_at ? `, expires ${new Date(receipt.erase.hold.expires_at).toISOString()}` : ''}`);
  } else {
    console.log(`  ERASE   ${receipt.erase.rows_erased.reduce((a, r) => a + r.rows, 0)} row(s) erased; register entry ${receipt.erase.register_entry}`);
  }
  for (const s of receipt.sources_still_holding_data) console.log(`  STILL HOLDS SOURCE DATA: ${s}`);
  console.log('\n' + JSON.stringify(receipt, null, 1));
  process.exit(0);
}

const subject = flag('--subject');
if (subject) {
  if (args.includes('--dry-run')) {
    console.log(`Dry run: vole forget --subject ${subject} would delete every live row bound to this principal`);
    console.log('and write the subject-keyed erasure register entry that makes it survive the next poll.');
    process.exit(0);
  }
  const result = forgetSubject(db, subject);
  console.log(`Erased subject ${subject}: ${result.total_rows} row(s).`);
  for (const d of result.deleted) if (d.rows > 0) console.log(`  ${d.table.padEnd(28)} ${d.rows}`);
  console.log(`Register entry ${result.register_entry} written — rows re-read by a full-rescan collector are`);
  console.log('suppressed at ingest by it (the write-path check is the wired integration step).');
  const reg = erasureRegister(db);
  console.log(`\nErasure register: ${reg.length} subject(s).`);
  process.exit(0);
}

console.error('usage: vole forget --subject <principal_key> | --report [--recall-pending] | --decommission --principal <k> --out <file>');
process.exit(2);
