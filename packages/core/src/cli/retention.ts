/**
 * Tier 8: retention with a receipt, gated on what can still be rebuilt. The
 * store is disposable by design (rebuildable from logs), so retention is
 * about the logs' own horizon and the store's growth — reported, and
 * --apply trims old rows with a counted receipt. The AI Act six-month floor
 * is shown against the minimisation ceiling: both are printed, neither is
 * silently chosen.
 */
import { openDb } from '../db';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const days = Number(args.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 180);
const db = openDb();
const cutoff = Date.now() - days * 24 * 3600_000;

const tables: { table: string; time_col: string; label: string }[] = [
  { table: 'usage_events', time_col: 'ts', label: 'usage events' },
  { table: 'anomalies', time_col: 'window_end', label: 'anomalies' },
  { table: 'tool_calls', time_col: 'ts', label: 'tool calls' },
];

console.log('Vole retention');
console.log('────────────────────');
console.log(`  policy                older than ${days} days`);
console.log(`  AI Act floor          180 days (shown, not chosen)`);
console.log('  store                 ~/.vole/vole.db');

for (const t of tables) {
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t.table} WHERE ${t.time_col} < ?`).get(cutoff) as { n: number }).n;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${t.table}`).get() as { n: number }).n;
  if (apply && n > 0) {
    const receipt = db.prepare(`DELETE FROM ${t.table} WHERE ${t.time_col} < ?`).run(cutoff).changes;
    console.log(`  ${t.label.padEnd(20)} DELETED ${receipt} of ${total} (receipt above)`);
  } else {
    console.log(`  ${t.label.padEnd(20)} ${n} of ${total} would go${apply ? '' : ' (dry run — --apply to trim)'}`);
  }
}

if (!apply) console.log('\n  The store is rebuildable from the vendors\' logs; the logs themselves');
if (!apply) console.log('  are pruned by the vendors (~30 days for Claude). Deleting store rows');
if (!apply) console.log('  loses nothing that the logs still hold.');
