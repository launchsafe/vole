import type { DB } from '../../db';
import type { Anomaly } from '../../types';
import {
  codexClaimViolations,
  type CodexTurnClaim,
} from '../../collectors/codex';

/**
 * The Codex confinement-claim rules (tier 5 #51): falsify the turn_context's
 * declared sandbox / network posture against the calls that actually ran.
 * Claims are per-pass facts (the collector parses them from rollout files),
 * so this runs from the collect loop with the current pass's claims — not
 * from history, which holds no claim rows.
 *
 * Pure on the arguments; the anomalies are idempotent by call key.
 */
export function detectCodexClaimRules(db: DB, claims: CodexTurnClaim[], now: number): Anomaly[] {
  if (claims.length === 0) return [];
  const out: Anomaly[] = [];
  const calls = db
    .prepare(`SELECT tool_call_key, session_id, name, path, ts FROM tool_calls WHERE tool = 'codex'`)
    .all() as { tool_call_key: string; session_id: string | null; name: string; path: string | null; ts: number }[];

  for (const v of codexClaimViolations(claims, calls)) {
    out.push({
      anomaly_key: `sandbox_claim_violated:${v.call_key}`,
      rule: 'sandbox_claim_violated',
      severity: 'critical',
      tool: 'codex',
      session_id: v.session_id,
      model: null,
      window_start: now,
      window_end: now,
      title: `Sandbox claim violated: ${v.tool} touched outside the declared roots`,
      detail:
        `A ${v.tool} call ran under declared policy '${v.declared_policy}' but touched a path outside the declared ` +
        `workspace roots. Declared root: ${v.declared_root ?? 'unknown'}. The call's own claim said the sandbox held; ` +
        `the observed path proves it did not.`,
      observed: 1,
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }

  // The network variant: a claim of restricted/no network while fetch-shaped
  // calls ran in the same session window. The observed wire (OTLP lane)
  // completes this; the fetch-shaped call is the coarse half the stored shape proves.
  const FETCH_SHAPED = /^(webfetch|fetch|browser_fetch|fetch_url|http_request|mcp__.*__(fetch|search))/i;
  const bySession = new Map<string, CodexTurnClaim[]>();
  for (const c of claims) {
    if (!c.session_id) continue;
    const arr = bySession.get(c.session_id);
    if (arr) arr.push(c);
    else bySession.set(c.session_id, [c]);
  }
  for (const c of calls) {
    if (!c.session_id || !FETCH_SHAPED.test(c.name)) continue;
    const claim = bySession
      .get(c.session_id)!
      .filter((t) => t.ts <= c.ts)
      .sort((a, b) => a.ts - b.ts)
      .at(-1);
    if (!claim || (claim.network_access !== 'restricted' && claim.network_access !== 'none')) continue;
    out.push({
      anomaly_key: `network_claim_violated:${c.tool_call_key}`,
      rule: 'network_claim_violated',
      severity: 'warn',
      tool: 'codex',
      session_id: c.session_id,
      model: null,
      window_start: now,
      window_end: now,
      title: `Network claim violated: ${c.name} ran under a no-network claim`,
      detail:
        `A fetch-shaped call (${c.name}) ran in a session whose turn_context declared network_access ` +
        `'${claim.network_access}'. The stored shape proves a network-shaped tool ran; the observed-wire ` +
        `lane carries the byte-level confirmation.`,
      observed: 1,
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }
  return out;
}
