/**
 * The vendor cost plane's disk leg (tier 8 #37/#17/#22/#38/#35): the vendor's
 * own billing figures, read from local files with ZERO network.
 *
 * Principle 1 applies to the vendor's numbers exactly as it applies to Vole's:
 * a session that ended uncleanly has no cost-state line at all, so its vendor
 * figure is NULL — never zero — and a vendor figure with
 * `hasUnknownModelCost: true` is itself incomplete, so the ledger row records
 * that fact in `source` (the schema has no flag column; flagged as a
 * foundation change if a query ever needs to select it) and is never treated
 * as ground truth.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db';
import { paths } from '../paths';
import { hmacIdentity } from '../identity/accounts';
import { insertQuotaObservations, type QuotaRow } from '../collectors/ledger';
import type { Anomaly, Tool } from '../types';

export const DAY_MS = 86_400_000;

/** UTC day bucket of an epoch-ms timestamp (bucket epochs are contract-safe keys). */
export function utcDay(ts: number): number {
  return Math.floor(ts / DAY_MS) * DAY_MS;
}

// ── cost-state: the vendor's own per-session figure (tier 8 #37) ──────────────

export interface VendorSessionFigure {
  /** The session the figure belongs to — the drill-down join key. */
  session_id: string | null;
  file: string;
  /** Session-end timestamp of the cost-state line, verbatim. */
  ts: number | null;
  totalCostUSD: number | null;
  hasUnknownModelCost: boolean;
  /** Per-model breakdown the vendor itself printed, verbatim. */
  modelUsage: { model: string; costUSD: number | null; inputTokens: number | null; outputTokens: number | null }[];
}

interface CostStateLine {
  type?: string;
  timestamp?: string;
  /** Present on cost-state lines instead of timestamp: the session's own start, epoch ms. */
  startTime?: number;
  sessionId?: string;
  totalCostUSD?: number;
  hasUnknownModelCost?: boolean;
  modelUsage?: Record<
    string,
    { costUSD?: number; inputTokens?: number; outputTokens?: number }
  >;
}

function walkJsonl(root: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
}

/**
 * Reads the LAST `type:'cost-state'` line per transcript. cost-state is
 * written at session end and is cumulative within a session, so the last line
 * is the session's final figure; mid-session copies would double-count.
 * Substring pre-checks keep the walk cheap over big transcripts.
 */
export function readClaudeCostStates(
  projectRoots: string[] = paths.claudeCodeProjectRoots(),
): VendorSessionFigure[] {
  const files: string[] = [];
  for (const root of projectRoots) {
    if (existsSync(root)) walkJsonl(root, files);
  }
  const out: VendorSessionFigure[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue; // an unreadable transcript contributes no vendor figure, never zero
    }
    if (!text.includes('"cost-state"')) continue;
    let last: CostStateLine | null = null;
    for (const line of text.split('\n')) {
      if (!line.includes('"cost-state"')) continue;
      try {
        const parsed = JSON.parse(line) as CostStateLine;
        if (parsed.type === 'cost-state') last = parsed;
      } catch {
        /* a malformed line is skipped, not guessed */
      }
    }
    if (!last) continue;
    out.push({
      session_id: last.sessionId ?? null,
      file,
      // Verified on real transcripts: cost-state carries startTime (the
      // session's own epoch-ms start), not a per-line timestamp.
      ts: last.timestamp
        ? Date.parse(last.timestamp) || null
        : typeof last.startTime === 'number'
          ? last.startTime
          : null,
      totalCostUSD: typeof last.totalCostUSD === 'number' ? last.totalCostUSD : null,
      hasUnknownModelCost: last.hasUnknownModelCost === true,
      modelUsage: Object.entries(last.modelUsage ?? {}).map(([model, m]) => ({
        model,
        costUSD: typeof m.costUSD === 'number' ? m.costUSD : null,
        inputTokens: typeof m.inputTokens === 'number' ? m.inputTokens : null,
        outputTokens: typeof m.outputTokens === 'number' ? m.outputTokens : null,
      })),
    });
  }
  return out;
}

/** ~/.claude.json projects[].lastCost — the vendor's own per-project figure, verbatim. */
export interface ProjectLastCost {
  cwd: string;
  lastCost: number | null;
  lastTotalInputTokens: number | null;
  lastTotalOutputTokens: number | null;
  lastTotalCacheReadInputTokens: number | null;
  lastTotalCacheCreationInputTokens: number | null;
}

export function readClaudeProjectLastCost(claudeJson?: string): ProjectLastCost[] {
  const path = claudeJson ?? join(paths.claudeConfigDir(), '..', '.claude.json');
  if (!existsSync(path)) return [];
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as {
      projects?: Record<string, Record<string, unknown>>;
    };
    return Object.entries(cfg.projects ?? {}).flatMap(([cwd, p]) => [
      {
        cwd,
        lastCost: typeof p.lastCost === 'number' ? p.lastCost : null,
        lastTotalInputTokens: typeof p.lastTotalInputTokens === 'number' ? p.lastTotalInputTokens : null,
        lastTotalOutputTokens: typeof p.lastTotalOutputTokens === 'number' ? p.lastTotalOutputTokens : null,
        lastTotalCacheReadInputTokens:
          typeof p.lastTotalCacheReadInputTokens === 'number' ? p.lastTotalCacheReadInputTokens : null,
        lastTotalCacheCreationInputTokens:
          typeof p.lastTotalCacheCreationInputTokens === 'number' ? p.lastTotalCacheCreationInputTokens : null,
      },
    ]);
  } catch {
    return [];
  }
}

// ── vendor_ledger upsert ──────────────────────────────────────────────────────

export interface VendorLedgerRow {
  vendor: string;
  period_start: number;
  period_end: number;
  vendor_cost_usd: number | null;
  currency: string | null;
  unit: string | null;
  rows: number | null;
  pulled_at: number | null;
  source: string | null;
}

const UPSERT_LEDGER = `
INSERT INTO vendor_ledger (vendor, period_start, period_end, vendor_cost_usd, currency, unit, rows, pulled_at, source)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(vendor, period_start, period_end) DO UPDATE SET
  vendor_cost_usd = COALESCE(excluded.vendor_cost_usd, vendor_ledger.vendor_cost_usd),
  currency        = COALESCE(excluded.currency, vendor_ledger.currency),
  unit            = COALESCE(excluded.unit, vendor_ledger.unit),
  rows            = COALESCE(excluded.rows, vendor_ledger.rows),
  pulled_at       = excluded.pulled_at,
  source          = COALESCE(excluded.source, vendor_ledger.source)`;

/** Idempotent upsert on the table's own UNIQUE(vendor, period_start, period_end). NULL never overwrites a stored figure. */
export function insertVendorLedger(db: DB, rows: VendorLedgerRow[]): number {
  if (!rows.length) return 0;
  const stmt = db.prepare(UPSERT_LEDGER);
  return db.transaction(() => {
    let n = 0;
    for (const r of rows) {
      n += stmt.run(
        r.vendor, r.period_start, r.period_end, r.vendor_cost_usd, r.currency, r.unit, r.rows, r.pulled_at, r.source,
      ).changes;
    }
    return n;
  })();
}

/**
 * Syncs the disk leg: per-session cost-state figures aggregated to UTC-day
 * vendor_ledger rows (vendor='anthropic', unit='USD'). `source` carries the
 * incomplete-figure fact: 'claude_cost_state' vs 'claude_cost_state_incomplete'
 * when any contributing session set hasUnknownModelCost.
 */
export function syncVendorLedgerFromDisk(db: DB, roots?: string[]): { rows: number; sessions: number } {
  const figures = readClaudeCostStates(roots);
  const byDay = new Map<number, { usd: number; sessions: number; incomplete: boolean }>();
  for (const f of figures) {
    if (f.ts == null) continue;
    const day = utcDay(f.ts);
    const b = byDay.get(day) ?? { usd: 0, sessions: 0, incomplete: false };
    // totalCostUSD null = the vendor never wrote a figure for this session: it
    // contributes nothing, and must not masquerade as a zero.
    if (f.totalCostUSD != null) b.usd += f.totalCostUSD;
    b.sessions += 1;
    if (f.hasUnknownModelCost) b.incomplete = true;
    byDay.set(day, b);
  }
  const now = Date.now();
  const rows: VendorLedgerRow[] = [...byDay].map(([day, b]) => ({
    vendor: 'anthropic',
    period_start: day,
    period_end: day + DAY_MS,
    vendor_cost_usd: b.sessions > 0 ? b.usd : null,
    currency: 'USD',
    unit: 'USD',
    rows: b.sessions,
    pulled_at: now,
    source: b.incomplete ? 'claude_cost_state_incomplete' : 'claude_cost_state',
  }));
  return { rows: insertVendorLedger(db, rows), sessions: figures.length };
}

// ── vendor_identities: the bridge-session owners (tier 8 #17) ────────────────

interface BridgeSessionLine {
  type?: string;
  sessionId?: string;
  ownerAccountUuid?: string;
  ownerOrganizationUuid?: string;
}

/**
 * Fills the half of vendor_identities the oauthAccount census cannot: the
 * `type:'bridge-session'` owner ids found in transcripts. HMACs only — never
 * the raw accountUuid, which is a join key and not a privacy control, the
 * pseudonymity is not storing the value at all. The oauthAccount rows are
 * already landed by identity/accounts.ts; this adds the bridge rows.
 */
export function upsertBridgeVendorIdentities(db: DB, roots?: string[], now = Date.now()): number {
  const files: string[] = [];
  for (const root of roots ?? paths.claudeCodeProjectRoots()) {
    if (existsSync(root)) walkJsonl(root, files);
  }
  const upsert = db.prepare(`
    INSERT INTO vendor_identities (vendor, local_key_kind, local_key, vendor_id_kind, vendor_id_hmac, plan, org_id_hmac, auth_path, evidence_artifact, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vendor, local_key_kind, local_key) DO UPDATE SET
      last_seen = excluded.last_seen,
      vendor_id_hmac = COALESCE(vendor_identities.vendor_id_hmac, excluded.vendor_id_hmac),
      org_id_hmac    = COALESCE(vendor_identities.org_id_hmac, excluded.org_id_hmac),
      evidence_artifact = COALESCE(vendor_identities.evidence_artifact, excluded.evidence_artifact)`);
  let n = 0;
  db.transaction(() => {
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!text.includes('"bridge-session"')) continue;
      for (const line of text.split('\n')) {
        if (!line.includes('"bridge-session"')) continue;
        try {
          const parsed = JSON.parse(line) as BridgeSessionLine;
          if (parsed.type !== 'bridge-session' || !parsed.sessionId) continue;
          n += upsert.run(
            'anthropic',
            'bridge_session',
            parsed.sessionId,
            'ownerAccountUuid',
            parsed.ownerAccountUuid ? hmacIdentity(parsed.ownerAccountUuid) : null,
            null,
            parsed.ownerOrganizationUuid ? hmacIdentity(parsed.ownerOrganizationUuid) : null,
            'bridge-session',
            file,
            now,
            now,
          ).changes;
        } catch {
          /* skip malformed lines */
        }
      }
    }
  })();
  return n;
}

// ── quota ledger: the real cachedUsageUtilization shape (tier 8 #22) ──────────

export interface QuotaSnapshot {
  fetchedAtMs: number | null;
  /** Top-level utilization percentages, when present ({five_hour, seven_day}). */
  utilization: { five_hour: number | null; seven_day: number | null };
  /** The real limits[] array: one row per scope the vendor meters. */
  limits: {
    kind: string;
    used_percent: number | null;
    resets_at: number | null;
    is_active: boolean | null;
    model_display_name: string | null;
    dollars: number | null;
  }[];
  /** spend.used.amount_minor, verbatim minor units — never converted here. */
  spend_minor: number | null;
  extra_usage_enabled: boolean | null;
  stale: boolean | null;
}

/**
 * Parses ~/.claude.json `cachedUsageUtilization`. The snapshot refreshes only
 * while Claude Code runs, so `stale` is reported (fetchedAtMs age) rather than
 * the reading being trusted. The percent covers the WHOLE account across every
 * surface (web, Cowork, other machines) — an upper bound on what this
 * endpoint's share explains, which the headroom line must say.
 */
export function readQuotaSnapshot(claudeJson?: string): QuotaSnapshot | null {
  const path = claudeJson ?? join(paths.claudeConfigDir(), '..', '.claude.json');
  if (!existsSync(path)) return null;
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const c = cfg.cachedUsageUtilization as Record<string, unknown> | undefined;
    if (!c || typeof c !== 'object') return null;
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    const util = (c.utilization ?? {}) as Record<string, Record<string, unknown>>;
    const limits = Array.isArray(c.limits) ? c.limits : [];
    const snapshot: QuotaSnapshot = {
      fetchedAtMs: num(c.fetchedAtMs),
      utilization: {
        five_hour: num((util.five_hour as Record<string, unknown> | undefined)?.utilization),
        seven_day: num((util.seven_day as Record<string, unknown> | undefined)?.utilization),
      },
      limits: limits.map((raw) => {
        const l = raw as Record<string, unknown>;
        const scope = l.scope as Record<string, unknown> | undefined;
        const kind =
          typeof l.kind === 'string'
            ? l.kind
            : typeof scope?.type === 'string'
              ? String(scope.type)
              : typeof l.name === 'string'
                ? String(l.name)
                : 'unknown';
        const resets =
          typeof l.resets_at === 'string'
            ? Date.parse(l.resets_at) || null
            : typeof l.reset_at === 'string'
              ? Date.parse(l.reset_at) || null
              : num(l.resets_at);
        return {
          kind,
          used_percent: num(l.percent ?? l.utilization),
          resets_at: resets,
          is_active: typeof l.is_active === 'boolean' ? l.is_active : null,
          model_display_name:
            typeof (scope?.model as Record<string, unknown> | undefined)?.display_name === 'string'
              ? String((scope as { model?: { display_name?: unknown } }).model?.display_name)
              : null,
          dollars: num(l.session_dollars ?? l.weekly_dollars ?? l.dollars),
        };
      }),
      spend_minor: num(((c.spend as { used?: { amount_minor?: unknown } } | undefined)?.used)?.amount_minor),
      extra_usage_enabled:
        typeof (c.extra_usage as { is_enabled?: unknown } | undefined)?.is_enabled === 'boolean'
          ? ((c.extra_usage as { is_enabled: boolean }).is_enabled)
          : null,
      stale: null,
    };
    if (snapshot.fetchedAtMs != null) snapshot.stale = Date.now() - snapshot.fetchedAtMs > 3 * 3600_000;
    return snapshot;
  } catch {
    return null;
  }
}

/** The snapshot as ledger rows, keyed on the vendor's own fetchedAtMs (idempotent re-reads). */
export function quotaRows(snapshot: QuotaSnapshot, tool = 'claude_code'): QuotaRow[] {
  const ts = snapshot.fetchedAtMs;
  if (ts == null) return [];
  const rows: QuotaRow[] = snapshot.limits.map((l) => ({
    tool,
    session_id: null,
    ts,
    kind: l.kind,
    used_percent: l.used_percent,
    limit_value: l.dollars,
    reset_at: l.resets_at,
  }));
  if (snapshot.utilization.seven_day != null) {
    rows.push({ tool, session_id: null, ts, kind: 'seven_day', used_percent: snapshot.utilization.seven_day, limit_value: null, reset_at: null });
  }
  if (snapshot.utilization.five_hour != null) {
    rows.push({ tool, session_id: null, ts, kind: 'five_hour', used_percent: snapshot.utilization.five_hour, limit_value: null, reset_at: null });
  }
  if (snapshot.spend_minor != null) {
    // Verbatim minor units: converting to a dollar figure would invent a
    // denominator the vendor never stated.
    rows.push({ tool, session_id: null, ts, kind: 'spend_minor_units', used_percent: null, limit_value: snapshot.spend_minor, reset_at: null });
  }
  return rows;
}

/** Reads and lands the quota snapshot; returns the rows written and the snapshot for the headroom line. */
export function syncQuotaObservations(db: DB, claudeJson?: string): { written: number; snapshot: QuotaSnapshot | null } {
  const snap = readQuotaSnapshot(claudeJson);
  if (!snap) return { written: 0, snapshot: null };
  return { written: insertQuotaObservations(db, quotaRows(snap)), snapshot: snap };
}

// ── the delta view: matched | vendor_only | local_only | units_differ | not_comparable (tier 8 #38)

export type DeltaState = 'matched' | 'vendor_only' | 'local_only' | 'units_differ' | 'not_comparable';

export interface DeltaCell {
  vendor: string;
  /** UTC day start, epoch ms. */
  day: number;
  vendor_value: number | null;
  local_value: number | null;
  delta: number | null;
  delta_pct: number | null;
  state: DeltaState;
  /** local calls in the cell, and how many of them make it not comparable. */
  local_calls: number;
  uncomparable_calls: number;
  unit: string | null;
}

/**
 * The delta view: vendor_ledger LEFT JOIN a same-shaped local aggregate,
 * keyed on (vendor, UTC day) — the finest key the ledger's columns carry
 * (per-model/per-identity cells are flagged for a foundation change).
 *
 * The arithmetic obeys principle 1 absolutely: a local cell holding any
 * activity_only row or any NULL-cost row makes `delta` NULL and the state
 * `not_comparable` — a missing local number is never read as zero, which is
 * the single most common way FinOps tools manufacture a fake gap. On a single
 * host most vendor_only spend is other machines' sessions, so the caller must
 * label single-host mode.
 */
export function reconcileDelta(
  db: DB,
  fromMs: number,
  toMs: number,
  vendor = 'anthropic',
  localTool = 'claude_code',
): DeltaCell[] {
  const vendorRows = db
    .prepare(
      `SELECT period_start, vendor_cost_usd, unit FROM vendor_ledger
       WHERE vendor = ? AND period_start >= ? AND period_start < ?`,
    )
    .all(vendor, utcDay(fromMs), utcDay(toMs)) as { period_start: number; vendor_cost_usd: number | null; unit: string | null }[];
  const localRows = db
    .prepare(
      `SELECT CAST(ts / 86400000 AS INT) * 86400000 AS day,
              SUM(cost_usd) AS local_value,
              COUNT(*) AS calls,
              SUM(CASE WHEN confidence = 'activity_only' OR cost_usd IS NULL THEN 1 ELSE 0 END) AS uncomparable
       FROM usage_events
       WHERE source = 'live' AND tool = ? AND ts >= ? AND ts < ?
       GROUP BY day`,
    )
    .all(localTool, utcDay(fromMs), utcDay(toMs)) as { day: number; local_value: number | null; calls: number; uncomparable: number }[];

  const vmap = new Map(vendorRows.map((r) => [r.period_start, r]));
  const cells: DeltaCell[] = [];
  for (const l of localRows) {
    const v = vmap.get(l.day);
    vmap.delete(l.day);
    cells.push(cellFor(vendor, l.day, v ?? null, l));
  }
  // Days the vendor billed but this endpoint recorded nothing: vendor_only.
  for (const [day, v] of vmap) cells.push(cellFor(vendor, day, v, null));
  return cells.sort((a, b) => a.day - b.day);
}

function cellFor(
  vendor: string,
  day: number,
  v: { period_start: number; vendor_cost_usd: number | null; unit: string | null } | null,
  l: { day: number; local_value: number | null; calls: number; uncomparable: number } | null,
): DeltaCell {
  const vendor_value = v?.vendor_cost_usd ?? null;
  const local_value = l?.local_value ?? null;
  let state: DeltaState;
  let delta: number | null = null;
  let delta_pct: number | null = null;
  if (v && v.unit != null && v.unit !== 'USD') state = 'units_differ';
  else if (l && l.uncomparable > 0) state = 'not_comparable';
  else if (vendor_value != null && local_value != null) {
    state = 'matched';
    delta = vendor_value - local_value;
    delta_pct = vendor_value !== 0 ? (delta / vendor_value) * 100 : null;
  } else if (vendor_value != null) state = 'vendor_only';
  else state = 'local_only';
  return {
    vendor,
    day,
    vendor_value,
    local_value,
    delta,
    delta_pct,
    state,
    local_calls: l?.calls ?? 0,
    uncomparable_calls: l?.uncomparable ?? 0,
    unit: v?.unit ?? null,
  };
}

// ── the coverage report: what share of spend is even checkable (tier 8 #35) ──

export interface CoverageReport {
  /** A statement about THIS endpoint only — it cannot account for agents or machines Vole does not collect. */
  endpoint_only: true;
  rows: number;
  priced_rows: number;
  unpriced_rows: number;
  exact_rows: number;
  activity_only_rows: number;
  auth_reconcilable_rows: number;
  /** List-value (SUM cost_usd) in each bucket — the share of spend, not of rows. */
  list_value_priced: number;
  list_value_total: number;
  per_tool: {
    tool: string;
    vendor: string | null;
    rows: number;
    priced_rows: number;
    unpriced_rows: number;
    activity_only_rows: number;
    auth_reconcilable: boolean;
    note: string | null;
  }[];
}

const TOOL_VENDOR: Partial<Record<Tool, string>> = {
  claude_code: 'anthropic',
  codex: 'openai',
  cursor: 'cursor',
  copilot_cli: 'github',
  grok: 'xai',
};

/**
 * Three axes over every live row in a range: priced vs unpriced, exact vs
 * activity_only, and reconcilable auth path vs not. The auth axis is honest
 * about its ceiling: a vendor is reconcilable when a vendor identity is known
 * AND the plan is not a subscription (Anthropic's console never shows
 * subscription usage), so on this machine the whole Anthropic leg reads
 * not-reconcilable — which is the finding, not a failure.
 */
export function reconcileCoverage(db: DB, fromMs: number, toMs: number): CoverageReport {
  const ids = db
    .prepare('SELECT vendor, plan, auth_path FROM vendor_identities')
    .all() as { vendor: string; plan: string | null; auth_path: string | null }[];
  const byVendor = new Map(ids.map((i) => [i.vendor, i]));
  const toolAgg = db
    .prepare(
      `SELECT tool,
              COUNT(*) AS rows,
              SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS priced,
              SUM(CASE WHEN confidence = 'activity_only' THEN 1 ELSE 0 END) AS activity_only,
              SUM(CASE WHEN cost_usd IS NOT NULL AND confidence != 'activity_only' THEN cost_usd ELSE 0 END) AS priced_value
       FROM usage_events WHERE source = 'live' AND ts >= ? AND ts < ? GROUP BY tool`,
    )
    .all(fromMs, toMs) as { tool: Tool; rows: number; priced: number; activity_only: number; priced_value: number }[];

  let rows = 0, priced_rows = 0, unpriced_rows = 0, exact_rows = 0, activity_only_rows = 0, auth_rows = 0, lv_priced = 0, lv_total = 0;
  const per_tool: CoverageReport['per_tool'] = [];
  for (const t of toolAgg) {
    const vendor = TOOL_VENDOR[t.tool] ?? null;
    const id = vendor ? byVendor.get(vendor) : undefined;
    const subscription = id?.plan ? /subscription|claude_max|stripe/.test(id.plan) : false;
    const reconcilable = id != null && !subscription;
    const unpriced = t.rows - t.priced;
    const exact = t.rows - t.activity_only;
    rows += t.rows;
    priced_rows += t.priced;
    unpriced_rows += unpriced;
    exact_rows += exact;
    activity_only_rows += t.activity_only;
    if (reconcilable) auth_rows += t.rows;
    lv_priced += t.priced_value;
    // The list value of unpriced rows is unknowable by definition — the total
    // carries the priced value only, and the unpriced COUNT beside it.
    lv_total += t.priced_value;
    per_tool.push({
      tool: t.tool,
      vendor,
      rows: t.rows,
      priced_rows: t.priced,
      unpriced_rows: unpriced,
      activity_only_rows: t.activity_only,
      auth_reconcilable: reconcilable,
      note: vendor == null
        ? 'no single vendor (per-provider routing)'
        : id == null
          ? 'no vendor identity on disk'
          : subscription
            ? `subscription plan (${id.plan}) — the console will never show this usage`
            : null,
    });
  }
  return {
    endpoint_only: true,
    rows,
    priced_rows,
    unpriced_rows,
    exact_rows,
    activity_only_rows,
    auth_reconcilable_rows: auth_rows,
    list_value_priced: lv_priced,
    list_value_total: lv_total,
    per_tool,
  };
}

// ── the two rules (tier 8 #1 and #44) ────────────────────────────────────────

export interface GapCell {
  vendor: string;
  /** Pseudonymous identity (an HMAC), or 'all' when the cell is not identity-scoped. */
  identity: string;
  day: number;
  direction: 'tokens' | 'usd';
  vendor_value: number;
  local_value: number | null;
  vendor_unit: string;
  local_unit: string;
  not_comparable: boolean;
}

const VENDOR_TOOL: Record<string, Tool> = {
  anthropic: 'claude_code',
  openai: 'codex',
  cursor: 'cursor',
  github: 'copilot_cli',
  xai: 'grok',
};

/**
 * reconcile_gap (tier 8 #44): fires when a (vendor, identity, UTC day,
 * direction) cell has both sides non-NULL, the same unit, and
 * |vendor − local| / vendor > 15% on at least TWO CONSECUTIVE days — the
 * consecutive-day gate absorbs bucket-boundary and timezone skew, it does not
 * soften the finding. `anomaly_key` is deterministic and free of now().
 * Anomalies are INSERT OR IGNORE on anomaly_key, so the first verdict is
 * frozen; the key carries the day, so each new day is a fresh verdict.
 */
export function detectReconcileGap(cells: GapCell[], now = Date.now()): Anomaly[] {
  const exceeded = new Map<string, GapCell>();
  for (const c of cells) {
    if (c.not_comparable) continue;
    if (c.vendor_unit !== c.local_unit) continue;
    if (c.local_value == null || c.local_value === 0 || c.vendor_value === 0) continue;
    const pct = Math.abs(c.vendor_value - c.local_value) / c.vendor_value;
    if (pct > 0.15) exceeded.set(`${c.vendor}|${c.identity}|${c.direction}|${c.day}`, c);
  }
  const out: Anomaly[] = [];
  for (const c of exceeded.values()) {
    const prev = exceeded.get(`${c.vendor}|${c.identity}|${c.direction}|${c.day - DAY_MS}`);
    if (!prev) continue; // single-day spikes are bucket skew until they repeat
    if (c.local_value == null) continue; // a NULL local figure is not_comparable, never a fake gap
    const pct = Math.abs(c.vendor_value - c.local_value) / c.vendor_value;
    out.push({
      anomaly_key: `reconcile:${c.vendor}:${c.identity}:${c.day}:${c.direction}`,
      rule: 'reconcile_gap',
      severity: 'warn',
      tool: VENDOR_TOOL[c.vendor] ?? 'claude_code',
      session_id: null,
      model: null,
      window_start: c.day - DAY_MS,
      window_end: c.day + DAY_MS,
      title: `${c.vendor} and Vole disagree on ${c.direction} for ${new Date(c.day).toISOString().slice(0, 10)}`,
      detail: `${c.vendor} reports ${c.vendor_value.toLocaleString()} ${c.direction}; Vole observed ${(c.local_value as number).toLocaleString()} for this identity (${(pct * 100).toFixed(0)}% gap, threshold 15%), on two consecutive days.`,
      observed: pct * 100,
      baseline: 0,
      threshold: 15,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }
  return out;
}

export interface ShadowInput {
  vendor: string;
  /** True when a successful vendor pull ran (vendor_ledger holds an api-sourced row for the vendor). */
  pull_ran: boolean;
  /** True when the plan is subscription-based — the console can never show this usage, so the rule can never fire. */
  subscription: boolean;
  local_days: { day: number; model: string | null; tokens: number; cost_usd: number | null }[];
  vendor_days: { day: number; models: string[] }[];
}

/**
 * shadow_account_spend (tier 8 #1): a local session is console-blind when its
 * exact tokens map to no vendor row for its day and model. Without a
 * successful pull the rule MUST NOT fire at all (absence of evidence is not
 * evidence of shadow spend), and under a subscription plan it can never fire
 * for Anthropic. Keys are (vendor, day, model) — model ids, not personal data.
 */
export function detectShadowAccountSpend(input: ShadowInput, now = Date.now()): Anomaly[] {
  if (!input.pull_ran || input.subscription) return [];
  const vendorDayModels = new Map(input.vendor_days.map((d) => [d.day, new Set(d.models)]));
  const blind = new Map<number, { tokens: number; models: Set<string>; cost: number }>();
  for (const l of input.local_days) {
    if (l.tokens <= 0) continue; // activity_only rows cannot claim console blindness
    const models = vendorDayModels.get(l.day);
    if (models && l.model && models.has(l.model)) continue;
    const b = blind.get(l.day) ?? { tokens: 0, models: new Set<string>(), cost: 0 };
    b.tokens += l.tokens;
    if (l.model) b.models.add(l.model);
    b.cost += l.cost_usd ?? 0;
    blind.set(l.day, b);
  }
  const out: Anomaly[] = [];
  for (const [day, b] of blind) {
    out.push({
      anomaly_key: `shadow_account_spend:${input.vendor}:${day}`,
      rule: 'shadow_account_spend',
      severity: 'critical',
      tool: VENDOR_TOOL[input.vendor] ?? 'claude_code',
      session_id: null,
      model: null,
      window_start: day,
      window_end: day + DAY_MS,
      title: `Console never saw this: ${b.tokens.toLocaleString()} tokens on ${new Date(day).toISOString().slice(0, 10)}`,
      detail: `${b.models.size} model(s) absent from the reconciled vendor's model list ([${[...b.models].join(', ')}]); list-equivalent value ${b.cost > 0 ? `$${b.cost.toFixed(2)}` : 'unpriced'}. Provable only for the window and identity the reconcile pulled.`,
      observed: b.tokens,
      baseline: 0,
      threshold: 0,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }
  return out;
}

/**
 * The DB-driven wrapper for both rules, run after a real (non-dry) vendor
 * pull. Local token cells come from exact rows only; the vendor side from the
 * api-sourced vendor_ledger rows of the same window.
 */
export function rulesAfterPull(db: DB, vendor: string, fromMs: number, toMs: number, now = Date.now()): Anomaly[] {
  const pullRan = db
    .prepare(`SELECT COUNT(*) AS n FROM vendor_ledger WHERE vendor = ? AND source LIKE 'api%'`)
    .get(vendor) as { n: number };
  const plan = db
    .prepare(`SELECT plan FROM vendor_identities WHERE vendor = ? ORDER BY last_seen DESC LIMIT 1`)
    .get(vendor) as { plan: string | null } | undefined;
  const subscription = plan?.plan ? /subscription|claude_max|stripe/.test(plan.plan) : false;

  const local = db
    .prepare(
      `SELECT CAST(ts / 86400000 AS INT) * 86400000 AS day, model,
              SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) AS tokens,
              SUM(cost_usd) AS cost
       FROM usage_events
       WHERE source = 'live' AND tool = ? AND confidence = 'exact' AND ts >= ? AND ts < ?
       GROUP BY day, model`,
    )
    .all(VENDOR_TOOL[vendor] ?? 'claude_code', utcDay(fromMs), utcDay(toMs)) as { day: number; model: string | null; tokens: number; cost: number | null }[];

  // Token-direction gap cells: vendor token rows live only in the pull result
  // (the ledger schema has no token-value column), so those cells are built by
  // the reconcile CLI from the adapter response; the USD direction is
  // derivable here. Local USD per day sums only rows carrying the vendor's
  // basis — an unpriced day is not_comparable, never a 100% gap.
  const localUsdPerDay = new Map<number, { usd: number; unpriced: number }>();
  const basis = db
    .prepare(
      `SELECT CAST(ts / 86400000 AS INT) * 86400000 AS day,
              SUM(CASE WHEN cost_basis IS NOT NULL AND cost_usd IS NOT NULL THEN cost_usd ELSE 0 END) AS usd,
              SUM(CASE WHEN cost_basis IS NULL OR cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
       FROM usage_events
       WHERE source = 'live' AND tool = ? AND ts >= ? AND ts < ?
       GROUP BY day`,
    )
    .all(VENDOR_TOOL[vendor] ?? 'claude_code', utcDay(fromMs), utcDay(toMs)) as { day: number; usd: number; unpriced: number }[];
  for (const r of basis) localUsdPerDay.set(r.day, { usd: r.usd, unpriced: r.unpriced });

  const usdCells: GapCell[] = (
    db
      .prepare(
        `SELECT period_start AS day, vendor_cost_usd FROM vendor_ledger
       WHERE vendor = ? AND source LIKE 'api%' AND unit = 'USD' AND period_start >= ? AND period_start < ?`,
      )
      .all(vendor, utcDay(fromMs), utcDay(toMs)) as { day: number; vendor_cost_usd: number }[]
  ).map((row) => {
    const l = localUsdPerDay.get(row.day);
    return {
      vendor,
      identity: 'all',
      day: row.day,
      direction: 'usd' as const,
      vendor_value: row.vendor_cost_usd,
      local_value: l ? l.usd : null,
      vendor_unit: 'USD',
      local_unit: 'USD',
      not_comparable: !l || l.unpriced > 0,
    };
  });

  const vendorDays = db
    .prepare(
      `SELECT period_start AS day FROM vendor_ledger WHERE vendor = ? AND source LIKE 'api%' AND period_start >= ? AND period_start < ?`,
    )
    .all(vendor, utcDay(fromMs), utcDay(toMs)) as { day: number }[];

  return [
    ...detectReconcileGap(usdCells, now),
    ...detectShadowAccountSpend(
      {
        vendor,
        pull_ran: pullRan.n > 0,
        subscription,
        local_days: local.map((l) => ({ day: l.day, model: l.model, tokens: l.tokens, cost_usd: l.cost })),
        // The ledger carries no model list — a day with ANY vendor row counts
        // as seen for all models; a day with none is blind. Per-model vendor
        // lists flow through the adapter's in-memory response (flagged).
        vendor_days: vendorDays.map((d) => ({ day: d.day, models: local.filter((l) => l.day === d.day).map((l) => l.model ?? '') })),
      },
      now,
    ),
  ];
}
