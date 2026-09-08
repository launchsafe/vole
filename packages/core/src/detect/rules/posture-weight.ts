import type { Anomaly, Severity } from '../../types';

/**
 * Posture as a first-class severity input (tier 5 #36/#48) and the autonomy
 * clock's chain arithmetic (tier 5 #39). A burn spike during a bypassPermissions
 * run must not read identical to one during a supervised session.
 */

/** Rank order: prompt_each < classifier_gated < accept_edits < full_auto. */
export const AUTONOMY_RANK: Record<string, number> = {
  prompt_each: 0,
  classifier_gated: 1,
  accept_edits: 2,
  full_auto: 3,
};

/** Vendor mode strings normalised onto the rank ladder; null = unknown, never 'default'. */
export function normalizeAutonomy(modeRaw: string | null | undefined): string | null {
  if (!modeRaw) return null;
  switch (modeRaw) {
    case 'default':
      return 'prompt_each';
    case 'plan':
    case 'planMode':
    case 'auto':
      return 'classifier_gated';
    case 'acceptEdits':
      return 'accept_edits';
    case 'bypassPermissions':
    case 'danger-full-access':
      return 'full_auto';
    default:
      return modeRaw;
  }
}

export function rankOf(autonomy: string | null | undefined): number | null {
  if (!autonomy) return null;
  return AUTONOMY_RANK[autonomy] ?? null;
}

// ── the autonomy clock: human-authored-entry chains ──────────────────────────

export interface ChainCall {
  ts: number;
  origin_kind: string | null;
}

export interface AutonomyChain {
  /** First call of the chain. */
  start_ts: number;
  end_ts: number;
  calls: number;
  /** The bounding human-origin entries, when any were recorded. */
  prev_human_ts: number | null;
  next_human_ts: number | null;
  /** False when origin_kind is absent — the whole session may be one chain. */
  origin_recorded: boolean;
}

/**
 * The longest run of consecutive tool calls with no human-authored entry between
 * them. A human-authored entry is identified by entry shape (origin_kind), never
 * by reading content. When origin_kind is entirely absent the run is reported
 * with origin_recorded=false — 'no human input recorded', never 'unattended'.
 */
export function autonomyChains(calls: ChainCall[]): AutonomyChain[] {
  const sorted = [...calls].sort((a, b) => a.ts - b.ts);
  const chains: AutonomyChain[] = [];
  const hasOrigin = sorted.some((c) => c.origin_kind !== null);
  if (!hasOrigin) {
    if (!sorted.length) return [];
    return [{
      start_ts: sorted[0]!.ts,
      end_ts: sorted[sorted.length - 1]!.ts,
      calls: sorted.length,
      prev_human_ts: null,
      next_human_ts: null,
      origin_recorded: false,
    }];
  }
  let current: ChainCall[] = [];
  let prevHuman: number | null = null;
  const flush = (nextHuman: number | null) => {
    if (current.length) {
      chains.push({
        start_ts: current[0]!.ts,
        end_ts: current[current.length - 1]!.ts,
        calls: current.length,
        prev_human_ts: prevHuman,
        next_human_ts: nextHuman,
        origin_recorded: true,
      });
    }
    current = [];
  };
  for (const c of sorted) {
    if (c.origin_kind === 'human') {
      flush(c.ts);
      prevHuman = c.ts;
    } else current.push(c);
  }
  flush(null);
  return chains;
}

export function longestChain(chains: AutonomyChain[]): AutonomyChain | null {
  return chains.reduce<AutonomyChain | null>((best, c) => (!best || c.end_ts - c.start_ts > best.end_ts - best.start_ts ? c : best), null);
}

/** Calls per human turn: total calls / (human entries + 1 open turn). */
export function callsPerHumanTurn(calls: ChainCall[]): { ratio: number | null; human_turns: number } {
  const humans = calls.filter((c) => c.origin_kind === 'human').length;
  if (humans === 0) return { ratio: null, human_turns: 0 };
  return { ratio: calls.length / (humans + 1), human_turns: humans };
}

// ── posture-weighted severity (tier 5 #48) ───────────────────────────────────

const SEV_ORDER: Severity[] = ['info', 'warn', 'critical'];

/**
 * Escalate one severity step when the incident window overlaps a full_auto
 * interval, writing the reason into the detail verbatim. A NULL posture must
 * leave severity untouched and never silently downgrade — it marks the incident
 * instead, so a clean-looking feed is not mistaken for a safe one.
 */
export function applyPostureWeight(
  a: Anomaly,
  posture: { known: boolean; fullAutoOverlapMs: number; windowMs: number },
): Anomaly {
  if (!posture.known) {
    return { ...a, detail: `${a.detail} Posture unknown for this window.` };
  }
  if (posture.fullAutoOverlapMs <= 0) return a;
  const pct = posture.windowMs > 0 ? Math.round((posture.fullAutoOverlapMs / posture.windowMs) * 100) : 100;
  const idx = SEV_ORDER.indexOf(a.severity);
  const severity = idx >= 0 && idx < SEV_ORDER.length - 1 ? SEV_ORDER[idx + 1] as Severity : a.severity;
  return {
    ...a,
    severity,
    detail: `${a.detail} Escalated: session was in bypassPermissions for ${pct}% of this window.`,
  };
}
