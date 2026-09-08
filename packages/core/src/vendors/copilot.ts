/**
 * Copilot adapter (tier 8 #32/#43) — the rate cards read from disk in the
 * vendor's own unit (AIC), plus the network leg (opt-in, default-off, dry-run
 * offline, routed exclusively through egress()).
 *
 * Prices are AICs per 1M tokens, NOT dollars: they are recorded with
 * unit='AIC' and usd_per_unit NULL (an em dash in the USD column), because
 * the AIC→USD rate is not on this machine and converting it would invent the
 * number this feature exists to refuse. models.json only exists once someone
 * has opened the Copilot debug log, so coverage is opportunistic and each
 * card carries observed_at (the file's own mtime) rather than pretending to
 * be current.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { editorRoots, type EditorRoot } from '../paths';
import { egress } from '../egress';
import { DAY_MS, type VendorLedgerRow } from './ledger';
import type { AdapterPlan, AdapterRun } from './anthropic';

export const GITHUB_HOST = 'api.github.com';
export const GITHUB_TOKEN_ENV = 'GITHUB_TOKEN';

// ── rate cards from disk ─────────────────────────────────────────────────────

export interface CopilotRateCard {
  model: string;
  /** The debug-log file the card came from, and its mtime as observed_at. */
  file: string;
  observed_at: number | null;
  tiers: {
    tier: 'default' | 'long_context';
    input_price: number | null;
    output_price: number | null;
    cache_price: number | null;
    cache_write_price: number | null;
    /** The vendor's declared context ceiling for this tier. */
    context_max: number | null;
  }[];
  restricted_to: string[];
  capabilities: { max_context_window_tokens: number | null; max_output_tokens: number | null; max_non_streaming_output_tokens: number | null };
}

interface ModelsJson {
  models?: Record<
    string,
    {
      billing?: {
        token_prices?: Record<
          string,
          { input_price?: number; output_price?: number; cache_price?: number; cache_write_price?: number; context_max?: number }
        >;
        restricted_to?: string[];
      };
      capabilities?: { limits?: { max_context_window_tokens?: number; max_output_tokens?: number; max_non_streaming_output_tokens?: number } };
    }
  >;
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** Every debug-logs/<sessionId>/models.json across all editor roots. */
export function copilotDebugLogDirs(roots: EditorRoot[] = editorRoots()): string[] {
  const out: string[] = [];
  for (const r of roots) {
    const gs = join(r.root, 'User', 'globalStorage', 'github.copilot-chat');
    const dl = join(gs, 'debug-logs');
    if (!existsSync(dl)) continue;
    try {
      for (const sid of readdirSync(dl)) {
        if (existsSync(join(dl, sid, 'models.json'))) out.push(join(dl, sid));
      }
    } catch {
      /* unreadable debug-log dir: no cards from it */
    }
  }
  return out;
}

/** The rate cards on disk, in the vendor's own unit. Never converted, never current-by-assertion. */
export function readCopilotRateCards(roots?: EditorRoot[]): CopilotRateCard[] {
  const out: CopilotRateCard[] = [];
  for (const dir of copilotDebugLogDirs(roots)) {
    const file = join(dir, 'models.json');
    let parsed: ModelsJson;
    let mtime: number | null;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as ModelsJson;
      mtime = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    for (const [model, m] of Object.entries(parsed.models ?? {})) {
      const prices = m.billing?.token_prices ?? {};
      const tiers: CopilotRateCard['tiers'] = (['default', 'long_context'] as const)
        .filter((t) => prices[t])
        .map((t) => ({
          tier: t,
          input_price: num(prices[t].input_price),
          output_price: num(prices[t].output_price),
          cache_price: num(prices[t].cache_price),
          cache_write_price: num(prices[t].cache_write_price),
          context_max: num(prices[t].context_max),
        }));
      if (!tiers.length) continue;
      out.push({
        model,
        file,
        observed_at: mtime,
        tiers,
        restricted_to: m.billing?.restricted_to ?? [],
        capabilities: {
          max_context_window_tokens: num(m.capabilities?.limits?.max_context_window_tokens),
          max_output_tokens: num(m.capabilities?.limits?.max_output_tokens),
          max_non_streaming_output_tokens: num(m.capabilities?.limits?.max_non_streaming_output_tokens),
        },
      });
    }
  }
  return out;
}

export interface SessionModelMetadata {
  session_id: string;
  model: string | null;
  /** The vendor's own pricing string, verbatim (e.g. 'In: 1000 · Out: 5000 AICs/1M tokens'). */
  pricing: string | null;
  input_cost: number | null;
  output_cost: number | null;
  price_category: string | null;
  max_input_tokens: number | null;
  file: string;
}

/**
 * The chat store's per-session copy: inputState.selectedModel.metadata from
 * chatSessions/*.jsonl. The pricing string is parsed for the AIC in/out rates;
 * anything absent stays NULL.
 */
export function readCopilotSessionMetadata(roots?: EditorRoot[]): SessionModelMetadata[] {
  const out: SessionModelMetadata[] = [];
  for (const r of roots ?? editorRoots()) {
    const gs = join(r.root, 'User', 'globalStorage', 'github.copilot-chat');
    for (const sub of ['chatSessions', 'sessions']) {
      const dir = join(gs, sub);
      if (!existsSync(dir)) continue;
      try {
        for (const f of readdirSync(dir)) {
          if (!f.endsWith('.jsonl')) continue;
          const file = join(dir, f);
          const text = readFileSync(file, 'utf8');
          if (!text.includes('selectedModel')) continue;
          for (const line of text.split('\n')) {
            if (!line.includes('inputState')) continue;
            try {
              const entry = JSON.parse(line) as {
                sessionId?: string;
                inputState?: { selectedModel?: { id?: string; metadata?: Record<string, unknown> } };
              };
              const md = entry.inputState?.selectedModel?.metadata;
              if (!md) continue;
              out.push({
                session_id: entry.sessionId ?? f,
                model: entry.inputState?.selectedModel?.id ?? null,
                pricing: typeof md.pricing === 'string' ? md.pricing : null,
                input_cost: num(md.inputCost),
                output_cost: num(md.outputCost),
                price_category: typeof md.priceCategory === 'string' ? md.priceCategory : null,
                max_input_tokens: num(md.maxInputTokens),
                file,
              });
            } catch {
              /* skip malformed lines */
            }
          }
        }
      } catch {
        /* unreadable dir */
      }
    }
  }
  return out;
}

/**
 * Lands the rate cards as billing_units rows: unit='AIC', usd_per_unit NULL —
 * the declaration that an em dash, not a conversion, prices them. The card's
 * numbers ride in `note` because the billing_units schema has no price-table
 * column (flagged for a foundation change); declaration_key is deterministic
 * (model + tier + observed_at bucket).
 */
export function insertCopilotRateCards(
  db: {
    prepare(sql: string): { run(...p: unknown[]): { changes: number } };
    transaction<R>(fn: () => R): () => R;
  },
  cards: CopilotRateCard[] = readCopilotRateCards(),
): number {
  if (!cards.length) return 0;
  const stmt = db.prepare(`
    INSERT INTO billing_units (declaration_key, vendor, unit, usd_per_unit, effective_from, note, author, first_seen)
    VALUES (?, ?, 'AIC', NULL, ?, ?, 'copilot_debug_log', ?)
    ON CONFLICT(declaration_key) DO UPDATE SET
      note = COALESCE(billing_units.note, excluded.note),
      effective_from = COALESCE(billing_units.effective_from, excluded.effective_from)`);
  const now = Date.now();
  return db.transaction(() => {
    let n = 0;
    for (const c of cards) {
      for (const t of c.tiers) {
        const key = `copilot_rate:${c.model}:${t.tier}:${Math.floor((c.observed_at ?? 0) / DAY_MS)}`;
        n += stmt.run(
          key,
          'github_copilot',
          c.observed_at,
          `${c.model} ${t.tier}: in ${t.input_price ?? '—'} / out ${t.output_price ?? '—'} AIC per 1M tokens` +
            (c.restricted_to.length ? ` (restricted_to: ${c.restricted_to.join(', ')})` : ''),
          now,
        ).changes;
      }
    }
    return n;
  })();
}

// ── the network leg: premium requests, never a token diff ───────────────────

export function copilotPlan(org: string, fromIso: string, toIso: string): AdapterPlan {
  return {
    vendor: 'github_copilot',
    envKey: GITHUB_TOKEN_ENV,
    requests: [
      {
        method: 'GET',
        url: `https://${GITHUB_HOST}/orgs/${org}/copilot/metrics?since=${fromIso}&until=${toIso}`,
        headers: { Authorization: 'Bearer <GITHUB_TOKEN>', Accept: 'application/vnd.github+json' },
      },
      {
        method: 'GET',
        url: `https://${GITHUB_HOST}/orgs/${org}/settings/billing/usage?year=${fromIso.slice(0, 4)}&month=${fromIso.slice(5, 7)}`,
        headers: { Authorization: 'Bearer <GITHUB_TOKEN>', Accept: 'application/vnd.github+json' },
      },
    ],
    notes: [
      'Vendor unit: premium requests. GitHub’s published multipliers change and are not fetched, so a stale units.json declaration silently mis-prices — the delta view renders counts, and the unit chip says “premium requests”.',
      'Local side: opencode rows with providerID github-copilot (activity per provider) — a count reconciliation, never a token diff.',
    ],
  };
}

export async function runCopilotAdapter(
  org: string,
  fromIso: string,
  toIso: string,
  opts: { confirmed: boolean },
): Promise<AdapterRun> {
  const plan = copilotPlan(org, fromIso, toIso);
  if (!opts.confirmed) {
    return { mode: 'refused', reason: 'not confirmed (--yes or reconcile.confirmed)', requests: [], ledgerRows: [], tokenCells: [] };
  }
  const key = process.env[GITHUB_TOKEN_ENV];
  const requests: AdapterRun['requests'] = [];
  const pulledAt = Date.now();
  const ledgerRows: VendorLedgerRow[] = [];
  for (const req of plan.requests) {
    const decision = egress({
      caller: 'reconcile:cli',
      destination: `${GITHUB_HOST}${req.url.replace(`https://${GITHUB_HOST}`, '')}`,
      purpose: 'github copilot metrics/billing pull (premium-request counts)',
      enabler: 'VOLE_RECONCILE',
    });
    if (!decision.allowed || !key) {
      requests.push({ url: req.url, status: null, bytes: null });
      continue;
    }
    const res = await fetch(req.url, { method: req.method, headers: { ...req.headers, Authorization: `Bearer ${key}` } });
    const text = await res.text();
    requests.push({ url: req.url, status: res.status, bytes: text.length });
    if (!res.ok) continue;
    if (req.url.includes('/copilot/metrics')) {
      try {
        const metrics = JSON.parse(text) as { day?: string; total_active_users?: number; copilot_ide_code_completions?: { total_engaged_users?: number } }[];
        for (const day of metrics) {
          if (!day.day) continue;
          const dayMs = Math.floor(Date.parse(day.day) / DAY_MS) * DAY_MS;
          if (!Number.isFinite(dayMs)) continue;
          ledgerRows.push({
            vendor: 'github_copilot',
            period_start: dayMs,
            period_end: dayMs + DAY_MS,
            // Counts only: premium requests are the vendor's unit, never a
            // dollar, so vendor_cost_usd stays NULL and the row counts.
            vendor_cost_usd: null,
            currency: null,
            unit: 'premium_requests',
            rows: day.copilot_ide_code_completions?.total_engaged_users ?? null,
            pulled_at: pulledAt,
            source: 'api:github_copilot_metrics',
          });
        }
      } catch {
        /* an unparseable metrics body contributes no rows */
      }
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
