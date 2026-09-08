/**
 * `vole reconcile` — the SINGLE opt-in, egress-declared network command
 * (tier 8 #40). Never the collector daemon, never the app on a timer.
 *
 * Sequence, in order: (1) sync the disk leg — the vendor's own figures from
 * local files, zero network; (2) print the exact hosts, paths and query
 * parameters each adapter would call, the identity it scopes to and the
 * columns it would write; (3) refuse to proceed without `--yes` OR a
 * `reconcile.confirmed` flag in ~/.vole/reconcile.json — and the same
 * no-egress switch every network call must respect, with VOLE_RECONCILE=1 as
 * the per-adapter enabler. A run that is not confirmed is a dry run: the plan
 * is the output, nothing leaves the machine.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb, insertAnomalies } from '../db';
import { usd } from '../util/format';
import {
  syncVendorLedgerFromDisk,
  upsertBridgeVendorIdentities,
  syncQuotaObservations,
  reconcileDelta,
  reconcileCoverage,
  rulesAfterPull,
  insertVendorLedger,
  utcDay,
  DAY_MS,
} from '../vendors/ledger';
import { anthropicPlan, anthropicAdaptability, runAnthropicAdapter, type AdapterPlan } from '../vendors/anthropic';
import { openaiPlan, codexAuthMode, runOpenAIAdapter } from '../vendors/openai';
import { cursorPlan, readCursorAiTracking, runCursorAdapter } from '../vendors/cursor';
import { copilotPlan, runCopilotAdapter } from '../vendors/copilot';

// ponytail: paths.ts is not this batch's file; the constant lives here until
// integration moves it next to unitsOverride/budgetPaths.
const RECONCILE_JSON = () => process.env.VOLE_RECONCILE_JSON ?? join(homedir(), '.vole', 'reconcile.json');

interface ReconcileConfig {
  reconcile?: { confirmed?: boolean };
  vendors?: { github?: { org?: string } };
}

function readConfig(): ReconcileConfig {
  try {
    if (!existsSync(RECONCILE_JSON())) return {};
    return JSON.parse(readFileSync(RECONCILE_JSON(), 'utf8')) as ReconcileConfig;
  } catch {
    return {};
  }
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const yes = args.includes('--yes');
const vendors = args
  .filter((a) => a.startsWith('--vendor='))
  .map((a) => a.slice('--vendor='.length))
  .flatMap((v) => v.split(','));
const from = args.find((a) => a.startsWith('--from='))?.slice('--from='.length) ?? '';
const to = args.find((a) => a.startsWith('--to='))?.slice('--to='.length) ?? '';
const org = args.find((a) => a.startsWith('--org='))?.slice('--org='.length);

const isoDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
if (vendors.length && (!isoDate(from) || !isoDate(to))) {
  console.error('vole reconcile: --vendor requires --from=YYYY-MM-DD and --to=YYYY-MM-DD');
  process.exit(2);
}

const db = openDb();

// ── 1. the disk leg: zero network, always runs ───────────────────────────────

const diskSync = syncVendorLedgerFromDisk(db);
const bridgeRows = upsertBridgeVendorIdentities(db);
const quotaSync = syncQuotaObservations(db);

// ── 2. the declared plan ─────────────────────────────────────────────────────

const config = readConfig();
const confirmed = yes || config.reconcile?.confirmed === true;
const enabled = process.env.VOLE_RECONCILE === '1' && process.env.VOLE_NO_EGRESS !== '1';

const plans: { name: string; plan: AdapterPlan; runnable: boolean; blocked?: string }[] = [];
if (!vendors.length || vendors.includes('anthropic')) {
  const adapt = anthropicAdaptability(db);
  plans.push({
    name: 'anthropic',
    plan: anthropicPlan(from || defaultFrom(), to || defaultTo()),
    runnable: adapt.admin_api_applies && confirmed && enabled,
    blocked: !adapt.admin_api_applies
      ? adapt.reason
      : !confirmed
        ? 'not confirmed (--yes or reconcile.confirmed in ~/.vole/reconcile.json)'
        : !enabled
          ? 'VOLE_RECONCILE is not "1" (dry-run by design)'
          : undefined,
  });
}
if (!vendors.length || vendors.includes('openai')) {
  const auth = codexAuthMode(db);
  plans.push({
    name: 'openai',
    plan: openaiPlan(from || defaultFrom(), to || defaultTo()),
    runnable: auth.comparable && confirmed && enabled,
    blocked: !auth.comparable ? auth.panel : !confirmed ? 'not confirmed' : !enabled ? 'VOLE_RECONCILE is not "1"' : undefined,
  });
}
if (!vendors.length || vendors.includes('cursor')) {
  plans.push({
    name: 'cursor',
    plan: cursorPlan(from || defaultFrom(), to || defaultTo()),
    runnable: confirmed && enabled,
    blocked: !confirmed ? 'not confirmed' : !enabled ? 'VOLE_RECONCILE is not "1"' : undefined,
  });
}
if (!vendors.length || vendors.includes('github')) {
  const orgId = org ?? config.vendors?.github?.org ?? null;
  plans.push({
    name: 'github',
    plan: copilotPlan(orgId ?? '<org>', from || defaultFrom(), to || defaultTo()),
    runnable: orgId != null && confirmed && enabled,
    blocked: orgId == null ? 'no org (--org= or vendors.github.org in reconcile.json)' : !confirmed ? 'not confirmed' : 'VOLE_RECONCILE is not "1"',
  });
}

function defaultFrom(): string {
  return new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
}
function defaultTo(): string {
  return new Date().toISOString().slice(0, 10);
}

const fromMs = from ? Date.parse(`${from}T00:00:00Z`) : Date.now() - 30 * DAY_MS;
const toMs = to ? Date.parse(`${to}T00:00:00Z`) + DAY_MS : Date.now();

type Report = Record<string, unknown> & { last_run?: Record<string, unknown> };
const report: Report = {
  ran_at: new Date().toISOString(),
  confirmed,
  egress_enabled: enabled,
  disk: {
    vendor_ledger_rows_written: diskSync.rows,
    cost_state_sessions: diskSync.sessions,
    bridge_identities_written: bridgeRows,
    quota_rows_written: quotaSync.written,
  },
  vendors: {} as Record<string, unknown>,
};

// ── 3. run what is runnable; everything else stays a printed plan ────────────

async function main(): Promise<void> {
  for (const p of plans) {
    (report.vendors as Record<string, unknown>)[p.name] = {
      runnable: p.runnable,
      blocked: p.blocked ?? null,
      requests: p.plan.requests.map((r) => ({ method: r.method, url: r.url, headers: r.headers })),
    };
    if (!p.runnable) continue;
    let run: Awaited<ReturnType<typeof runAnthropicAdapter>>;
    if (p.name === 'anthropic') run = await runAnthropicAdapter(db, from, to, { confirmed: true });
    else if (p.name === 'openai') run = await runOpenAIAdapter(db, from, to, { confirmed: true });
    else if (p.name === 'cursor') run = await runCursorAdapter(from, to, { confirmed: true });
    else run = await runCopilotAdapter(org ?? '', from, to, { confirmed: true });
    const ledgerRows = insertVendorLedger(db, run.ledgerRows);
    (report.vendors as Record<string, unknown>)[p.name] = {
      mode: run.mode,
      requests: run.requests,
      ledger_rows_written: ledgerRows,
    };
    if (run.mode === 'executed' && ledgerRows > 0) {
      const anomalies = rulesAfterPull(db, p.name === 'github' ? 'github_copilot' : p.name, fromMs, toMs);
      const written = insertAnomalies(db, anomalies);
      (report.vendors as Record<string, unknown>)[p.name] = {
        ...((report.vendors as Record<string, unknown>)[p.name] as object),
        rules_fired: written.inserted.length,
      };
    }
  }

  // The pull's receipt, appended to the user's config (their keys preserved).
  try {
    const existing: Report = existsSync(RECONCILE_JSON())
      ? (JSON.parse(readFileSync(RECONCILE_JSON(), 'utf8')) as Report)
      : {};
    existing.last_run = report;
    writeFileSync(RECONCILE_JSON(), `${JSON.stringify(existing, null, 2)}\n`);
  } catch {
    /* a receipt that cannot be written never blocks the pull itself */
  }

  const coverage = reconcileCoverage(db, fromMs, toMs);
  const delta = reconcileDelta(db, fromMs, toMs);

  if (json) {
    console.log(
      JSON.stringify(
        {
          ...report,
          coverage,
          delta,
          single_host_note: 'single-host mode: vendor_only spend is mostly other machines’ sessions; scope the vendor query to this identity before reading it as a gap',
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`vole reconcile — the single opt-in, egress-declared network command`);
  console.log(`disk leg (zero network): ${diskSync.rows} vendor_ledger rows from ${diskSync.sessions} cost-state sessions; ${bridgeRows} bridge identities; ${quotaSync.written} quota rows`);
  console.log(`confirmed: ${confirmed} · VOLE_RECONCILE=1: ${enabled ? 'yes' : 'no'}${enabled ? '' : ' (dry-run by design: nothing leaves the machine)'}`);
  for (const p of plans) {
    console.log(`\n${p.name} — ${p.runnable ? 'RUNNING' : `not running: ${p.blocked}`}`);
    for (const r of p.plan.requests) {
      console.log(`  ${r.method} ${r.url}`);
      console.log(`    headers: ${Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
    }
    for (const n of p.plan.notes) console.log(`  · ${n}`);
  }
  console.log(`\ncoverage (this endpoint only): ${coverage.priced_rows}/${coverage.rows} rows priced, ${coverage.exact_rows} exact, ${coverage.auth_reconcilable_rows} on a reconcilable auth path; list value priced ${usd(coverage.list_value_priced)}`);
  console.log(`delta (single-host mode — vendor_only is mostly other machines):`);
  for (const c of delta) {
    console.log(
      `  ${new Date(c.day).toISOString().slice(0, 10)} ${c.state.padEnd(14)} vendor ${usd(c.vendor_value)} · vole ${usd(c.local_value)}${c.state === 'matched' ? ` · delta ${usd(c.delta)} (${c.delta_pct?.toFixed(1)}%)` : ''}`,
    );
  }
}

void main();
