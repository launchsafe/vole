/**
 * Tier 7 noise budget: findings-per-host-per-week per rule and overall,
 * against a budget shipped as a content pack (~/.vole/policy/noise.json,
 * admin-overridable under the managed root). A noise_budget_exceeded info
 * incident fires with anomaly_key `noise_budget:<machine_hash>:<rule>:<iso_week>`
 * — anchored on the WEEK, so it fires once per rule per week and cannot
 * re-fire on every five-second poll — and the meta-rule is excluded from
 * its own count.
 *
 * The budget counts findings WRITTEN, so a week when the collector was down
 * looks quiet: the reader joins evidence_gaps and prints the unmonitored
 * hours beside the count rather than letting silence read as calm.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { DB } from '../db';

/**
 * The noise pack's path list. Managed root wins over the per-user policy —
 * the same precedence every other policy uses. Owned here pending the
 * paths.ts integration (noisePaths).
 */
export function noisePackPaths(): string[] {
  const home = process.env.VOLE_HOME_OVERRIDE ?? process.env.HOME ?? '';
  return [
    '/Library/Application Support/Vole/policy/noise.json',
    `${home}/.vole/policy/noise.json`,
  ];
}

export interface NoiseBudget {
  /** findings per host per week, overall */
  overall_per_week: number;
  /** per-rule ceilings; a rule absent here is counted only against overall */
  per_rule_per_week?: Record<string, number>;
}

export const DEFAULT_NOISE_BUDGET: NoiseBudget = { overall_per_week: 40 };

export function loadNoiseBudget(): NoiseBudget {
  for (const p of noisePackPaths()) {
    if (!existsSync(p)) continue;
    try {
      const d = JSON.parse(readFileSync(p, 'utf8')) as NoiseBudget;
      if (typeof d.overall_per_week === 'number') return d;
    } catch {
      /* unreadable pack: fall through to the next, then the builtin floor */
    }
  }
  return DEFAULT_NOISE_BUDGET;
}

/** ISO week key, e.g. '2026-W36'. Monday-first, per ISO 8601. */
export function isoWeek(ts: number): string {
  const d = new Date(ts);
  // Thursday of this ISO week anchors the year correctly.
  const thu = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  thu.setUTCDate(thu.getUTCDate() + 3 - ((thu.getUTCDay() + 6) % 7));
  const yearStart = Date.UTC(thu.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thu.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${thu.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The machine hash the anomaly key anchors on: a digest of the stored machine name. */
export function machineHash(machine: string): string {
  return createHash('sha256').update(machine).digest('hex').slice(0, 16);
}

export interface NoiseBudgetRow {
  machine: string;
  iso_week: string;
  rule: string;
  findings: number;
  budget: number | null;
  exceeded: boolean;
}

export interface NoiseExceeded {
  anomaly_key: string;
  rule: string;
  machine: string;
  iso_week: string;
  findings: number;
  budget: number | null;
}

/**
 * Groups live anomalies by (machine, rule, ISO week) on detected_at against
 * the budget. The meta-rule is excluded from its own count (and from every
 * other rule's — it is bookkeeping, not noise).
 */
export function noiseBudgetRows(db: DB, budget: NoiseBudget = loadNoiseBudget()): { rows: NoiseBudgetRow[]; exceeded: NoiseExceeded[] } {
  const counts = db
    .prepare(
      `SELECT COALESCE(machine, 'unknown') AS machine, rule, detected_at
       FROM anomalies WHERE source = 'live' AND rule != 'noise_budget_exceeded'`,
    )
    .all() as { machine: string; rule: string; detected_at: number }[];

  const agg = new Map<string, NoiseBudgetRow>();
  for (const c of counts) {
    const week = isoWeek(c.detected_at);
    const key = `${c.machine}|${week}|${c.rule}`;
    const row = agg.get(key) ?? {
      machine: c.machine, iso_week: week, rule: c.rule,
      findings: 0, budget: budget.per_rule_per_week?.[c.rule] ?? null, exceeded: false,
    };
    row.findings++;
    agg.set(key, row);
  }

  const rows = [...agg.values()];
  for (const r of rows) {
    r.exceeded = r.budget !== null && r.findings > r.budget;
  }

  // The overall per-host per-week total, excluding the meta-rule (already
  // excluded above) — counted from the same rows so it cannot disagree.
  const overall = new Map<string, number>();
  for (const r of rows) overall.set(`${r.machine}|${r.iso_week}`, (overall.get(`${r.machine}|${r.iso_week}`) ?? 0) + r.findings);

  const exceeded: NoiseExceeded[] = [];
  for (const r of rows) {
    if (r.exceeded) {
      exceeded.push({
        anomaly_key: `noise_budget:${machineHash(r.machine)}:${r.rule}:${r.iso_week}`,
        rule: r.rule, machine: r.machine, iso_week: r.iso_week,
        findings: r.findings, budget: r.budget,
      });
    }
  }
  for (const [key, n] of overall) {
    if (n > budget.overall_per_week) {
      const [machine, week] = key.split('|');
      exceeded.push({
        anomaly_key: `noise_budget:${machineHash(machine)}:__overall__:${week}`,
        rule: '__overall__', machine, iso_week: week,
        findings: n, budget: budget.overall_per_week,
      });
    }
  }
  return { rows, exceeded };
}
