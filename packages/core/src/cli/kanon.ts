/**
 * Tier 8: the aggregate export under k-anonymity with complementary
 * suppression. Primary suppression alone leaks — a single suppressed cell is
 * recovered from the published margins by subtraction — so this runs the
 * standard two-pass rule over the (tool, model, project-slug) × UTC-day grid,
 * counting DISTINCT SUBJECTS (one person with a laptop and a desktop is one),
 * with k from the policy block. The footer states k, the primary count and
 * the complementary count, so a DPO can inspect the exact artefact that
 * would be published. Suppression is per publication: a fixed publication
 * schedule with a stable cell set is a deployment requirement, not a
 * nice-to-have.
 */
import { openDb } from '../db';
import { dailyRollup, toGrid, twoPassSuppression, renderCell, policyK } from '../privacy/kanon';
import { kanonBlock } from '../privacy/register';

const args = process.argv.slice(2);
const rangeArg = args.find((a) => a.startsWith('--range='));
const range = rangeArg ? rangeArg.split('=')[1]! : '30d';
const m = range.match(/^(\d+)([dwm])$/);
const n = m ? Number(m[1]) : 30;
const unitMs = m?.[2] === 'w' ? 7 * 86_400_000 : m?.[2] === 'm' ? 30 * 86_400_000 : 86_400_000;
const to = Date.now();
const from = to - n * unitMs;

const k = policyK(kanonBlock());
const db = openDb();
const cells = dailyRollup(db, from, to);
const grid = toGrid(cells);
const result = twoPassSuppression(grid.values, k);

console.log(`Vole aggregate export (k=${k}-anonymous, distinct subjects)`);
console.log('──────────────────────────────────────────');
if (grid.rowLabels.length === 0) {
  console.log('  no live rows in range');
  process.exit(0);
}
const dayWidth = 12;
const header = '  tool|model|slug'.padEnd(44) + grid.colLabels.map((d) => new Date(d * 86_400_000).toISOString().slice(5, 10).padStart(dayWidth)).join('');
console.log(header);
grid.rowLabels.forEach((label, i) => {
  const cellsOut = grid.values[i]!.map((v, j) => renderCell(v, result.suppressed[i]![j]!, k).padStart(dayWidth)).join('');
  const margin = result.rowMargins[i] === null ? '  (margin withheld)'.padEnd(dayWidth) : String(result.rowMargins[i]).padStart(dayWidth);
  console.log(`  ${label.slice(0, 42).padEnd(42)}${cellsOut}${margin}`);
});
const colMarginLine = '  '.padEnd(44) + result.colMargins.map((c) => (c === null ? '—'.padStart(dayWidth) : String(c).padStart(dayWidth))).join('');
const totalLine = result.grandTotal === null ? '  (grand total withheld)' : `  grand total: ${result.grandTotal}`;
console.log(colMarginLine);
console.log(totalLine);
console.log('');
console.log(`  k=${k} · primary suppressions: ${result.primary} · complementary suppressions: ${result.complementary}`);
console.log('  Suppression is computed per publication: differencing successive daily');
console.log('  publications can reconstruct a suppressed cell unless the cell set is');
console.log('  fixed — publish on a schedule, from the same grid shape, every time.');
