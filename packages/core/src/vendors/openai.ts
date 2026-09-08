/**
 * OpenAI Admin API adapter (tier 8 #42) — opt-in, default-off, dry-run
 * offline, routed exclusively through egress().
 *
 * GET /v1/organization/usage/completions (start_time, end_time, bucket_width,
 * group_by[]) and GET /v1/organization/costs (1d buckets, USD).
 *
 * The ChatGPT-seat hole, named instead of filled: Codex CLI logged in with a
 * ChatGPT account — the default, and the most common deployment — produces
 * ZERO rows in /v1/organization/usage/completions, because that consumption
 * is seat-based and lives in ChatGPT admin, which has no public per-turn usage
 * API. For that auth_mode the adapter returns a documented cannot-compare
 * panel, not a number.
 */
import type { DB } from '../db';
import { egress } from '../egress';
import { DAY_MS, type VendorLedgerRow } from './ledger';
import type { AdapterPlan, AdapterRequest, AdapterRun } from './anthropic';

export const OPENAI_HOST = 'api.openai.com';
export const OPENAI_ADMIN_KEY_ENV = 'OPENAI_ADMIN_KEY';

export function openaiPlan(fromIso: string, toIso: string): AdapterPlan {
  return {
    vendor: 'openai',
    envKey: OPENAI_ADMIN_KEY_ENV,
    requests: [
      {
        method: 'GET',
        url: `https://${OPENAI_HOST}/v1/organization/usage/completions?start_time=${fromIso}&end_time=${toIso}&bucket_width=1d&group_by[]=model&group_by[]=api_key_id`,
        headers: { Authorization: 'Bearer <OPENAI_ADMIN_KEY>' },
      },
      {
        method: 'GET',
        url: `https://${OPENAI_HOST}/v1/organization/costs?start_time=${fromIso}&end_time=${toIso}&bucket_width=1d&group_by[]=line_item`,
        headers: { Authorization: 'Bearer <OPENAI_ADMIN_KEY>' },
      },
    ],
    notes: [
      'usage/completions returns input_tokens, output_tokens, input_cached_tokens and num_model_requests per bucket.',
      'Columns written on success: vendor_ledger (vendor, period_start, period_end, vendor_cost_usd, unit, rows, pulled_at, source).',
    ],
  };
}

export interface CodexAuthMode {
  auth_mode: 'chatgpt' | 'api_key' | 'unknown';
  comparable: boolean;
  /** The panel text the OpenAI tab renders under auth_mode 'chatgpt'. */
  panel: string;
}

/**
 * auth_mode-aware comparability, read from vendor_identities (landed by
 * identity/accounts.ts): auth_path 'oauth' is the ChatGPT login, 'api_key' is
 * a Console key. The vendor_id row is written from ~/.codex/auth.json shape —
 * names only, never tokens.
 */
export function codexAuthMode(db: DB): CodexAuthMode {
  const row = db
    .prepare(`SELECT auth_path FROM vendor_identities WHERE vendor = 'openai' AND local_key_kind = 'auth_mode' ORDER BY last_seen DESC LIMIT 1`)
    .get() as { auth_path: string | null } | undefined;
  if (row?.auth_path === 'oauth') {
    return {
      auth_mode: 'chatgpt',
      comparable: false,
      panel:
        'This machine’s Codex sessions bill against a ChatGPT team seat. That consumption is seat-based and lives in ChatGPT admin, which has no public per-turn usage API — the answer is a documented cannot-compare, not a number.',
    };
  }
  if (row?.auth_path === 'api_key') {
    return { auth_mode: 'api_key', comparable: true, panel: 'API-key sessions: usage/completions rows are comparable token-for-token.' };
  }
  return {
    auth_mode: 'unknown',
    comparable: false,
    panel: 'No Codex auth shape on disk (run collect first); comparability unknown.',
  };
}

interface CostsResponse {
  data?: { start_time?: string; end_time?: string; results?: { amount?: number; currency?: string }[] }[];
}

export async function runOpenAIAdapter(
  db: DB,
  fromIso: string,
  toIso: string,
  opts: { confirmed: boolean },
): Promise<AdapterRun> {
  const auth = codexAuthMode(db);
  const plan = openaiPlan(fromIso, toIso);
  if (!auth.comparable) {
    return { mode: 'degraded', reason: auth.panel, requests: [], ledgerRows: [], tokenCells: [] };
  }
  if (!opts.confirmed) {
    return { mode: 'refused', reason: 'not confirmed (--yes or reconcile.confirmed)', requests: [], ledgerRows: [], tokenCells: [] };
  }
  const key = process.env[OPENAI_ADMIN_KEY_ENV];
  const requests: AdapterRun['requests'] = [];
  let ledgerRows: VendorLedgerRow[] = [];
  const pulledAt = Date.now();
  for (const req of plan.requests) {
    const decision = egress({
      caller: 'reconcile:cli',
      destination: `${OPENAI_HOST}${req.url.replace(`https://${OPENAI_HOST}`, '')}`,
      purpose: 'openai admin usage/cost pull',
      enabler: 'VOLE_RECONCILE',
    });
    if (!decision.allowed || !key) {
      requests.push({ url: req.url, status: null, bytes: null });
      continue;
    }
    const res = await fetch(req.url, { method: req.method, headers: { Authorization: `Bearer ${key}` } });
    const text = await res.text();
    requests.push({ url: req.url, status: res.status, bytes: text.length });
    if (!res.ok || !req.url.includes('/costs')) continue;
    const parsed = JSON.parse(text) as CostsResponse;
    for (const bucket of parsed.data ?? []) {
      const dayStart = bucket.start_time ? Date.parse(bucket.start_time) : NaN;
      if (!Number.isFinite(dayStart)) continue;
      const day = Math.floor(dayStart / DAY_MS) * DAY_MS;
      const amount = (bucket.results ?? []).reduce((s, r) => s + (r.amount ?? 0), 0);
      ledgerRows.push({
        vendor: 'openai',
        period_start: day,
        period_end: day + DAY_MS,
        vendor_cost_usd: amount,
        currency: 'USD',
        unit: 'USD',
        rows: bucket.results?.length ?? null,
        pulled_at: pulledAt,
        source: 'api:openai_costs',
      });
    }
  }
  const anyCalled = requests.some((r) => r.status != null);
  return {
    mode: anyCalled ? 'executed' : 'dry-run',
    reason: anyCalled ? undefined : 'VOLE_RECONCILE is not "1" (or VOLE_NO_EGRESS is set): the adapter runs offline by design',
    requests,
    ledgerRows,
    tokenCells: [],
  };
}

// Re-exported so the reconcile CLI can treat adapters uniformly.
export type { AdapterRequest };
