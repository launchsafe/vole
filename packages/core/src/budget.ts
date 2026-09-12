/**
 * Budget guards — soft warnings and hard stops on agent spend.
 *
 * A cap is only as trustworthy as the number it is compared against, so the tier system
 * matters here more than anywhere else in the product:
 *
 *   - `exact` cost always counts.
 *   - `estimated` cost counts BY DEFAULT. A cap that silently ignored unmeasured spend
 *     would under-report exactly when it matters most, and a guard that lets you past
 *     your own ceiling is worse than no guard. `includeEstimated: false` turns it off
 *     for anyone who wants caps to track only verbatim figures.
 *   - `activity_only` rows have no cost at all — there is nothing to add. They are
 *     counted and DISCLOSED instead, so a breach message can say "plus 40 calls whose
 *     cost this tool cannot see" rather than implying the total is complete.
 *
 * That last point is the honest limit of this feature: Vole can only cap what it can
 * measure, and it says so in the message rather than pretending otherwise.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from './paths';
import type { DB } from './db';

export interface CapPair {
  /** Warn at or above this, in USD. */
  soft: number | null;
  /** Refuse further tool calls at or above this, in USD. */
  hard: number | null;
}

export interface BudgetConfig {
  /** Rolling calendar day, local time. */
  daily: CapPair;
  /** One agent session, however long it runs. */
  session: CapPair;
  /** Whether `estimated` cost counts toward a cap. Default true; see the file header. */
  includeEstimated: boolean;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  daily: { soft: null, hard: null },
  session: { soft: null, hard: null },
  includeEstimated: true,
};

/** `~/.vole/budget.json`, beside the pricing override. */
export function budgetPath(): string {
  return process.env.VOLE_BUDGET ?? join(dirname(paths.db()), 'budget.json');
}

/** A malformed or absent config means "no caps", never a crash and never a guessed cap. */
export function loadBudget(): BudgetConfig {
  const file = budgetPath();
  if (!existsSync(file)) return { ...DEFAULT_BUDGET };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<BudgetConfig>;
    return {
      daily: pair(raw.daily),
      session: pair(raw.session),
      includeEstimated: raw.includeEstimated !== false,
    };
  } catch {
    return { ...DEFAULT_BUDGET };
  }
}

export function saveBudget(cfg: BudgetConfig): string {
  const file = budgetPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return file;
}

/** A cap must be a real, positive number to mean anything. */
function pair(p: Partial<CapPair> | undefined): CapPair {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  return { soft: n(p?.soft), hard: n(p?.hard) };
}

export interface TierSpend {
  exact: number;
  estimated: number;
  /** Calls whose cost is unknowable — disclosed, never guessed at. */
  unmeasuredCalls: number;
  calls: number;
}

/** Start of the local calendar day containing `now`. */
export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Spend since `fromMs`, split by tier. Optionally narrowed to one session. */
export function spendSince(db: DB, fromMs: number, sessionId?: string | null): TierSpend {
  const where = sessionId ? 'AND session_id = ?' : '';
  const params: (number | string)[] = sessionId ? [fromMs, sessionId] : [fromMs];
  const rows = db
    .prepare(
      `SELECT confidence,
              COALESCE(SUM(cost_usd), 0) AS cost,
              COUNT(*)                   AS calls,
              SUM(cost_usd IS NULL)      AS uncosted
         FROM usage_events
        WHERE source = 'live' AND ts >= ? ${where}
        GROUP BY confidence`,
    )
    .all(...params) as { confidence: string; cost: number; calls: number; uncosted: number }[];

  const out: TierSpend = { exact: 0, estimated: 0, unmeasuredCalls: 0, calls: 0 };
  for (const r of rows) {
    if (r.confidence === 'exact') out.exact += r.cost;
    else if (r.confidence === 'estimated') out.estimated += r.cost;
    out.calls += r.calls;
    out.unmeasuredCalls += r.uncosted ?? 0;
  }
  return out;
}

/** What a cap is compared against, given the configured tier policy. */
export function countedSpend(s: TierSpend, includeEstimated: boolean): number {
  return s.exact + (includeEstimated ? s.estimated : 0);
}

export type BreachLevel = 'ok' | 'soft' | 'hard';
export type BudgetScope = 'session' | 'daily';

export interface Breach {
  level: BreachLevel;
  scope: BudgetScope;
  spend: number;
  cap: number;
}

/** The worst breach across both scopes; `hard` always outranks `soft`. */
export function evaluateBudget(
  cfg: BudgetConfig,
  sessionSpend: TierSpend,
  dailySpend: TierSpend,
): Breach {
  const checks: { scope: BudgetScope; spend: number; caps: CapPair }[] = [
    { scope: 'session', spend: countedSpend(sessionSpend, cfg.includeEstimated), caps: cfg.session },
    { scope: 'daily', spend: countedSpend(dailySpend, cfg.includeEstimated), caps: cfg.daily },
  ];

  let worst: Breach = { level: 'ok', scope: 'session', spend: 0, cap: 0 };
  for (const c of checks) {
    if (c.caps.hard !== null && c.spend >= c.caps.hard) {
      // A hard breach ends the search: nothing outranks it.
      return { level: 'hard', scope: c.scope, spend: c.spend, cap: c.caps.hard };
    }
    if (c.caps.soft !== null && c.spend >= c.caps.soft && worst.level === 'ok') {
      worst = { level: 'soft', scope: c.scope, spend: c.spend, cap: c.caps.soft };
    }
  }
  return worst;
}

/**
 * The message a blocked agent is shown.
 *
 * Deliberately complete: what was spent, against which cap, how that figure was
 * composed, and what it could not see. An agent told only "denied" will retry; one told
 * the number and the ceiling can explain the situation to the person instead.
 */
export function breachMessage(b: Breach, s: TierSpend, cfg: BudgetConfig): string {
  const money = (n: number) => `$${n.toFixed(2)}`;
  const scope = b.scope === 'daily' ? 'today' : 'this session';
  const parts = [`${money(s.exact)} exact`];
  if (s.estimated > 0) {
    parts.push(`${money(s.estimated)} estimated${cfg.includeEstimated ? '' : ' (excluded by config)'}`);
  }
  const unseen = s.unmeasuredCalls > 0
    ? ` ${s.unmeasuredCalls} further call(s) have no recorded cost and are not included.`
    : '';
  return (
    `Vole budget guard: spend ${scope} is ${money(b.spend)}, at or over the ` +
    `${money(b.cap)} ${b.level} cap. Composition: ${parts.join(' + ')}.${unseen} ` +
    `Stop and tell the user rather than retrying. Caps live in ${budgetPath()}.`
  );
}
