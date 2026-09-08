import type { DB } from '../db';
import { autonomyFor } from './bind';

/**
 * autonomy_intervals rebuilt as a real posture timeline (feature 2): one row
 * per contiguous run of a constant posture per (session, agent), widened with
 * mode_raw / autonomy / fs_policy from the parsed permissionMode /
 * approval_policy / sandbox_policy the collectors stamp on tool_calls. A tool
 * call joins to the interval in force at its own timestamp — not one
 * session-level label.
 *
 * Claude's permission-mode transitions mostly carry no timestamp of their own,
 * so the collector bounds them by the neighbouring calls: a call before the
 * first stamp stays unknown (NULL mode_raw) — never 'default'.
 */

export interface AutonomyIntervalRow {
  session_id: string;
  agent_id: string | null;
  started_at: number;
  ended_at: number;
  calls: number;
  denied: number;
  errors: number;
  mode_raw: string | null;
  autonomy: string | null;
  fs_policy: string | null;
  approval_policy: string | null;
  sandbox_policy: string | null;
  permission_profile: string | null;
}

interface Observation {
  ts: number;
  mode_raw: string | null;
  status: string | null;
}

/** Build contiguous posture runs from (ts, mode_raw, status) observations. */
export function buildIntervalRuns(
  obs: Observation[],
  session_id: string,
  agent_id: string | null,
  posture?: { approval_policy?: string | null; sandbox_policy?: string | null; permission_profile?: string | null },
): AutonomyIntervalRow[] {
  const sorted = [...obs].sort((a, b) => a.ts - b.ts);
  const out: AutonomyIntervalRow[] = [];
  let cur: { start: number; end: number; mode_raw: string | null; calls: number; denied: number; errors: number } | null = null;
  const finish = (): void => {
    if (!cur) return;
    out.push({
      session_id,
      agent_id,
      started_at: cur.start,
      ended_at: cur.end,
      calls: cur.calls,
      denied: cur.denied,
      errors: cur.errors,
      mode_raw: cur.mode_raw,
      autonomy: autonomyFor(cur.mode_raw)?.autonomy ?? null,
      fs_policy: null, // Claude declares no fs policy; Codex's lives in sandbox_policy
      approval_policy: posture?.approval_policy ?? null,
      sandbox_policy: posture?.sandbox_policy ?? null,
      permission_profile: posture?.permission_profile ?? null,
    });
  };
  for (const o of sorted) {
    if (!cur || cur.mode_raw !== o.mode_raw) {
      finish();
      cur = { start: o.ts, end: o.ts, mode_raw: o.mode_raw, calls: 0, denied: 0, errors: 0 };
    }
    cur.end = o.ts;
    cur.calls++;
    if (o.status === 'denied') cur.denied++;
    if (o.status === 'error') cur.errors++;
  }
  finish();
  return out;
}

const INTERVAL_UPSERT = `
INSERT INTO autonomy_intervals (
  session_id, agent_id, started_at, ended_at, calls, denied, errors,
  mode_raw, autonomy, fs_policy, approval_policy, sandbox_policy, permission_profile
) VALUES (
  @session_id, @agent_id, @started_at, @ended_at, @calls, @denied, @errors,
  @mode_raw, @autonomy, @fs_policy, @approval_policy, @sandbox_policy, @permission_profile
)
ON CONFLICT(session_id, agent_id, started_at) DO UPDATE SET
  ended_at  = MAX(autonomy_intervals.ended_at, excluded.ended_at),
  calls     = MAX(autonomy_intervals.calls, excluded.calls),
  denied    = MAX(autonomy_intervals.denied, excluded.denied),
  errors    = MAX(autonomy_intervals.errors, excluded.errors),
  mode_raw         = COALESCE(autonomy_intervals.mode_raw, excluded.mode_raw),
  autonomy         = COALESCE(autonomy_intervals.autonomy, excluded.autonomy),
  fs_policy        = COALESCE(autonomy_intervals.fs_policy, excluded.fs_policy),
  approval_policy  = COALESCE(autonomy_intervals.approval_policy, excluded.approval_policy),
  sandbox_policy   = COALESCE(autonomy_intervals.sandbox_policy, excluded.sandbox_policy),
  permission_profile = COALESCE(autonomy_intervals.permission_profile, excluded.permission_profile)
WHERE excluded.calls > autonomy_intervals.calls
   OR excluded.ended_at > autonomy_intervals.ended_at
   OR (autonomy_intervals.mode_raw IS NULL AND excluded.mode_raw IS NOT NULL)
   OR (autonomy_intervals.autonomy IS NULL AND excluded.autonomy IS NOT NULL)`;

/**
 * Bind interval rows. Aggregate counts use MAX (they only grow as more source
 * is read); the posture columns widen NULL-only, so a stored fact from a
 * richer source is never re-derived away.
 */
export function insertAutonomyIntervals(db: DB, rows: AutonomyIntervalRow[]): number {
  if (!rows.length) return 0;
  const stmt = db.prepare(INTERVAL_UPSERT);
  const run = db.transaction((batch: AutonomyIntervalRow[]) => {
    let changed = 0;
    for (const r of batch) {
      changed += stmt.run({
        session_id: r.session_id,
        // The table's own precedent: main-thread rows key as 'main' — a NULL
        // here would defeat the UNIQUE(session, agent, started_at) conflict
        // detection and break idempotency (NULL != NULL in SQLite).
        agent_id: r.agent_id ?? 'main',
        started_at: r.started_at,
        ended_at: r.ended_at,
        calls: r.calls,
        denied: r.denied,
        errors: r.errors,
        mode_raw: r.mode_raw,
        autonomy: r.autonomy,
        fs_policy: r.fs_policy,
        approval_policy: r.approval_policy,
        sandbox_policy: r.sandbox_policy,
        permission_profile: r.permission_profile,
      }).changes;
    }
    return changed;
  });
  return run(rows);
}

/**
 * Full rebuild from tool_calls' permission_mode stamps: contiguous runs per
 * (session, agent), each call joining the posture in force at its own ts.
 * (The detect-side DELETE+rebuild must switch to this — see integration notes.)
 */
export function rebuildAutonomyIntervals(db: DB): number {
  const rows = db
    .prepare(
      `SELECT session_id, agent_id, ts, permission_mode AS mode_raw, status FROM tool_calls
       WHERE session_id IS NOT NULL
       ORDER BY session_id, COALESCE(agent_id, 'main'), ts`,
    )
    .all() as { session_id: string; agent_id: string | null; ts: number; mode_raw: string | null; status: string | null }[];

  const groups = new Map<string, { session_id: string; agent_id: string | null; obs: Observation[] }>();
  for (const r of rows) {
    const key = `${r.session_id} ${r.agent_id ?? 'main'}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { session_id: r.session_id, agent_id: r.agent_id, obs: [] }));
    g.obs.push({ ts: r.ts, mode_raw: r.mode_raw, status: r.status });
  }
  const out: AutonomyIntervalRow[] = [];
  for (const g of groups.values()) {
    out.push(...buildIntervalRuns(g.obs, g.session_id, g.agent_id));
  }
  return insertAutonomyIntervals(db, out);
}
