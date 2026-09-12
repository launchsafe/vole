/**
 * `vole models` — what each model you actually run costs you, side by side.
 *
 *   pnpm models                 the last 30 days
 *   pnpm models --range=7d      24h | 7d | 30d | all
 *   pnpm models --json
 *
 * Every row carries its confidence tier, because comparing an exact figure against an
 * unmeasured one without saying so is how a cheap-looking model gets picked for the
 * wrong reason. A model Vole cannot measure shows its real call count beside an empty
 * cost, never a flattering zero.
 */
import { openDbReadOnly } from '../db';
import { getModelComparison, type Range } from '../queries';
import { compact, usd } from '../util/format';

const args = process.argv.slice(2);
const json = args.includes('--json');
const range = (args.find((a) => a.startsWith('--range='))?.split('=')[1] ?? '30d') as Range;

const db = openDbReadOnly();
const rows = getModelComparison(db, range, false);

if (json) {
  console.log(JSON.stringify({ range, models: rows }, null, 2));
} else if (rows.length === 0) {
  console.log(`\nvole models · ${range}\n\n  Nothing recorded in this range.\n`);
} else {

const TIER: Record<string, string> = { exact: '', estimated: 'est', activity_only: 'no tokens' };
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const rpad = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s.padStart(n));

const L: string[] = [];
L.push('');
L.push(`vole models · ${range}`);
L.push('');
L.push(
  `${pad('MODEL', 30)} ${pad('TOOL', 12)} ${rpad('CALLS', 7)} ${rpad('TOKENS', 9)} ` +
  `${rpad('COST', 9)} ${rpad('$/CALL', 8)} ${rpad('TOK/CALL', 9)} ${rpad('CACHE', 6)} ${rpad('ERR', 5)}  TIER`,
);
for (const r of rows) {
  L.push(
    `${pad(r.model ?? '—', 30)} ${pad(r.tool, 12)} ${rpad(compact(r.calls), 7)} ` +
    `${rpad(r.tokens > 0 ? compact(r.tokens) : '—', 9)} ${rpad(r.cost !== null ? usd(r.cost) : '—', 9)} ` +
    `${rpad(r.costPerCall !== null ? `$${r.costPerCall.toFixed(3)}` : '—', 8)} ` +
    `${rpad(r.tokensPerCall > 0 ? compact(Math.round(r.tokensPerCall)) : '—', 9)} ` +
    `${rpad(r.cacheHitRatio !== null ? `${Math.round(r.cacheHitRatio * 100)}%` : '—', 6)} ` +
    `${rpad(r.errorRate > 0 ? `${(r.errorRate * 100).toFixed(1)}%` : '—', 5)}  ${TIER[r.confidence] ?? ''}`,
  );
}

const unpriced = rows.filter((r) => r.cost === null).length;
L.push('');
L.push('$/CALL is blank where any call in the row has no cost — an average over a partial');
L.push('total would read as cheap rather than as unknown.');
if (unpriced > 0) {
  L.push(`${unpriced} model(s) have no rate loaded. See: pnpm optimize`);
}
L.push('');
console.log(L.join('\n'));
}
