/**
 * Tier 8: retention split by data class, with a receipt, gated on what can
 * still be rebuilt — plus the store surfaces this CLI also owns: measured
 * store_budget bytes per table and index, and the measured reclaim
 * (VACUUM INTO a scratch copy; the in-place VACUUM is the decision).
 *
 *   pnpm retention                      class table, dry run
 *   pnpm retention --apply              prune, receipts into store_prunes
 *   pnpm retention --budget             measure store_budget now
 *   pnpm retention --reclaim [--apply]  measured reclaim (in-place VACUUM with --apply)
 *
 * The AI Act six-month floor is shown against the minimisation ceiling: both
 * are printed, neither is silently chosen; a declared floor exceeding the
 * configured value renders a red row and the pass refuses.
 */
import { openDb, resetDbCache } from '../db';
import { paths } from '../paths';
import {
  loadRetentionPolicy, prunePass,
} from '../privacy/retention';
import { measureStoreBudget, measuredReclaim, storeFileSizes } from '../privacy/store-budget';

const args = process.argv.slice(2);

if (args.includes('--budget')) {
  const db = openDb();
  const { rows, dbstat, pages } = measureStoreBudget(db);
  const files = storeFileSizes(paths.db());
  console.log('Vole store budget (measured)');
  console.log('───────────────────────────');
  console.log(`  dbstat                ${dbstat ? 'available' : 'UNAVAILABLE — per-object bytes are NULL, never estimated'}`);
  console.log(`  file total            ${pages.file_bytes} bytes (page_count ${pages.page_count} × page_size ${pages.page_size})`);
  console.log(`  freelist_count        ${pages.freelist_count} (not the reclaim gate — defragmentation reclaims past it)`);
  console.log(`  db / -wal / -shm      ${files.db ?? '—'} / ${files.wal ?? '—'} / ${files.shm ?? '—'}`);
  for (const r of rows.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))) {
    const bytes = r.bytes === null ? '—' : String(r.bytes);
    const bpr = r.bytes_per_row === null ? '—' : `${r.bytes_per_row.toFixed(0)} B/row`;
    console.log(`  ${`${r.kind}:${r.object}`.padEnd(40)} ${bytes.padStart(12)}  rows=${String(r.rows ?? '—').padStart(8)}  ${bpr}`);
  }
  process.exit(0);
}

if (args.includes('--reclaim')) {
  const db = openDb();
  const result = measuredReclaim(db, paths.db(), {
    thresholdBytes: 262_144,
    apply: args.includes('--apply'),
  });
  console.log('Vole measured reclaim');
  console.log('──────────────────────');
  console.log(`  state                 ${result.state}`);
  console.log(`  detail                ${result.detail}`);
  console.log(`  file bytes            ${result.file_bytes ?? '—'}`);
  console.log(`  free bytes             ${result.free_bytes ?? '—'}`);
  console.log(`  reclaimable (measured) ${result.reclaimable_bytes ?? '—'}`);
  console.log(`  in-place VACUUM        ${result.applied ? 'RUN' : 'not run'}`);
  if (!result.applied) console.log('  (pass --apply to run the in-place VACUUM when the measured delta clears the threshold)');
  process.exit(0);
}

const apply = args.includes('--apply');
const db = openDb();
const policy = loadRetentionPolicy();

console.log('Vole retention');
console.log('────────────────────');
console.log(`  policy source         ${policy.source ?? 'none — defaults shown, not chosen'}`);
console.log(`  AI Act floor          ${policy.ai_act_floor_days ?? 'undeclared by this profile (Vole cannot know deployer status)'}`);
console.log('');

const pass = prunePass(db, policy, { apply });
for (const r of pass.results) {
  const cls = policy.classes.find((c) => c.class === r.data_class)!;
  const days = cls.days === null ? 'keep indefinitely' : `${cls.days}d`;
  const floor =
    cls.floor_days !== null && cls.days !== null && cls.days < cls.floor_days
      ? `  << RED: declared floor ${cls.floor_days}d exceeds configured ${cls.days}d`
      : '';
  console.log(`  ${r.data_class.padEnd(18)} ${r.table.padEnd(16)} ${days.padEnd(18)} total=${String(r.total_rows).padStart(7)}  ${apply ? `deleted=${r.deleted_rows}` : `would-go=<cutoff>`}${floor}`);
  if (r.refused_rows > 0) {
    console.log(`      REFUSED ${r.refused_rows} row(s): ${r.refused_reason}`);
  }
}
if (apply && pass.receipts.length > 0) {
  console.log('');
  console.log('  receipts written to store_prunes:');
  for (const r of pass.receipts) {
    console.log(`    ${r.table_name} (${r.data_class}): ${r.deleted_rows} rows, bytes ${r.bytes_before} → ${r.bytes_after}`);
  }
}
if (!apply) {
  console.log('');
  console.log('  dry run — pass --apply to prune (receipts land in store_prunes).');
  console.log('  The store is rebuildable only from sources that still exist: rows whose');
  console.log('  raw_ref is gone are refused, because the store holds the only copy.');
}
resetDbCache();
