/**
 * Cursor adapter (tier 8 #43) — opt-in, default-off, dry-run offline, routed
 * exclusively through egress().
 *
 * The honest output here is a COUNT, never a cost diff: Cursor's Admin API
 * (POST /teams/filtered-usage-events, HTTP Basic with the team API key as
 * username and empty password; /teams/spend and /teams/members for the
 * email↔userId map) bills in requestsCosts and totalCents, while Vole's
 * Cursor collector is activity_only — so the join is
 * requestId-count-per-day-and-model versus vendor event-count, and the tokens
 * column carries a permanent 'vendor only' chip.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../sqlite';
import { paths } from '../paths';
import { egress } from '../egress';
import { DAY_MS, type VendorLedgerRow } from './ledger';
import type { AdapterPlan, AdapterRun } from './anthropic';

export const CURSOR_HOST = 'api.cursor.com';
export const CURSOR_API_KEY_ENV = 'CURSOR_API_KEY';

export function cursorPlan(fromIso: string, toIso: string): AdapterPlan {
  return {
    vendor: 'cursor',
    envKey: CURSOR_API_KEY_ENV,
    requests: [
      {
        method: 'POST',
        url: `https://${CURSOR_HOST}/teams/filtered-usage-events`,
        headers: { Authorization: 'Basic <CURSOR_API_KEY:>' },
        body: { startDate: fromIso, endDate: toIso },
      },
      {
        method: 'GET',
        url: `https://${CURSOR_HOST}/teams/spend?startDate=${fromIso}&endDate=${toIso}`,
        headers: { Authorization: 'Basic <CURSOR_API_KEY:>' },
      },
      {
        method: 'GET',
        url: `https://${CURSOR_HOST}/teams/members`,
        headers: { Authorization: 'Basic <CURSOR_API_KEY:>' },
      },
    ],
    notes: [
      'Per-event fields: timestamp, model, kindLabel, maxMode, isTokenBasedCall, requestsCosts, tokenUsage.{inputTokens,outputTokens,cacheWriteTokens,cacheReadTokens,totalCents}.',
      'Units can never match: Vole’s Cursor rows are activity_only, so this is a call-count reconciliation — two count columns per day and model, with a permanent “tokens: vendor only” chip.',
      'Cursor’s Admin API is Enterprise-tier only; a team without it gets the plan and nothing else.',
    ],
  };
}

export interface CursorLocalCounts {
  day: number;
  model: string | null;
  ai_code_hashes: number;
}

/**
 * The local side of the count reconciliation: ai_code_hashes from Cursor's
 * own tracking db. ai_code_hashes records ACCEPTED AI code rather than every
 * model call, so these counts are a systematic LOWER BOUND the view must state
 * rather than call a gap. Returns [] when the db is absent or unreadable.
 */
export function readCursorAiTracking(dbPath = paths.cursorTrackingDb()): CursorLocalCounts[] {
  if (!existsSync(dbPath)) return [];
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return [];
  }
  try {
    const rows = db
      .prepare(
        `SELECT CAST(timestamp / 1000 / 86400 AS INT) * 86400000 AS day, model, COUNT(*) AS n
         FROM ai_code_hashes GROUP BY day, model`,
      )
      .all() as { day: number; model: string | null; n: number }[];
    return rows.map((r) => ({ day: r.day, model: r.model, ai_code_hashes: r.n }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

interface UsageEventsResponse {
  events?: { timestamp?: number | string; model?: string }[];
}

export async function runCursorAdapter(
  fromIso: string,
  toIso: string,
  opts: { confirmed: boolean },
): Promise<AdapterRun & { vendor_counts: { day: number; model: string | null; events: number }[] }> {
  const plan = cursorPlan(fromIso, toIso);
  const vendor_counts: { day: number; model: string | null; events: number }[] = [];
  if (!opts.confirmed) {
    return { mode: 'refused', reason: 'not confirmed (--yes or reconcile.confirmed)', requests: [], ledgerRows: [], tokenCells: [], vendor_counts };
  }
  const key = process.env[CURSOR_API_KEY_ENV];
  const requests: AdapterRun['requests'] = [];
  const pulledAt = Date.now();
  const ledgerRows: VendorLedgerRow[] = [];
  for (const req of plan.requests) {
    const decision = egress({
      caller: 'reconcile:cli',
      destination: `${CURSOR_HOST}${req.url.replace(`https://${CURSOR_HOST}`, '')}`,
      purpose: 'cursor team usage pull (call-count reconciliation)',
      enabler: 'VOLE_RECONCILE',
    });
    if (!decision.allowed || !key) {
      requests.push({ url: req.url, status: null, bytes: null });
      continue;
    }
    const auth = Buffer.from(`${key}:`).toString('base64');
    const res = await fetch(req.url, {
      method: req.method,
      headers: { Authorization: `Basic ${auth}`, 'content-type': 'application/json' },
      body: req.body ? JSON.stringify(req.body) : undefined,
    });
    const text = await res.text();
    requests.push({ url: req.url, status: res.status, bytes: text.length });
    if (!res.ok || !req.url.includes('filtered-usage-events')) continue;
    const parsed = JSON.parse(text) as UsageEventsResponse;
    const perDayModel = new Map<string, number>();
    for (const e of parsed.events ?? []) {
      const ts = typeof e.timestamp === 'number' ? e.timestamp : Date.parse(String(e.timestamp));
      if (!Number.isFinite(ts)) continue;
      const day = Math.floor(ts / DAY_MS) * DAY_MS;
      const k = `${day}|${e.model ?? ''}`;
      perDayModel.set(k, (perDayModel.get(k) ?? 0) + 1);
    }
    for (const [k, n] of perDayModel) {
      const [day, model] = k.split('|');
      vendor_counts.push({ day: Number(day), model: model || null, events: n });
      ledgerRows.push({
        vendor: 'cursor',
        period_start: Number(day),
        period_end: Number(day) + DAY_MS,
        // Cursor bills requestsCosts/totalCents — a unit Vole must not convert,
        // so the ledger row carries the COUNT with unit 'events'.
        vendor_cost_usd: null,
        currency: null,
        unit: 'events',
        rows: n,
        pulled_at: pulledAt,
        source: 'api:cursor_usage_events',
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
    vendor_counts,
  };
}
