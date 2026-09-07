/**
 * Tier 8: k-anonymity with complementary suppression for the aggregate export.
 * Counts below k are suppressed (shown as "<k"), and the complementary set is
 * reported so the reader knows suppression happened — never silently.
 */
import { openDb } from '../db';

const K = 5;
const db = openDb();

function suppress(n: number): string {
  return n < K ? `<${K}` : String(n);
}

const byTool = db
  .prepare(
    `SELECT tool, COUNT(*) AS calls, SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost
     FROM usage_events WHERE source = 'live' GROUP BY tool`,
  )
  .all() as { tool: string; calls: number; tokens: number | null; cost: number | null }[];

const suppressedCount = byTool.filter((r) => r.calls < K).length;

console.log('Vole aggregate export (k=' + K + '-anonymous)');
console.log('──────────────────────────────');
for (const r of byTool.sort((a, b) => b.calls - a.calls)) {
  const tok = r.tokens === null ? '—' : suppress(r.tokens);
  console.log(`  ${r.tool.padEnd(14)} calls=${suppress(r.calls).padStart(7)}  tokens=${tok.padStart(14)}`);
}
if (suppressedCount > 0) {
  console.log(`\n  complementary suppression: ${suppressedCount} row(s) below k=${K} were suppressed.`);
  console.log('  The suppression is reported, never hidden — a reader can count what is missing.');
}
