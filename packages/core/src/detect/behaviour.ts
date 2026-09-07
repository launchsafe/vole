import type { DB } from '../db';
import type { Anomaly } from '../types';

/**
 * The ledger-native behaviour rules — everything the usage_events view could
 * never see, because the question is about INVOCATIONS, not meters: what was
 * denied then achieved anyway, what runs remote, what failed in a storm, what
 * hung, what was destructive, what launched headless with permissions skipped.
 *
 * These rules read the store directly (the ledger is the substrate; pure-array
 * plumbing would just copy it). Every anomaly_key is stable, so re-runs are
 * idempotent.
 */

interface CallRow {
  tool_call_key: string;
  tool: string;
  name: string;
  shape: string | null;
  args_digest: string | null;
  session_id: string | null;
  agent_id: string | null;
  ts: number;
  status: string | null;
  duration_ms: number | null;
}

/** denied_then_achieved: a denied call followed by the SAME call succeeding. */
function detectDeniedThenAchieved(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT d.tool, d.session_id, d.name, d.args_digest, d.ts AS denied_ts,
              a.ts AS ok_ts, a.tool_call_key AS ok_key
       FROM tool_calls d
       JOIN tool_calls a
         ON a.session_id = d.session_id AND a.name = d.name
        AND a.args_digest = d.args_digest AND a.args_digest IS NOT NULL
        AND a.status = 'success' AND a.ts > d.ts AND a.ts - d.ts < 3600000
       WHERE d.status = 'denied' AND d.args_digest IS NOT NULL
       ORDER BY d.ts`,
    )
    .all() as { tool: string; session_id: string | null; name: string; args_digest: string; denied_ts: number; ok_ts: number; ok_key: string }[];
  const seen = new Set<string>();
  const out: Anomaly[] = [];
  for (const r of rows) {
    const key = `denied_then_achieved:${r.tool}:${r.session_id ?? 'none'}:${r.args_digest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      anomaly_key: key,
      rule: 'denied_then_achieved',
      severity: 'critical',
      tool: r.tool as Anomaly['tool'],
      session_id: r.session_id,
      model: null,
      window_start: r.denied_ts,
      window_end: r.ok_ts,
      title: `Guardrail bypass: ${r.name} denied, then achieved`,
      detail:
        `A ${r.name} call was denied, and the identical call (same arguments digest) succeeded ` +
        `${Math.round((r.ok_ts - r.denied_ts) / 1000)}s later in the same session. The agent re-asked ` +
        `until the guard let it through, or reshaped the request — either way the denial did not hold.`,
      observed: r.ok_ts - r.denied_ts,
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }
  return out;
}

const REMOTE_SHAPES = /^(ssh|scp|rsync|docker exec|docker run|kubectl exec|kubectl apply)\b/;
const DESTRUCTIVE_SHAPES = /^(rm -rf|rm -fr|git reset --hard|git clean|truncate|shred|mkfs)\b/;

/** Remote-execution hops and destructive commands: shape-matched, never content. */
function detectShapeRules(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT tool_call_key, tool, name, shape, session_id, agent_id, ts
       FROM tool_calls WHERE shape IS NOT NULL`,
    )
    .all() as CallRow[];
  const out: Anomaly[] = [];
  for (const r of rows) {
    const remote = r.shape !== null && REMOTE_SHAPES.test(r.shape);
    const destructive = r.shape !== null && DESTRUCTIVE_SHAPES.test(r.shape);
    if (!remote && !destructive) continue;
    out.push({
      anomaly_key: `${remote ? 'remote_execution' : 'destructive_command'}:${r.tool_call_key}`,
      rule: remote ? 'remote_execution' : 'destructive_command',
      severity: remote ? 'warn' : 'critical',
      tool: r.tool as Anomaly['tool'],
      session_id: r.session_id,
      model: null,
      window_start: r.ts,
      window_end: r.ts,
      title: remote ? `Remote execution: ${r.shape}` : `Destructive command: ${r.shape}`,
      detail: remote
        ? `A ${r.shape} command ran in session ${r.session_id?.slice(0, 8) ?? 'unknown'} — execution left this laptop. The shape is recorded, never the command string.`
        : `A ${r.shape} command ran in session ${r.session_id?.slice(0, 8) ?? 'unknown'}. The shape is recorded, never the command string.`,
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

/** tool_failure_storm: ≥10 errored calls in 15 min in one session. */
function detectFailureStorms(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT tool, session_id, COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi
       FROM tool_calls WHERE status = 'error' AND ts > ?
       GROUP BY tool, session_id HAVING n >= 10`,
    )
    .all(now - 7 * 24 * 3600_000) as { tool: string; session_id: string | null; n: number; lo: number; hi: number }[];
  return rows.map((r) => ({
    anomaly_key: `tool_failure_storm:${r.tool}:${r.session_id ?? 'none'}`,
    rule: 'tool_failure_storm' as const,
    severity: 'warn' as const,
    tool: r.tool as Anomaly['tool'],
    session_id: r.session_id,
    model: null,
    window_start: r.lo,
    window_end: r.hi,
    title: `Tool failure storm: ${r.n} errored calls`,
    detail: `${r.n} tool calls errored in session ${r.session_id?.slice(0, 8) ?? 'unknown'} — the agent may be retrying against a broken tool or API.`,
    observed: r.n,
    baseline: null,
    threshold: 10,
    confidence: 'exact' as const,
    source: 'live' as const,
    detected_at: now,
  }));
}

/** stuck_tool_call: a single call running > 10 minutes. */
function detectStuckCalls(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT tool, session_id, name, duration_ms, ts FROM tool_calls
       WHERE duration_ms > 600000 AND duration_kind = 'measured'`,
    )
    .all() as { tool: string; session_id: string | null; name: string; duration_ms: number; ts: number }[];
  return rows.map((r) => ({
    anomaly_key: `stuck_tool_call:${r.tool}:${r.session_id ?? 'none'}:${r.ts}`,
    rule: 'stuck_tool_call' as const,
    severity: 'warn' as const,
    tool: r.tool as Anomaly['tool'],
    session_id: r.session_id,
    model: null,
    window_start: r.ts,
    window_end: r.ts + r.duration_ms,
    title: `Stuck tool call: ${r.name} ran ${Math.round(r.duration_ms / 60000)} min`,
    detail: `A ${r.name} call ran for ${Math.round(r.duration_ms / 60000)} minutes (measured duration) — either the tool hung or it was waiting on a human.`,
    observed: r.duration_ms,
    baseline: null,
    threshold: 600000,
    confidence: 'exact' as const,
    source: 'live' as const,
    detected_at: now,
  }));
}

/** headless_bypass_launch: the Nx s1ngularity shape — an agent launched with
 *  permissions skipped from inside a session. */
function detectHeadlessBypass(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT tool_call_key, tool, session_id, ts FROM tool_calls
       WHERE shape LIKE '%dangerously-skip-permissions%'`,
    )
    .all() as { tool_call_key: string; tool: string; session_id: string | null; ts: number }[];
  return rows.map((r) => ({
    anomaly_key: `headless_bypass_launch:${r.tool_call_key}`,
    rule: 'headless_bypass_launch' as const,
    severity: 'critical' as const,
    tool: r.tool as Anomaly['tool'],
    session_id: r.session_id,
    model: null,
    window_start: r.ts,
    window_end: r.ts,
    title: 'Headless bypass launch',
    detail: 'A command launched a coding agent with --dangerously-skip-permissions — the s1ngularity shape. Every tool call it makes is pre-authorised by construction.',
    observed: 1,
    baseline: null,
    threshold: null,
    confidence: 'exact' as const,
    source: 'live' as const,
    detected_at: now,
  }));
}

/** The registry: run every ledger rule. */
export function detectLedgerRules(db: DB, now = Date.now()): Anomaly[] {
  return [
    ...detectDeniedThenAchieved(db, now),
    ...detectShapeRules(db, now),
    ...detectFailureStorms(db, now),
    ...detectStuckCalls(db, now),
    ...detectHeadlessBypass(db, now),
  ];
}
