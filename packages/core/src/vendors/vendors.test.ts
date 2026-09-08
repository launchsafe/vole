/**
 * Tier 8 vendor-cost plane tests: the disk ledger, the delta state machine,
 * the two rules' gates, and the pricing additions (basis, uncosted, cache
 * economics, budgets, unit declarations).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, insertEvents, insertAnomalies, resetDbCache, type DB } from '../db';
import type { UsageEvent } from '../types';
import {
  readClaudeCostStates,
  syncVendorLedgerFromDisk,
  readClaudeProjectLastCost,
  readQuotaSnapshot,
  quotaRows,
  upsertBridgeVendorIdentities,
  reconcileDelta,
  reconcileCoverage,
  detectReconcileGap,
  detectShadowAccountSpend,
  DAY_MS,
  type GapCell,
} from './ledger';
import { anthropicPlan, anthropicAdaptability } from './anthropic';
import { codexAuthMode } from './openai';
import { readCopilotRateCards, insertCopilotRateCards } from './copilot';
import {
  basisFor,
  stampCostBasis,
  uncostedClass,
  cacheEconomics,
  billableTokens,
  evaluateBudget,
  loadUnitDeclarations,
  usdPerUnit,
  loadBudgets,
  type BudgetDeclaration,
} from '../pricing';

function freshDb(): DB {
  resetDbCache(); // openDb caches one DB per process; each test gets a clean store
  const dir = mkdtempSync(join(tmpdir(), 'vole-vendors-'));
  return openDb(join(dir, 't.db'));
}

function ev(over: Partial<UsageEvent>): UsageEvent {
  return {
    event_key: over.event_key ?? `k${Math.random()}`,
    tool: 'claude_code',
    model: null,
    session_id: null,
    project: null,
    git_branch: null,
    ts: 0,
    input_tokens: null,
    output_tokens: null,
    cache_write_5m_tokens: null,
    cache_write_1h_tokens: null,
    cache_read_tokens: null,
    reasoning_tokens: null,
    total_tokens: null,
    cost_usd: null,
    confidence: 'exact',
    is_error: 0,
    stop_reason: null,
    source: 'live',
    raw_ref: null,
    tools: null,
    agent_id: null,
    context_window: null,
    duration_ms: null,
    duration_kind: null,
    ...over,
  };
}

const DAY = (n: number): number => 20_834 * DAY_MS + n * DAY_MS; // a fixed, UTC-day-aligned epoch, never now()

// ── cost-state parsing (tier 8 #37) ──────────────────────────────────────────

test('cost-state: the LAST line per session wins; a missing figure is NULL, never 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-cs-'));
  const proj = join(dir, 'p1');
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, 's1.jsonl'),
    [
      JSON.stringify({ type: 'cost-state', timestamp: '2027-01-01T10:00:00Z', sessionId: 's1', totalCostUSD: 0.1 }),
      JSON.stringify({ type: 'user', message: 'x' }),
      JSON.stringify({
        type: 'cost-state',
        timestamp: '2027-01-01T11:00:00Z',
        sessionId: 's1',
        totalCostUSD: 0.20247400000000002,
        hasUnknownModelCost: true,
        modelUsage: { 'claude-fable-5-1': { costUSD: 0.2, inputTokens: 100, outputTokens: 50 } },
      }),
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(proj, 's2.jsonl'),
    JSON.stringify({ type: 'cost-state', timestamp: '2027-01-01T12:00:00Z', sessionId: 's2' }) + '\n',
  );
  const figures = readClaudeCostStates([dir]);
  assert.equal(figures.length, 2);
  const s1 = figures.find((f) => f.session_id === 's1');
  assert.ok(s1);
  assert.equal(s1.totalCostUSD, 0.20247400000000002); // last line, not the mid-session copy
  assert.equal(s1.hasUnknownModelCost, true);
  assert.equal(s1.modelUsage[0].model, 'claude-fable-5-1');
  const s2 = figures.find((f) => f.session_id === 's2');
  assert.ok(s2);
  assert.equal(s2.totalCostUSD, null); // interrupted/crashed session: no figure, never zero
});

test('syncVendorLedgerFromDisk aggregates to UTC days, idempotently, flagging incomplete figures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-cs2-'));
  mkdirSync(join(dir, 'p'), { recursive: true });
  writeFileSync(
    join(dir, 'p', 'a.jsonl'),
    JSON.stringify({ type: 'cost-state', timestamp: '2027-01-01T10:00:00Z', sessionId: 'a', totalCostUSD: 0.2 }) + '\n',
  );
  writeFileSync(
    join(dir, 'p', 'b.jsonl'),
    JSON.stringify({ type: 'cost-state', timestamp: '2027-01-01T15:00:00Z', sessionId: 'b', totalCostUSD: 0.1, hasUnknownModelCost: true }) + '\n',
  );
  const db = freshDb();
  const r1 = syncVendorLedgerFromDisk(db, [dir]);
  assert.equal(r1.sessions, 2);
  const row = db
    .prepare(`SELECT vendor_cost_usd, unit, rows, source FROM vendor_ledger WHERE vendor = 'anthropic'`)
    .get() as { vendor_cost_usd: number; unit: string; rows: number; source: string };
  assert.equal(row.vendor_cost_usd, 0.30000000000000004); // the vendor's own numbers, summed verbatim
  assert.equal(row.unit, 'USD');
  assert.equal(row.rows, 2);
  assert.equal(row.source, 'claude_cost_state_incomplete'); // hasUnknownModelCost preserved
  // Idempotent re-run: same unique key, no duplicate rows.
  syncVendorLedgerFromDisk(db, [dir]);
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM vendor_ledger`).get() as { n: number }).n;
  assert.equal(n, 1);
});

test('lastCost per project is read verbatim, missing fields NULL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-lc-'));
  const file = join(dir, '.claude.json');
  writeFileSync(
    file,
    JSON.stringify({ projects: { '/repo/landing': { lastCost: 2.02543, lastTotalInputTokens: 10 }, '/repo/empty': {} } }),
  );
  const rows = readClaudeProjectLastCost(file);
  assert.equal(rows.length, 2);
  const landing = rows.find((r) => r.cwd === '/repo/landing');
  assert.ok(landing);
  assert.equal(landing.lastCost, 2.02543);
  assert.equal(landing.lastTotalInputTokens, 10);
  assert.equal(landing.lastTotalOutputTokens, null);
  assert.equal(rows.find((r) => r.cwd === '/repo/empty')?.lastCost, null);
});

// ── quota ledger: the real cachedUsageUtilization shape (tier 8 #22) ─────────

test('cachedUsageUtilization parses the verified live shape into ledger rows', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'vole-q-')), 'claude.json');
  writeFileSync(
    file,
    JSON.stringify({
      cachedUsageUtilization: {
        fetchedAtMs: 1788763107042,
        utilization: { five_hour: { utilization: 3 }, seven_day: { utilization: 42, resets_at: '2026-09-09T10:00:00Z' } },
        limits: [
          { scope: { type: 'session' }, percent: 0, resets_at: '2026-09-07T15:00:00Z', is_active: true, session_dollars: null },
          { scope: { type: 'weekly_all' }, percent: 42, resets_at: '2026-09-09T10:00:00Z', is_active: true, weekly_dollars: null },
          { scope: { type: 'weekly_scoped', model: { display_name: 'Fable' } }, percent: 61, resets_at: '2026-09-09T10:00:00Z', is_active: true },
        ],
        extra_usage: { is_enabled: false },
        spend: { used: { amount_minor: 0 } },
      },
    }),
  );
  const snap = readQuotaSnapshot(file);
  assert.ok(snap);
  assert.equal(snap.fetchedAtMs, 1788763107042);
  assert.equal(snap.utilization.seven_day, 42);
  const scoped = snap.limits.find((l) => l.kind === 'weekly_scoped');
  assert.ok(scoped);
  assert.equal(scoped.used_percent, 61);
  assert.equal(scoped.model_display_name, 'Fable');
  assert.equal(snap.spend_minor, 0);
  assert.equal(snap.extra_usage_enabled, false);
  const rows = quotaRows(snap);
  assert.ok(rows.some((r) => r.kind === 'weekly_scoped' && r.used_percent === 61 && r.reset_at === Date.parse('2026-09-09T10:00:00Z')));
  assert.ok(rows.some((r) => r.kind === 'spend_minor_units' && r.limit_value === 0)); // verbatim minor units, unconverted
  // keys carry the vendor's own fetchedAtMs, so re-inserting the same snapshot is a no-op
  assert.equal(quotaRows(snap).length, rows.length);
});

// ── vendor_identities: bridge sessions (tier 8 #17) ──────────────────────────

test('bridge-session owners land as HMACs, never raw uuids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-br-'));
  mkdirSync(join(dir, 'p'), { recursive: true });
  writeFileSync(
    join(dir, 'p', 's.jsonl'),
    JSON.stringify({ type: 'bridge-session', sessionId: 'sess-1', ownerAccountUuid: 'uuid-abc', ownerOrganizationUuid: 'org-xyz' }) + '\n',
  );
  const db = freshDb();
  const n = upsertBridgeVendorIdentities(db, [dir]);
  assert.ok(n >= 1);
  const row = db
    .prepare(`SELECT vendor_id_hmac, org_id_hmac, local_key FROM vendor_identities WHERE local_key_kind = 'bridge_session'`)
    .get() as { vendor_id_hmac: string; org_id_hmac: string; local_key: string };
  assert.equal(row.local_key, 'sess-1');
  assert.notEqual(row.vendor_id_hmac, 'uuid-abc'); // a digest, never the value
  assert.match(row.vendor_id_hmac, /^[0-9a-f]{64}$/);
  assert.match(row.org_id_hmac, /^[0-9a-f]{64}$/);
  // idempotent: same unique key
  upsertBridgeVendorIdentities(db, [dir]);
  const cnt = (db.prepare(`SELECT COUNT(*) AS n FROM vendor_identities WHERE local_key_kind = 'bridge_session'`).get() as { n: number }).n;
  assert.equal(cnt, 1);
});

// ── the delta view (tier 8 #38) ──────────────────────────────────────────────

test('delta: a NULL local cost makes the cell not_comparable with delta NULL — never a fake gap', () => {
  const db = freshDb();
  const d0 = DAY(0), d1 = DAY(1), d2 = DAY(2);
  insertEvents(db, [
    ev({ event_key: 'a', ts: d0, cost_usd: 10, total_tokens: 100 }),
    // day 1: one priced + one NULL-cost row → not_comparable
    ev({ event_key: 'b', ts: d1, cost_usd: 5, total_tokens: 50 }),
    ev({ event_key: 'c', ts: d1, cost_usd: null, total_tokens: 50 }),
    // day 2: local_only (no vendor row)
    ev({ event_key: 'd', ts: d2, cost_usd: 7, total_tokens: 70 }),
  ]);
  db.prepare(
    `INSERT INTO vendor_ledger (vendor, period_start, period_end, vendor_cost_usd, currency, unit, rows, pulled_at, source)
     VALUES ('anthropic', ?, ?, 10, 'USD', 'USD', 1, 1, 'api:anthropic_cost_report'),
            ('anthropic', ?, ?, 5, 'USD', 'USD', 1, 1, 'api:anthropic_cost_report'),
            ('anthropic', ?, ?, 3, 'USD', 'USD', 1, 1, 'api:anthropic_cost_report'),
            ('anthropic', ?, ?, 3, 'USD', 'EUR', 1, 1, 'x')`,
  ).run(d0, d0 + DAY_MS, d1, d1 + DAY_MS, DAY(3), DAY(3) + DAY_MS, DAY(4), DAY(4) + DAY_MS);
  const cells = reconcileDelta(db, d0, d0 + 5 * DAY_MS, 'anthropic', 'claude_code');
  const byDay = new Map(cells.map((c) => [c.day, c]));
  const c0 = byDay.get(d0);
  assert.ok(c0);
  assert.equal(c0.state, 'matched');
  assert.equal(c0.delta, 0);
  const c1 = byDay.get(d1);
  assert.ok(c1);
  assert.equal(c1.state, 'not_comparable');
  assert.equal(c1.delta, null); // a missing local number is never read as zero
  assert.equal(c1.uncomparable_calls, 1);
  const c2 = byDay.get(d2);
  assert.ok(c2);
  assert.equal(c2.state, 'local_only');
  const vendorOnly = byDay.get(DAY(3));
  assert.ok(vendorOnly);
  assert.equal(vendorOnly.state, 'vendor_only');
  const unitsDiffer = cells.find((c) => c.state === 'units_differ');
  assert.ok(unitsDiffer, 'a non-USD unit is units_differ, never a converted delta');
});

// ── the coverage report (tier 8 #35) ──────────────────────────────────────────

test('coverage counts the three axes and marks subscription plans not reconcilable', () => {
  const db = freshDb();
  insertEvents(db, [
    ev({ event_key: 'x1', tool: 'claude_code', ts: DAY(0), cost_usd: 1, total_tokens: 10 }),
    ev({ event_key: 'x2', tool: 'claude_code', ts: DAY(0), cost_usd: null, total_tokens: 10 }),
    ev({ event_key: 'x3', tool: 'cursor', ts: DAY(0), cost_usd: null, total_tokens: null, confidence: 'activity_only' }),
  ]);
  db.prepare(
    `INSERT INTO vendor_identities (vendor, local_key_kind, local_key, vendor_id_kind, vendor_id_hmac, plan, first_seen, last_seen)
     VALUES ('anthropic', 'oauthAccount', 'claude_code', 'organizationUuid', 'h', 'claude_max/stripe_subscription', 1, 1)`,
  ).run();
  const cov = reconcileCoverage(db, DAY(0), DAY(1));
  assert.equal(cov.endpoint_only, true);
  assert.equal(cov.rows, 3);
  assert.equal(cov.priced_rows, 1);
  assert.equal(cov.unpriced_rows, 2);
  assert.equal(cov.activity_only_rows, 1);
  assert.equal(cov.exact_rows, 2);
  // subscription plan: the console can never show this usage, so no row is reconcilable
  assert.equal(cov.auth_reconcilable_rows, 0);
  assert.equal(cov.per_tool.find((t) => t.tool === 'claude_code')?.note, 'subscription plan (claude_max/stripe_subscription) — the console will never show this usage');
});

// ── reconcile_gap (tier 8 #44) ─────────────────────────────────────────────────

function gapCell(day: number, vendor_value: number, local_value: number | null, over: Partial<GapCell> = {}): GapCell {
  return {
    vendor: 'anthropic',
    identity: 'idhmac',
    day,
    direction: 'tokens',
    vendor_value,
    local_value,
    vendor_unit: 'tokens',
    local_unit: 'tokens',
    not_comparable: false,
    ...over,
  };
}

test('reconcile_gap fires only on two consecutive days, with a deterministic now-free key', () => {
  const cells: GapCell[] = [
    gapCell(DAY(0), 1_000_000, 900_000), // 10%: below threshold
    gapCell(DAY(1), 1_000_000, 500_000), // 50%: exceeds, but day 0 did not
    gapCell(DAY(2), 1_000_000, 600_000), // 40%: second consecutive day → fires for day 2
    gapCell(DAY(4), 1_000_000, 100_000), // exceeds, isolated → must not fire
  ];
  const out = detectReconcileGap(cells, 12345);
  assert.equal(out.length, 1);
  assert.equal(out[0].anomaly_key, `reconcile:anthropic:idhmac:${DAY(2)}:tokens`);
  assert.equal(out[0].rule, 'reconcile_gap');
  assert.equal(out[0].threshold, 15);
  assert.equal(out[0].detected_at, 12345);
  // not_comparable and unit-mismatched cells never fire
  assert.equal(
    detectReconcileGap([gapCell(DAY(0), 100, 10, { not_comparable: true }), gapCell(DAY(1), 100, 10, { not_comparable: true })], 1).length,
    0,
  );
  assert.equal(
    detectReconcileGap([gapCell(DAY(0), 100, 10, { vendor_unit: 'USD' }), gapCell(DAY(1), 100, 10, { vendor_unit: 'USD' })], 1).length,
    0,
  );
});

// ── shadow_account_spend (tier 8 #1) ─────────────────────────────────────────

test('shadow_account_spend: no pull → no fire; subscription → no fire; blind model → fires', () => {
  const base = {
    vendor: 'anthropic',
    local_days: [
      { day: DAY(0), model: 'qwen3.8-27b-fp8', tokens: 559_100_000, cost_usd: null },
      { day: DAY(0), model: 'claude-fable-5-1', tokens: 1_000, cost_usd: 0.01 },
    ],
    vendor_days: [{ day: DAY(0), models: ['claude-fable-5-1'] }],
  };
  assert.equal(detectShadowAccountSpend({ ...base, pull_ran: false, subscription: false }, 1).length, 0);
  assert.equal(detectShadowAccountSpend({ ...base, pull_ran: true, subscription: true }, 1).length, 0);
  const out = detectShadowAccountSpend({ ...base, pull_ran: true, subscription: false }, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].rule, 'shadow_account_spend');
  assert.equal(out[0].anomaly_key, `shadow_account_spend:anthropic:${DAY(0)}`);
  assert.ok(out[0].title.includes('Console never saw this'));
  assert.ok(out[0].detail.includes('qwen3.8-27b-fp8'));
  // zero-token (activity_only) days can never claim console blindness
  assert.equal(
    detectShadowAccountSpend(
      { vendor: 'anthropic', pull_ran: true, subscription: false, local_days: [{ day: DAY(0), model: 'm', tokens: 0, cost_usd: null }], vendor_days: [] },
      1,
    ).length,
    0,
  );
});

// ── adapters: plans and gates ─────────────────────────────────────────────────

test('anthropic plan names the exact three GETs; subscription accounts degrade without calling', () => {
  const plan = anthropicPlan('2026-08-01', '2026-08-31');
  assert.equal(plan.requests.length, 3);
  assert.ok(plan.requests[0].url.includes('/v1/organizations/usage_report/messages?starting_at=2026-08-01'));
  assert.ok(plan.requests[0].url.includes('group_by[]=model'));
  assert.ok(plan.requests[2].url.includes('/v1/organizations/cost_report'));
  assert.equal(plan.requests[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(plan.requests[0].headers['x-api-key'], '<ANTHROPIC_ADMIN_KEY>'); // the value never appears
  const db = freshDb();
  db.prepare(
    `INSERT INTO vendor_identities (vendor, local_key_kind, local_key, plan, first_seen, last_seen)
     VALUES ('anthropic', 'oauthAccount', 'claude_code', 'claude_max/stripe_subscription', 1, 1)`,
  ).run();
  assert.equal(anthropicAdaptability(db).admin_api_applies, false);
});

test('codex under a ChatGPT login gets a cannot-compare panel, not a number', () => {
  const db = freshDb();
  assert.equal(codexAuthMode(db).comparable, false); // no identity on disk
  db.prepare(
    `INSERT INTO vendor_identities (vendor, local_key_kind, local_key, auth_path, first_seen, last_seen)
     VALUES ('openai', 'auth_mode', 'codex', 'oauth', 1, 1)`,
  ).run();
  const auth = codexAuthMode(db);
  assert.equal(auth.auth_mode, 'chatgpt');
  assert.equal(auth.comparable, false);
  assert.ok(auth.panel.includes('cannot-compare'));
});

// ── copilot rate cards (tier 8 #32) ──────────────────────────────────────────

test('copilot models.json is read in AIC, never converted, and lands as NULL-rate declarations', () => {
  const root = mkdtempSync(join(tmpdir(), 'vole-cop-'));
  const gs = join(root, 'User', 'globalStorage', 'github.copilot-chat', 'debug-logs', 'sess-1');
  mkdirSync(gs, { recursive: true });
  writeFileSync(
    join(gs, 'models.json'),
    JSON.stringify({
      models: {
        'gpt-5.1': {
          billing: {
            token_prices: {
              default: { input_price: 1000, output_price: 5000, cache_price: 62.5, cache_write_price: 1250, context_max: 223790 },
              long_context: { input_price: 2000, output_price: 5000, cache_price: 62.5, cache_write_price: 2500, context_max: 400000 },
            },
            restricted_to: ['pro_plus', 'business'],
          },
          capabilities: { limits: { max_context_window_tokens: 400000, max_output_tokens: 128000, max_non_streaming_output_tokens: 32000 } },
        },
      },
    }),
  );
  const cards = readCopilotRateCards([{ app: 'Code', root, marker: join(root, 'marker') }]);
  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.equal(c.model, 'gpt-5.1');
  assert.equal(c.tiers.length, 2);
  assert.equal(c.tiers[0].input_price, 1000);
  assert.deepEqual(c.restricted_to, ['pro_plus', 'business']);
  assert.equal(c.capabilities.max_context_window_tokens, 400000);
  assert.ok(c.observed_at !== null);
  const db = freshDb();
  const n = insertCopilotRateCards(db, cards);
  assert.equal(n, 2);
  const row = db
    .prepare(`SELECT unit, usd_per_unit, note FROM billing_units WHERE vendor = 'github_copilot'`)
    .all() as { unit: string; usd_per_unit: number | null; note: string }[];
  assert.ok(row.every((r) => r.unit === 'AIC' && r.usd_per_unit === null)); // an em dash, never a conversion
  assert.ok(row.some((r) => r.note.includes('in 1000 / out 5000 AIC per 1M')));
});

// ── pricing additions ─────────────────────────────────────────────────────────

test('cost_basis: the classifier, and the one-shot NULL-only widening stamp', () => {
  assert.equal(basisFor('claude_code'), 'anthropic_list');
  assert.equal(basisFor('opencode'), 'provider_reported');
  assert.equal(basisFor('codex'), null);
  const db = freshDb();
  insertEvents(db, [
    ev({ event_key: 'b1', tool: 'claude_code', ts: 1, total_tokens: 1 }),
    ev({ event_key: 'b2', tool: 'opencode', ts: 1, total_tokens: 1 }),
    ev({ event_key: 'b3', tool: 'codex', ts: 1, total_tokens: 1 }),
  ]);
  assert.equal(stampCostBasis(db), 2);
  const bases = (db.prepare(`SELECT tool, cost_basis FROM usage_events ORDER BY tool`).all() as { tool: string; cost_basis: string | null }[]).map((b) => ({ ...b }));
  assert.deepEqual(
    bases,
    [
      { tool: 'claude_code', cost_basis: 'anthropic_list' },
      { tool: 'codex', cost_basis: null },
      { tool: 'opencode', cost_basis: 'provider_reported' },
    ],
  );
  assert.equal(stampCostBasis(db), 0); // idempotent, and never re-derives over a stored value
});

test('uncostedClass: only confident classes are distinguished', () => {
  assert.equal(uncostedClass('ollama/qwen3.8'), 'local');
  assert.equal(uncostedClass('unsloth-studio/qwen38-heretic'), 'local');
  assert.equal(uncostedClass('qwen-h200/whatever'), 'local');
  assert.equal(uncostedClass('openrouter/stealth/ox-alpha:free'), 'free_tier');
  assert.equal(uncostedClass('opencode-zen/zen'), 'uncosted_unknown'); // never guessed
  assert.equal(uncostedClass(null), 'uncosted_unknown');
});

test('cache economics prices each TTL class with its own multiplier; exposure ignores cache reads', () => {
  const e = cacheEconomics('claude-fable-5-1', {
    input_tokens: 1_000_000,
    cache_write_5m_tokens: 1_000_000,
    cache_write_1h_tokens: 1_000_000,
    cache_read_tokens: 9_000_000,
  });
  // fable input $10/MTok: 5m write 1.25x = $12.5, 1h write 2.0x = $20 — the 1h premium is no longer priced at the 5m rate
  assert.equal(e.rewarm_usd_5m, 12.5);
  assert.equal(e.rewarm_usd_1h, 20);
  assert.equal(e.read_fresh_ratio, 9);
  assert.equal(cacheEconomics('no-such-model', {}).rewarm_usd_5m, null); // unpriced → NULL, never 0
  assert.equal(billableTokens({ input_tokens: 100, output_tokens: 50, cache_read_tokens: 100000 }), 150);
  assert.equal(billableTokens({}), null);
});

test('budgets: verdict is indeterminate when unpriced calls sit in scope; burn binds only on the declared basis', () => {
  const rows = [
    { tool: 'claude_code', model: 'm', project: '/repo', user: 'u', cost_usd: 10, cost_basis: 'anthropic_list', total_tokens: 100, confidence: 'exact' },
    { tool: 'claude_code', model: 'm', project: '/other', user: 'u', cost_usd: 90, cost_basis: 'provider_reported', total_tokens: 100, confidence: 'exact' },
    { tool: 'claude_code', model: 'm', project: '/repo', user: 'u', cost_usd: null, cost_basis: null, total_tokens: 100, confidence: 'exact' },
  ];
  const clean: BudgetDeclaration = { scope: { project: '/repo' }, cost_basis: 'anthropic_list', limit_usd: 50 };
  const r = evaluateBudget(clean, rows, 0);
  assert.equal(r.spent_usd, 10); // the provider_reported $90 never enters an anthropic_list budget
  assert.equal(r.unpriced_calls, 1);
  assert.equal(r.verdict, 'indeterminate'); // refusing the percentage is the feature
  const noUnpriced = evaluateBudget(clean, rows.slice(0, 1), 0);
  assert.equal(noUnpriced.verdict, 'ok');
  assert.equal(evaluateBudget({ scope: {}, cost_basis: 'anthropic_list', limit_usd: 5 }, rows.slice(0, 1), 0).verdict, 'exceeded');
  const tok = evaluateBudget({ scope: {}, limit_tokens: 150 }, rows, 0);
  assert.equal(tok.spent_tokens, 300);
  assert.equal(tok.verdict, 'exceeded');
});

test('loadBudgets and unit declarations: malformed files are ignored, effective_from selects the rate', () => {
  const files = new Map<string, string>();
  const read = (p: string): string | null => files.get(p) ?? null;
  files.set('/bad.json', '{not json');
  files.set('/good.json', JSON.stringify([{ scope: { tool: 'claude_code' }, cost_basis: 'anthropic_list', limit_usd: 10 }]));
  const budgets = loadBudgets(read, ['/bad.json', '/good.json']);
  assert.equal(budgets.length, 1);
  assert.equal(budgets[0].cost_basis, 'anthropic_list');

  const decls = [
    { vendor: 'github_copilot', unit: 'AIC', usd_per_unit: null as number | null, effective_from: 0, author: 'admin' },
    { vendor: 'cursor', unit: 'requestsCosts', usd_per_unit: 0.004, effective_from: 100, author: 'admin' },
  ];
  assert.equal(usdPerUnit(decls, 'cursor', 'requestsCosts', 200), 0.004);
  assert.equal(usdPerUnit(decls, 'cursor', 'requestsCosts', 50), null); // not yet in force
  assert.equal(usdPerUnit(decls, 'github_copilot', 'AIC', 1e12), null); // declared NULL stays an em dash

  files.set('/units.json', JSON.stringify({ declarations: [{ vendor: 'cursor', unit: 'requestsCosts', usd_per_unit: 0.005, effective_from: 0 }] }));
  const loaded = loadUnitDeclarations(read, '/units.json');
  assert.equal(loaded.length, 1); // the builtin ships empty, by design
  assert.equal(usdPerUnit(loaded, 'cursor', 'requestsCosts', 1e12), 0.005);
});

test('the two rules round-trip through insertAnomalies idempotently', () => {
  const db = freshDb();
  insertEvents(db, [
    ev({ event_key: 'g1', ts: DAY(0), cost_usd: 10, total_tokens: 100 }),
    ev({ event_key: 'g2', ts: DAY(1), cost_usd: 10, total_tokens: 100 }),
  ]);
  db.prepare(
    `INSERT INTO vendor_ledger (vendor, period_start, period_end, vendor_cost_usd, currency, unit, rows, pulled_at, source)
     VALUES ('anthropic', ?, ?, 30, 'USD', 'USD', 1, 1, 'api:anthropic_cost_report'),
            ('anthropic', ?, ?, 30, 'USD', 'USD', 1, 1, 'api:anthropic_cost_report')`,
  ).run(DAY(0), DAY(0) + DAY_MS, DAY(1), DAY(1) + DAY_MS);
  const anomalies = detectReconcileGap(
    [gapCell(DAY(0), 30, 10), gapCell(DAY(1), 30, 10)],
    99,
  );
  const r1 = insertAnomalies(db, anomalies);
  assert.equal(r1.inserted.length, 1);
  const r2 = insertAnomalies(db, anomalies);
  assert.equal(r2.inserted.length, 0); // INSERT OR IGNORE on the deterministic key
});
