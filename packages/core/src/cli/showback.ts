/**
 * `vole showback` — the Costs screen's data, with the coverage fraction
 * attached to every total (tier 8 #24/#25/#18/#29/#27/#22/#35).
 *
 * Every aggregate obeys the two rules the bare SUM broke: costs are split by
 * cost_basis (a mixed roll-up says 'mixed basis' instead of one KPI), and the
 * unpriced count sits beside the total ('… · 2,678 calls unpriced') instead of
 * being silently dropped. Uncosted rows render an em dash, never $0.00.
 * Read-only: nothing here writes the store.
 */
import { readFileSync } from 'node:fs';
import { openDbReadOnly } from '../db';
import { paths } from '../paths';
import { compact, usd } from '../util/format';
import {
  cacheEconomics,
  evaluateBudget,
  loadBudgets,
  loadUnitDeclarations,
  usdPerUnit,
  uncostedClass,
  type BudgetResult,
} from '../pricing';
import { reconcileCoverage, reconcileDelta, readQuotaSnapshot, DAY_MS } from '../vendors/ledger';
import { readCopilotRateCards } from '../vendors/copilot';

const args = process.argv.slice(2);
const json = args.includes('--json');
const days = Number(args.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 30);
const to = Date.now();
const from = to - days * DAY_MS;

const db = openDbReadOnly();

interface ByToolBasis {
  tool: string;
  cost_basis: string | null;
  calls: number;
  tokens: number | null;
  cost: number | null;
  unpriced_calls: number;
}

const byToolBasis = db
  .prepare(
    `SELECT tool, cost_basis, COUNT(*) AS calls,
            SUM(CASE WHEN confidence != 'activity_only' THEN total_tokens END) AS tokens,
            SUM(cost_usd) AS cost,
            SUM(CASE WHEN cost_usd IS NULL AND confidence = 'exact' THEN 1 ELSE 0 END) AS unpriced_calls
     FROM usage_events WHERE source = 'live' AND ts >= ? AND ts < ? GROUP BY tool, cost_basis
     ORDER BY cost DESC`,
  )
  .all(from, to) as ByToolBasis[];

const uncosted = db
  .prepare(
    `SELECT tool, model, COUNT(*) AS calls,
            SUM(CASE WHEN confidence != 'activity_only' THEN total_tokens END) AS tokens
     FROM usage_events
     WHERE source = 'live' AND ts >= ? AND ts < ? AND cost_usd IS NULL AND confidence = 'exact'
     GROUP BY tool, model
     ORDER BY tokens DESC`,
  )
  .all(from, to) as { tool: string; model: string | null; calls: number; tokens: number | null }[];

const cacheAgg = db
  .prepare(
    `SELECT model,
            SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
            SUM(cache_write_5m_tokens) AS cache_write_5m_tokens,
            SUM(cache_write_1h_tokens) AS cache_write_1h_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens
     FROM usage_events WHERE source = 'live' AND ts >= ? AND ts < ? AND model IS NOT NULL
     GROUP BY model ORDER BY cache_read_tokens DESC LIMIT 10`,
  )
  .all(from, to) as {
    model: string;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_write_5m_tokens: number | null;
    cache_write_1h_tokens: number | null;
    cache_read_tokens: number | null;
  }[];

const budgetRows = db
  .prepare(
    `SELECT tool, model, project, user, cost_usd, cost_basis, total_tokens, confidence
     FROM usage_events WHERE source = 'live' AND ts >= ? AND ts < ?`,
  )
  .all(from, to) as {
    tool: string;
    model: string | null;
    project: string | null;
    user: string | null;
    cost_usd: number | null;
    cost_basis: string | null;
    total_tokens: number | null;
    confidence: string;
  }[];

const declarations = loadUnitDeclarations(
  (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  paths.unitsOverride(),
);
const budgets = loadBudgets(
  (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  paths.budgetPaths(),
);
const budgetResults: BudgetResult[] = budgets.map((b) => evaluateBudget(b, budgetRows, from));

const coverage = reconcileCoverage(db, from, to);
const delta = reconcileDelta(db, from, to);
const quota = readQuotaSnapshot();
const rateCards = readCopilotRateCards();
// ponytail: AIC totals come from the cards on disk each run; a persisted
// per-model usage-in-AIC join needs a foundation column.
const aicTotal = rateCards.length;

const basisTotal = new Map<string, { cost: number; unpriced: number; calls: number }>();
for (const r of byToolBasis) {
  const key = r.cost_basis ?? '(no basis)';
  const b = basisTotal.get(key) ?? { cost: 0, unpriced: 0, calls: 0 };
  b.cost += r.cost ?? 0;
  b.unpriced += r.unpriced_calls;
  b.calls += r.calls;
  basisTotal.set(key, b);
}

if (json) {
  console.log(
    JSON.stringify(
      {
        window: { from, to, days },
        by_tool_basis: byToolBasis,
        basis_totals: [...basisTotal],
        uncosted: uncosted.map((u) => ({ ...u, class: uncostedClass(u.model) })),
        cache_economics: cacheAgg.map((c) => ({ model: c.model, ...cacheEconomics(c.model, c) })),
        budgets: budgetResults,
        coverage,
        delta,
        quota,
        copilot_rate_cards: { cards: aicTotal, unit: 'AIC', usd_per_unit: usdPerUnit(declarations, 'github_copilot', 'AIC', to) },
      },
      null,
      2,
    ),
  );
} else {
  console.log(`vole showback — last ${days} days, live rows only`);
  console.log(`\ncosts by basis (a mixed roll-up is never one number):`);
  for (const [basis, b] of basisTotal) {
    console.log(`  ${basis.padEnd(20)} ${usd(b.cost)} · ${b.unpriced.toLocaleString()} calls unpriced (${b.calls.toLocaleString()} total)`);
  }
  const allUnpriced = [...basisTotal.values()].reduce((s, b) => s + b.unpriced, 0);
  const pricedValue = coverage.list_value_priced;
  console.log(
    `\ncoverage fraction: ${coverage.rows > 0 ? ((coverage.priced_rows / coverage.rows) * 100).toFixed(0) : '—'}% of rows priced (${coverage.priced_rows}/${coverage.rows}); ${allUnpriced.toLocaleString()} unpriced calls sit beside every total — ${usd(pricedValue)} of priced value, endpoint-only statement`,
  );
  console.log(`\nuncosted (em dash, never $0.00):`);
  const byClass = new Map<string, { tokens: number; calls: number }>();
  for (const u of uncosted) {
    const k = uncostedClass(u.model);
    const b = byClass.get(k) ?? { tokens: 0, calls: 0 };
    b.tokens += u.tokens ?? 0;
    b.calls += u.calls;
    byClass.set(k, b);
  }
  for (const [k, b] of byClass) console.log(`  ${k.padEnd(18)} ${compact(b.tokens)} tokens · ${b.calls.toLocaleString()} calls · cost —`);
  console.log(`  (declare a rate in ~/.vole/units.json to price these)`);
  console.log(`\ncache economics (5m vs 1h split):`);
  for (const c of cacheAgg) {
    const e = cacheEconomics(c.model, c);
    console.log(
      `  ${c.model}: read/fresh ${e.read_fresh_ratio?.toFixed(1) ?? '—'}× · rewarm 5m ${usd(e.rewarm_usd_5m)} / 1h ${usd(e.rewarm_usd_1h)}${e.ttl_split_observed ? '' : ' · TTL split not observable for this tool'}`,
    );
  }
  console.log(`\nbudgets (scoped by cost_basis):`);
  if (!budgetResults.length) console.log(`  none declared (~/.vole/budgets.json)`);
  for (const b of budgetResults) {
    const scope = Object.entries(b.scope).map(([k, v]) => `${k}=${v}`).join(' ') || 'all';
    console.log(
      `  ${scope} [${b.cost_basis ?? 'tokens'}] ${b.verdict === 'indeterminate' ? 'indeterminate: ' + b.unpriced_calls.toLocaleString() + ' unpriced calls in scope' : `${usd(b.spent_usd)} / ${usd(b.limit_usd)}`}`,
    );
  }
  console.log(`\nreconciliation:`);
  for (const c of delta.slice(-10)) {
    console.log(`  ${new Date(c.day).toISOString().slice(0, 10)} ${c.state.padEnd(14)} vendor ${usd(c.vendor_value)} · vole ${usd(c.local_value)}`);
  }
  if (quota) {
    const top = quota.limits.find((l) => l.kind.includes('weekly') && l.is_active !== false) ?? quota.limits[0];
    if (top) {
      const resets = top.resets_at ? new Date(top.resets_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown';
      const age = quota.fetchedAtMs ? `${Math.round((Date.now() - quota.fetchedAtMs) / 3600000)} h ago` : 'unknown';
      console.log(`\nquota: ${top.kind} ${top.used_percent ?? '—'}%, resets ${resets}, read ${age}${quota.stale ? ' (stale — refreshes only while the agent runs; covers the whole account, so it is an upper bound on this endpoint’s share)' : ''}`);
    }
  }
  console.log(`\nCopilot rate cards on disk: ${aicTotal} models, unit AIC — USD ${usdPerUnit(declarations, 'github_copilot', 'AIC', to) === null ? '— (no declaration in units.json)' : 'declared'}`);
}
