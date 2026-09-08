/**
 * Anthropic Admin API adapter (tier 8 #41) — opt-in, default-off, dry-run
 * offline, routed exclusively through egress().
 *
 * Three GETs against https://api.anthropic.com with an Admin key only an org
 * owner can mint: /v1/organizations/usage_report/messages,
 * /usage_report/claude_code and /cost_report. The usage endpoints return the
 * SAME five token classes usage_events already stores, which is why this diff
 * is arithmetic rather than estimation.
 *
 * The Admin API exists only for Console API organisations. A subscription
 * account (claude_max / stripe_subscription — the common case on a personal
 * laptop) gets nothing from these endpoints, and the adapter says so instead
 * of calling: the Anthropic leg degrades to the local vendor_ledger.
 */
import type { DB } from '../db';
import { egress } from '../egress';
import { DAY_MS, type VendorLedgerRow } from './ledger';

export const ANTHROPIC_HOST = 'api.anthropic.com';
export const ANTHROPIC_ADMIN_KEY_ENV = 'ANTHROPIC_ADMIN_KEY';

export interface AdapterRequest {
  method: 'GET' | 'POST';
  url: string;
  /** Header NAMES and constant values only — a key value never appears in a plan. */
  headers: Record<string, string>;
  body?: unknown;
}

export interface AdapterPlan {
  vendor: string;
  envKey: string;
  requests: AdapterRequest[];
  notes: string[];
}

/** The three endpoints the pull would call, with the exact query parameters. */
export function anthropicPlan(fromIso: string, toIso: string): AdapterPlan {
  const q = (extra: string[]): string =>
    `starting_at=${fromIso}&ending_at=${toIso}&bucket_width=1d` + extra.map((e) => `&${e}`).join('');
  return {
    vendor: 'anthropic',
    envKey: ANTHROPIC_ADMIN_KEY_ENV,
    requests: [
      {
        method: 'GET',
        url: `https://${ANTHROPIC_HOST}/v1/organizations/usage_report/messages?${q(['group_by[]=model', 'group_by[]=api_key_id'])}`,
        headers: { 'x-api-key': '<ANTHROPIC_ADMIN_KEY>', 'anthropic-version': '2023-06-01' },
      },
      {
        method: 'GET',
        url: `https://${ANTHROPIC_HOST}/v1/organizations/usage_report/claude_code?${q(['group_by[]=model', 'group_by[]=workspace_id'])}`,
        headers: { 'x-api-key': '<ANTHROPIC_ADMIN_KEY>', 'anthropic-version': '2023-06-01' },
      },
      {
        method: 'GET',
        url: `https://${ANTHROPIC_HOST}/v1/organizations/cost_report?starting_at=${fromIso}&ending_at=${toIso}`,
        headers: { 'x-api-key': '<ANTHROPIC_ADMIN_KEY>', 'anthropic-version': '2023-06-01' },
      },
    ],
    notes: [
      'Scoped to this identity: the organizationUuid from ~/.claude.json oauthAccount (opaque ids only — emailAddress/fullName in the same object are never read).',
      'Columns written on success: vendor_ledger (vendor, period_start, period_end, vendor_cost_usd, unit, rows, pulled_at, source).',
      'The usage_report endpoints return the same five token classes usage_events stores (uncached_input, ephemeral_5m, ephemeral_1h, cache_read, output) plus server_tool_use.web_search_requests — the diff is arithmetic, not estimation.',
    ],
  };
}

export interface AnthropicAdaptability {
  admin_api_applies: boolean;
  reason: string;
}

/**
 * The subscription gate. vendor_identities holds the plan bits
 * (organizationType/billingType) — a subscription reads admin_api_applies
 * false and the whole leg degrades to the local-cache vendor_ledger.
 */
export function anthropicAdaptability(db: DB): AnthropicAdaptability {
  const row = db
    .prepare(`SELECT plan FROM vendor_identities WHERE vendor = 'anthropic' ORDER BY last_seen DESC LIMIT 1`)
    .get() as { plan: string | null } | undefined;
  const plan = row?.plan ?? null;
  if (!plan) {
    return { admin_api_applies: false, reason: 'no Anthropic vendor identity on disk (run collect first)' };
  }
  if (/subscription|claude_max|stripe/i.test(plan)) {
    return {
      admin_api_applies: false,
      reason: `this account is a subscription (${plan}) — the Admin API exists only for Console API organisations; the Anthropic leg degrades to the local vendor_ledger`,
    };
  }
  return { admin_api_applies: true, reason: `Console-style account (${plan})` };
}

export interface AdapterRun {
  mode: 'dry-run' | 'executed' | 'degraded' | 'refused';
  reason?: string;
  requests: { url: string; status: number | null; bytes: number | null }[];
  ledgerRows: VendorLedgerRow[];
  /** Token-direction gap cells (vendor, day, model) — the ledger has no token-value column; these feed reconcile_gap directly and reconcile.json's last_run. */
  tokenCells: { day: number; model: string | null; uncached_input_tokens: number; cache_creation_5m: number; cache_creation_1h: number; cache_read: number; output_tokens: number }[];
}

interface UsageReportResponse {
  data?: {
    window_start?: string;
    window_end?: string;
    results?: {
      model?: string;
      input_tokens?: number;
      output_tokens?: number;
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
      cache_read_input_tokens?: number;
    }[];
  }[];
}

interface CostReportResponse {
  data?: { date?: string; amount?: number; currency?: string }[];
}

function parseUsageReport(json: unknown): AdapterRun['tokenCells'] {
  const resp = json as UsageReportResponse;
  const out: AdapterRun['tokenCells'] = [];
  for (const group of resp.data ?? []) {
    const dayStart = group.window_start ? Date.parse(group.window_start) : null;
    for (const r of group.results ?? []) {
      out.push({
        day: dayStart != null && Number.isFinite(dayStart) ? Math.floor(dayStart / DAY_MS) * DAY_MS : 0,
        model: r.model ?? null,
        uncached_input_tokens: r.input_tokens ?? 0,
        cache_creation_5m: r.cache_creation?.ephemeral_5m_input_tokens ?? 0,
        cache_creation_1h: r.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        cache_read: r.cache_read_input_tokens ?? 0,
        output_tokens: r.output_tokens ?? 0,
      });
    }
  }
  return out;
}

function parseCostReport(json: unknown, pulledAt: number): VendorLedgerRow[] {
  const resp = json as CostReportResponse;
  const rows: VendorLedgerRow[] = [];
  for (const d of resp.data ?? []) {
    if (!d.date) continue;
    const day = Math.floor(Date.parse(`${d.date}T00:00:00Z`) / DAY_MS) * DAY_MS;
    if (!Number.isFinite(day)) continue;
    rows.push({
      vendor: 'anthropic',
      period_start: day,
      period_end: day + DAY_MS,
      vendor_cost_usd: typeof d.amount === 'number' ? d.amount : null,
      currency: d.currency ?? 'USD',
      unit: 'USD',
      rows: 1,
      pulled_at: pulledAt,
      source: 'api:anthropic_cost_report',
    });
  }
  return rows;
}

/**
 * Runs the pull. Every request routes through egress() with the VOLE_RECONCILE
 * enabler: unless that flag is exactly '1' (and VOLE_NO_EGRESS is unset), the
 * adapter completes OFFLINE — the plan is the output. A degraded
 * (subscription) account is never called at all.
 */
export async function runAnthropicAdapter(
  db: DB,
  fromIso: string,
  toIso: string,
  opts: { confirmed: boolean },
): Promise<AdapterRun> {
  const adapt = anthropicAdaptability(db);
  const plan = anthropicPlan(fromIso, toIso);
  if (!adapt.admin_api_applies) {
    return { mode: 'degraded', reason: adapt.reason, requests: [], ledgerRows: [], tokenCells: [] };
  }
  if (!opts.confirmed) {
    return { mode: 'refused', reason: 'not confirmed (--yes or reconcile.confirmed)', requests: [], ledgerRows: [], tokenCells: [] };
  }
  const key = process.env[ANTHROPIC_ADMIN_KEY_ENV];
  const requests: AdapterRun['requests'] = [];
  let tokenCells: AdapterRun['tokenCells'] = [];
  let ledgerRows: VendorLedgerRow[] = [];
  const pulledAt = Date.now();
  for (const req of plan.requests) {
    const decision = egress({
      caller: 'reconcile:cli',
      destination: `${ANTHROPIC_HOST}${req.url.replace(`https://${ANTHROPIC_HOST}`, '')}`,
      purpose: `anthropic admin ${req.url.includes('cost_report') ? 'cost report' : 'usage report'} pull`,
      enabler: 'VOLE_RECONCILE',
    });
    if (!decision.allowed) {
      requests.push({ url: req.url, status: null, bytes: null });
      continue;
    }
    if (!key) {
      requests.push({ url: req.url, status: null, bytes: null });
      continue;
    }
    const res = await fetch(req.url, {
      method: req.method,
      headers: { ...req.headers, 'x-api-key': key },
    });
    const text = await res.text();
    requests.push({ url: req.url, status: res.status, bytes: text.length });
    if (!res.ok) continue;
    if (req.url.includes('cost_report')) ledgerRows = parseCostReport(JSON.parse(text), pulledAt);
    else tokenCells = tokenCells.concat(parseUsageReport(JSON.parse(text)));
  }
  const anyCalled = requests.some((r) => r.status != null);
  return {
    mode: anyCalled ? 'executed' : 'dry-run',
    reason: anyCalled ? undefined : 'VOLE_RECONCILE is not "1" (or VOLE_NO_EGRESS is set): the adapter runs offline by design',
    requests,
    ledgerRows,
    tokenCells,
  };
}
