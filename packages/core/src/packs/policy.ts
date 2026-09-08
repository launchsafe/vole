/**
 * Tier 6 §40 + §78: the rule-threshold policy file with effective-value
 * provenance, and the per-kind content_stale floors.
 *
 * Precedence (managed wins, the same chain every policy file uses):
 *   /Library/Application Support/Vole/policy.json  >  ~/.vole/policy/policy.json
 * The screen is read-only by design: this module explains values, it never
 * writes the file. Nothing here enforces anything.
 */
import { existsSync, readFileSync } from 'node:fs';
import { paths } from '../paths';
import type { PackRecord } from './registry';

/**
 * Module defaults, copied verbatim from the detect modules' constants so the
 * Policy screen can print provenance ('module default') beside an override.
 * ponytail: the detect modules keep these private; they should export them so
 * this table cannot drift — flagged for integration.
 */
export const MODULE_DEFAULTS: { rule: string; param: string; value: number; unit: string }[] = [
  { rule: 'billable_burn_spike', param: 'window_minutes', value: 10, unit: 'min' },
  { rule: 'billable_burn_spike', param: 'min_tokens_in_window', value: 20_000, unit: 'tokens' },
  { rule: 'billable_burn_spike', param: 'spike_multiple', value: 3, unit: 'x median' },
  { rule: 'billable_burn_spike', param: 'min_baseline_windows', value: 3, unit: 'windows' },
  { rule: 'repeat_call_loop', param: 'window_minutes', value: 5, unit: 'min' },
  { rule: 'repeat_call_loop', param: 'abs_calls_per_window', value: 45, unit: 'calls' },
  { rule: 'repeat_call_loop', param: 'flat_output_tokens', value: 400, unit: 'tokens' },
  { rule: 'error_storm', param: 'window_minutes', value: 15, unit: 'min' },
  { rule: 'error_storm', param: 'min_errors', value: 5, unit: 'errors' },
  { rule: 'error_storm', param: 'ratio_threshold', value: 0.2, unit: 'ratio' },
];

export type ThresholdProvenance = 'module default' | 'managed policy' | 'policy.json';

export interface EffectiveThreshold {
  rule: string;
  param: string;
  effective: number;
  provenance: ThresholdProvenance;
  trust: 'admin_authored' | 'builtin_floor';
  source_path: string | null;
}

interface RulePolicyFile {
  rules?: Record<string, Record<string, number>>;
  content_stale_floors?: Record<string, number>;
}

/** The rule policy in force: the managed copy if present, else the per-user one. */
export function loadRulePolicy(): { file: string | null; managed: boolean; policy: RulePolicyFile } {
  const [managed, user] = paths.rulePolicyPaths() as [string, string];
  for (const [file, isManaged] of [[managed, true], [user, false]] as const) {
    if (!existsSync(file)) continue;
    try {
      return { file, managed: isManaged, policy: JSON.parse(readFileSync(file, 'utf8')) as RulePolicyFile };
    } catch {
      // A malformed policy is ignored — policy must never break collection —
      // but the miss is visible: provenance falls through to the next layer.
    }
  }
  return { file: null, managed: false, policy: {} };
}

/** Every rule threshold with the provenance of its effective value. */
export function effectiveThresholds(): EffectiveThreshold[] {
  const { file, managed, policy } = loadRulePolicy();
  const overridden = policy.rules ?? {};
  return MODULE_DEFAULTS.map((d) => {
    const o = overridden[d.rule]?.[d.param];
    return {
      rule: d.rule,
      param: d.param,
      effective: typeof o === 'number' ? o : d.value,
      provenance: typeof o === 'number' ? (managed ? 'managed policy' : 'policy.json') : 'module default',
      trust: typeof o === 'number' ? 'admin_authored' : 'builtin_floor',
      source_path: typeof o === 'number' ? file : null,
    } satisfies EffectiveThreshold;
  });
}

// ── content_stale (§78) ─────────────────────────────────────────────────────

/** Default floor 90 days; advisory_floor 30 because an old CVE table means "unknown", not "clean". */
export const DEFAULT_STALE_FLOORS: Record<string, number> = { default: 90, advisory_floor: 30 };
/** semconv is cosmetic: staleness there is info, never a pager. */
const INFO_ONLY_KINDS = new Set(['semconv']);

export interface StaleFloor {
  kind: string;
  floor_days: number;
  provenance: ThresholdProvenance;
  source_path?: string;
}

/** Per-kind staleness floors through the same provenance chain as the thresholds. */
export function staleFloors(): StaleFloor[] {
  const { file, managed, policy } = loadRulePolicy();
  const o = policy.content_stale_floors ?? {};
  const kinds = new Set([...Object.keys(DEFAULT_STALE_FLOORS), ...Object.keys(o)]);
  return [...kinds].sort().map((kind): StaleFloor => {
    const overridden = typeof o[kind] === 'number';
    return {
      kind,
      floor_days: overridden ? (o[kind] as number) : (DEFAULT_STALE_FLOORS[kind] ?? DEFAULT_STALE_FLOORS.default!),
      provenance: overridden ? (managed ? 'managed policy' : 'policy.json') : 'module default',
      source_path: overridden ? (file ?? undefined) : undefined,
    };
  });
}

export interface ContentStaleRow {
  anomaly_key: string;
  severity: 'info' | 'warn';
  title: string;
  detail: string;
  built_at: number;
  age_days: number;
  floor_days: number;
  content_rev: number;
}

/**
 * content_stale rows. The key ages in 30-day steps —
 * `content_stale:<kind>:<version>:<floor(age_days/30)>` — deterministic and
 * free of now(), so the incident escalates in steps instead of duplicating
 * every poll or freezing at its first severity.
 */
export function contentStaleRows(packs: PackRecord[], now: number): ContentStaleRow[] {
  const floors = new Map(staleFloors().map((f) => [f.kind, f.floor_days]));
  const out: ContentStaleRow[] = [];
  for (const p of packs) {
    if (!p.built_at) continue;
    const age_days = Math.floor((now - p.built_at) / 86_400_000);
    const floor_days = floors.get(p.kind) ?? (DEFAULT_STALE_FLOORS.default as number);
    if (age_days <= floor_days) continue;
    const step = Math.floor(age_days / 30);
    out.push({
      anomaly_key: `content_stale:${p.kind}:${p.version}:${step}`,
      severity: INFO_ONLY_KINDS.has(p.kind) ? 'info' : 'warn',
      title: `${p.kind} content is ${age_days}d old`,
      detail: `pack ${p.kind} v${p.version} (built ${new Date(p.built_at).toISOString().slice(0, 10)}) is ${age_days} days old against a ${floor_days}-day floor; with no network, Vole cannot know whether a newer pack exists, only how old this one is`,
      built_at: p.built_at,
      age_days,
      floor_days,
      content_rev: p.version,
    });
  }
  return out;
}
