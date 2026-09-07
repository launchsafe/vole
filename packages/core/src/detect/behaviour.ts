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

/** sensitive_read_unasked: a sensitive-path access with no recorded grant. */
function detectSensitiveReads(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT tool_call_key, tool, name, shape, session_id, ts FROM tool_calls
       WHERE shape LIKE '%[sensitive%' AND status IS NOT NULL
       ORDER BY ts DESC LIMIT 200`,
    )
    .all() as CallRow[];
  const out: Anomaly[] = [];
  for (const r of rows) {
    out.push({
      anomaly_key: `sensitive_read_unasked:${r.tool_call_key}`,
      rule: 'sensitive_read_unasked',
      severity: 'warn',
      tool: r.tool as Anomaly['tool'],
      session_id: r.session_id,
      model: null,
      window_start: r.ts,
      window_end: r.ts,
      title: `Sensitive path accessed: ${r.shape?.split(' [')[0] ?? r.name}`,
      detail:
        `A ${r.name} call touched a sensitive path (ssh keys, credentials or .env — the path is the signal, the content is never stored) ` +
        `with no recorded grant. Session ${r.session_id?.slice(0, 8) ?? 'unknown'}.`,
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

/** agent_wrote_persistence: a write into launchd/cron territory. */
function detectPersistenceWrites(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT tool_call_key, tool, name, shape, session_id, ts FROM tool_calls
       WHERE shape LIKE '%[persistence%' ORDER BY ts DESC LIMIT 100`,
    )
    .all() as CallRow[];
  return rows.map((r) => ({
    anomaly_key: `agent_wrote_persistence:${r.tool_call_key}`,
    rule: 'agent_wrote_persistence' as const,
    severity: 'critical' as const,
    tool: r.tool as Anomaly['tool'],
    session_id: r.session_id,
    model: null,
    window_start: r.ts,
    window_end: r.ts,
    title: `Persistence write: ${r.shape?.split(' [')[0] ?? r.name}`,
    detail:
      `A command wrote into LaunchAgents/LaunchDaemons territory — code that will run on every login. ` +
      `Session ${r.session_id?.slice(0, 8) ?? 'unknown'}. The shape is recorded, never the command.`,
    observed: 1,
    baseline: null,
    threshold: null,
    confidence: 'exact' as const,
    source: 'live' as const,
    detected_at: now,
  }));
}

/** agent_self_authorised: the agent touched its own permission surface. */
function detectSelfAuthorised(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT tool_call_key, tool, name, shape, session_id, ts FROM tool_calls
       WHERE shape LIKE '%[own-permissions%' ORDER BY ts DESC LIMIT 100`,
    )
    .all() as CallRow[];
  return rows.map((r) => ({
    anomaly_key: `agent_self_authorised:${r.tool_call_key}`,
    rule: 'agent_self_authorised' as const,
    severity: 'critical' as const,
    tool: r.tool as Anomaly['tool'],
    session_id: r.session_id,
    model: null,
    window_start: r.ts,
    window_end: r.ts,
    title: `Agent touched its own permissions`,
    detail:
      `A ${r.name} call accessed the agent's own permission/settings files (${r.shape?.split(' [')[0] ?? 'settings'}) — ` +
      `the agent may be editing its own guardrails. Session ${r.session_id?.slice(0, 8) ?? 'unknown'}.`,
    observed: 1,
    baseline: null,
    threshold: null,
    confidence: 'exact' as const,
    source: 'live' as const,
    detected_at: now,
  }));
}

/** denial_then_reshape: denied, then a DIFFERENT-args call with the same tool succeeded. */
function detectDenialThenReshape(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT d.tool, d.session_id, d.name, d.args_digest, d.ts AS denied_ts,
              a.ts AS ok_ts
       FROM tool_calls d
       JOIN tool_calls a
         ON a.session_id = d.session_id AND a.name = d.name
        AND a.args_digest IS NOT NULL AND a.args_digest != d.args_digest
        AND a.status = 'success' AND a.ts > d.ts AND a.ts - d.ts < 1800000
       WHERE d.status = 'denied' AND d.args_digest IS NOT NULL
       ORDER BY d.ts`,
    )
    .all() as { tool: string; session_id: string | null; name: string; args_digest: string; denied_ts: number; ok_ts: number }[];
  const seen = new Set<string>();
  const out: Anomaly[] = [];
  for (const r of rows) {
    const key = `denial_then_reshape:${r.tool}:${r.session_id ?? 'none'}:${r.name}:${r.denied_ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      anomaly_key: key,
      rule: 'denial_then_reshape',
      severity: 'warn',
      tool: r.tool as Anomaly['tool'],
      session_id: r.session_id,
      model: null,
      window_start: r.denied_ts,
      window_end: r.ok_ts,
      title: `Denial then reshape: ${r.name}`,
      detail:
        `A ${r.name} call was denied; a different ${r.name} call (different arguments) succeeded ` +
        `${Math.round((r.ok_ts - r.denied_ts) / 1000)}s later in the same session — the agent may have ` +
        `worked around the denial by reshaping the request.`,
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

/** scope_drift: a session that worked in a second repository. */
function detectScopeDrift(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT session_id, COUNT(DISTINCT project) AS projects, MIN(project) AS first_p, MAX(project) AS second_p, MIN(ts) AS lo, MAX(ts) AS hi
       FROM usage_events WHERE session_id IS NOT NULL AND project IS NOT NULL AND source = 'live'
       GROUP BY session_id HAVING projects > 1`,
    )
    .all() as { session_id: string; projects: number; first_p: string; second_p: string; lo: number; hi: number }[];
  return rows.map((r) => ({
    anomaly_key: `scope_drift:${r.session_id}`,
    rule: 'scope_drift' as const,
    severity: 'info' as const,
    tool: 'claude_code' as const,
    session_id: r.session_id,
    model: null,
    window_start: r.lo,
    window_end: r.hi,
    title: `Scope drift: session spanned ${r.projects} projects`,
    detail: `A single session worked in multiple directories (${r.first_p} → ${r.second_p}) — check that the second scope was intended.`,
    observed: r.projects,
    baseline: null,
    threshold: 1,
    confidence: 'exact' as const,
    source: 'live' as const,
    detected_at: now,
  }));
}

/** remote_database: psql/mysql shapes — data leaving to a database. */
function detectRemoteDatabase(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT tool_call_key, tool, session_id, shape, ts FROM tool_calls
       WHERE shape LIKE 'psql%' OR shape LIKE 'mysql%' ORDER BY ts DESC LIMIT 100`,
    )
    .all() as (CallRow & { shape: string })[];
  return rows.map((r) => ({
    anomaly_key: `remote_database:${r.tool_call_key}`,
    rule: 'remote_database' as const,
    severity: 'warn' as const,
    tool: r.tool as Anomaly['tool'],
    session_id: r.session_id,
    model: null,
    window_start: r.ts,
    window_end: r.ts,
    title: `Database access: ${r.shape}`,
    detail: `A ${r.shape} command ran — the agent touched a database. The shape is recorded, never the command.`,
    observed: 1,
    baseline: null,
    threshold: null,
    confidence: 'exact' as const,
    source: 'live' as const,
    detected_at: now,
  }));
}

/** install_after_ingress: a download followed by an execution of what came in. */
function detectInstallAfterIngress(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT f.session_id, f.ts AS fetch_ts, i.ts AS install_ts, i.shape
       FROM tool_calls f
       JOIN tool_calls i
         ON i.session_id = f.session_id AND i.ts > f.ts AND i.ts - f.ts < 600000
        AND (i.shape LIKE 'npm install%' OR i.shape LIKE 'pip install%' OR i.shape LIKE 'curl%' OR i.shape LIKE 'sh %')
       WHERE f.shape LIKE 'curl%' AND f.session_id IS NOT NULL
       ORDER BY f.ts DESC LIMIT 50`,
    )
    .all() as { session_id: string; fetch_ts: number; install_ts: number; shape: string }[];
  const seen = new Set<string>();
  const out: Anomaly[] = [];
  for (const r of rows) {
    const key = `install_after_ingress:${r.session_id}:${r.fetch_ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      anomaly_key: key,
      rule: 'install_after_ingress',
      severity: 'warn',
      tool: 'claude_code' as const,
      session_id: r.session_id,
      model: null,
      window_start: r.fetch_ts,
      window_end: r.install_ts,
      title: `Download then install: ${r.shape}`,
      detail: `A curl fetch was followed within 10 minutes by '${r.shape}' in the same session — untrusted bytes may have been executed. Shapes only, never the URLs.`,
      observed: r.install_ts - r.fetch_ts,
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }
  return out;
}

/** unattended_run: a session ran ≥20 tool calls with no human-visible gap. */
function detectUnattendedRuns(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT session_id, COUNT(*) AS calls, MIN(ts) AS lo, MAX(ts) AS hi
       FROM tool_calls WHERE session_id IS NOT NULL
       GROUP BY session_id HAVING calls >= 20 AND hi - lo > 600000`,
    )
    .all() as { session_id: string; calls: number; lo: number; hi: number }[];
  return rows.map((r) => ({
    anomaly_key: `unattended_run:${r.session_id}`,
    rule: 'unattended_run' as const,
    severity: 'info' as const,
    tool: 'claude_code' as const,
    session_id: r.session_id,
    model: null,
    window_start: r.lo,
    window_end: r.hi,
    title: `Unattended run: ${r.calls} calls over ${Math.round((r.hi - r.lo) / 60000)} min`,
    detail: `${r.calls} tool calls ran for ${Math.round((r.hi - r.lo) / 60000)} minutes in one session — possibly without a human present. Duration evidence, not proof.`,
    observed: r.calls,
    baseline: null,
    threshold: 20,
    confidence: 'exact' as const,
    source: 'live' as const,
    detected_at: now,
  }));
}

/** context_edges: curl to external endpoints — where untrusted bytes came in. */
function detectContextEdges(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT tool_call_key, tool, session_id, ts, shape FROM tool_calls
       WHERE shape LIKE 'curl%' AND shape NOT LIKE '%[sensitive%'
       ORDER BY ts DESC LIMIT 100`,
    )
    .all() as (CallRow & { shape: string })[];
  const seen = new Set<string>();
  const out: Anomaly[] = [];
  for (const r of rows) {
    // one incident per session per hour
    const key = `context_edges:${r.session_id}:${Math.floor(r.ts / 3600000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      anomaly_key: key,
      rule: 'context_edges',
      severity: 'info',
      tool: r.tool as Anomaly['tool'],
      session_id: r.session_id,
      model: null,
      window_start: r.ts,
      window_end: r.ts,
      title: `External fetch in session`,
      detail: `A curl command ran in session ${r.session_id?.slice(0, 8) ?? 'unknown'} — untrusted web bytes entered the agent's context. Shape recorded, never the URL.`,
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

/** subagent_inherited_bypass: a headless session's subagents inherit autonomy. */
function detectSubagentBypass(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT tc.session_id, tc.agent_id
       FROM tool_calls tc
       JOIN tool_calls h ON h.session_id = tc.session_id
         AND h.shape LIKE '%dangerously-skip-permissions%'
       WHERE tc.agent_id IS NOT NULL AND tc.agent_id != 'main'`,
    )
    .all() as { session_id: string; agent_id: string }[];
  return rows.map((r) => ({
    anomaly_key: `subagent_inherited_bypass:${r.session_id}:${r.agent_id}`,
    rule: 'subagent_inherited_bypass' as const,
    severity: 'warn' as const,
    tool: 'claude_code' as const,
    session_id: r.session_id,
    model: null,
    window_start: now,
    window_end: now,
    title: `Subagent inherited bypass: ${r.agent_id.slice(0, 12)}`,
    detail: `A session launched with permissions skipped, and subagent ${r.agent_id.slice(0, 12)} ran within it — the bypass propagated down the agent tree by construction.`,
    observed: 1,
    baseline: null,
    threshold: null,
    confidence: 'exact' as const,
    source: 'live' as const,
    detected_at: now,
  }));
}

/** cross_scope_read_then_publish: sensitive read followed by remote execution. */
function detectCrossScope(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT s.session_id, s.ts AS read_ts, r.ts AS pub_ts, r.shape AS pub_shape
       FROM tool_calls s
       JOIN tool_calls r ON r.session_id = s.session_id
         AND r.ts > s.ts AND r.ts - s.ts < 1800000
         AND (r.shape LIKE 'ssh%' OR r.shape LIKE 'scp%' OR r.shape LIKE 'curl%')
       WHERE s.shape LIKE '%[sensitive%'
       ORDER BY s.ts DESC LIMIT 50`,
    )
    .all() as { session_id: string; read_ts: number; pub_ts: number; pub_shape: string }[];
  const seen = new Set<string>();
  const out: Anomaly[] = [];
  for (const r of rows) {
    const key = `cross_scope:${r.session_id}:${Math.floor(r.read_ts / 3600000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      anomaly_key: key,
      rule: 'cross_scope_read_then_publish',
      severity: 'critical',
      tool: 'claude_code' as const,
      session_id: r.session_id,
      model: null,
      window_start: r.read_ts,
      window_end: r.pub_ts,
      title: 'Sensitive read then remote execution',
      detail: `A sensitive-path read was followed within 30 min by a remote command (${r.pub_shape}) in the same session — data may have left the laptop. Shapes only; nothing typed is stored.`,
      observed: r.pub_ts - r.read_ts,
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }
  return out;
}

/** vcs_action: git operations that change state (push/reset/clean). */
function detectVcsActions(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT tool_call_key, tool, session_id, shape, ts FROM tool_calls
       WHERE shape LIKE 'git push%' OR shape LIKE 'git reset%' OR shape LIKE 'git clean%'
       ORDER BY ts DESC LIMIT 100`,
    )
    .all() as (CallRow & { shape: string })[];
  const seen = new Set<string>();
  const out: Anomaly[] = [];
  for (const r of rows) {
    const key = `vcs_action:${r.session_id}:${Math.floor(r.ts / 3600000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      anomaly_key: key,
      rule: 'vcs_action',
      severity: 'info',
      tool: r.tool as Anomaly['tool'],
      session_id: r.session_id,
      model: null,
      window_start: r.ts,
      window_end: r.ts,
      title: `State-changing git: ${r.shape}`,
      detail: `A ${r.shape} ran — repository state changed (pushed, reset or cleaned). Session ${r.session_id?.slice(0, 8) ?? 'unknown'}.`,
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

/** fetch_ingress: bytes entering the session from the web. */
function detectFetchIngress(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT session_id, COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi
       FROM tool_calls WHERE shape LIKE 'curl%' OR name IN ('WebFetch', 'Fetch')
       GROUP BY session_id HAVING n >= 1`,
    )
    .all() as { session_id: string | null; n: number; lo: number; hi: number }[];
  const out: Anomaly[] = [];
  for (const r of rows) {
    if (!r.session_id) continue;
    out.push({
      anomaly_key: `fetch_ingress:${r.session_id}`,
      rule: 'fetch_ingress',
      severity: 'info',
      tool: 'claude_code' as const,
      session_id: r.session_id,
      model: null,
      window_start: r.lo,
      window_end: r.hi,
      title: `Web ingress: ${r.n} fetch(es) entered the session`,
      detail: `${r.n} web fetch(es) brought untrusted bytes into the agent's context — the prompt-injection surface. URLs are never stored; the shape is the fact.`,
      observed: r.n,
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }
  return out;
}

/** human-interrupt ledger: AskUserQuestion pauses — where the human was in the loop. */
function detectHumanInterrupts(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT session_id, COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi FROM tool_calls
       WHERE name IN ('AskUserQuestion', 'AskUser', 'request_human_input')
       GROUP BY session_id`,
    )
    .all() as { session_id: string | null; n: number; lo: number; hi: number }[];
  const out: Anomaly[] = [];
  for (const r of rows) {
    if (!r.session_id) continue;
    out.push({
      anomaly_key: `human_interrupt:${r.session_id}`,
      rule: 'human_interrupt',
      severity: 'info',
      tool: 'claude_code' as const,
      session_id: r.session_id,
      model: null,
      window_start: r.lo,
      window_end: r.hi,
      title: `Human in the loop: ${r.n} interruption(s)`,
      detail: `${r.n} AskUserQuestion pauses in this session — the human was consulted. This is the evidence that separates supervised from unattended work.`,
      observed: r.n,
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }
  return out;
}

/** The autonomy intervals table: posture as a timeline, filled from the ledger. */
export function buildAutonomyIntervals(db: DB): number {
  db.exec('DELETE FROM autonomy_intervals');
  const rows = db
    .prepare(
      `INSERT INTO autonomy_intervals (session_id, agent_id, started_at, ended_at, calls, denied, errors)
       SELECT session_id, COALESCE(agent_id, 'main'), MIN(ts), MAX(ts), COUNT(*),
              SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END),
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)
       FROM tool_calls WHERE session_id IS NOT NULL
       GROUP BY session_id, COALESCE(agent_id, 'main')`,
    )
    .run();
  return rows.changes;
}

/** session_identity: bind sessions to principals, with evidence rank. */
export function buildSessionIdentity(db: DB, principalKey: string, deviceKey: string): number {
  const now = Date.now();
  const upsert = db.prepare(`
    INSERT INTO session_identity (session_id, principal_key, device_key, binding_evidence, first_seen, last_seen)
    VALUES (?, ?, ?, 'store_origin', ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET last_seen = excluded.last_seen`);
  const sessions = db
    .prepare("SELECT DISTINCT session_id FROM usage_events WHERE session_id IS NOT NULL AND source = 'live' LIMIT 2000")
    .all() as { session_id: string }[];
  for (const s of sessions) upsert.run(s.session_id, principalKey, deviceKey, now, now);
  return sessions.length;
}

/** agent_pushed_data_off_device: scp/rsync/cp into a remote or unmonitored context. */
function detectPushedData(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT tool_call_key, tool, session_id, shape, ts FROM tool_calls
       WHERE shape LIKE 'scp%' OR shape LIKE 'rsync%'
       ORDER BY ts DESC LIMIT 50`,
    )
    .all() as (CallRow & { shape: string })[];
  const seen = new Set<string>();
  const out: Anomaly[] = [];
  for (const r of rows) {
    const key = `agent_pushed:${r.session_id}:${Math.floor(r.ts / 3600000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      anomaly_key: key,
      rule: 'agent_pushed_data_off_device',
      severity: 'warn',
      tool: r.tool as Anomaly['tool'],
      session_id: r.session_id,
      model: null,
      window_start: r.ts,
      window_end: r.ts,
      title: `Data pushed off device: ${r.shape}`,
      detail: `A ${r.shape} command ran — files left this laptop. The shape is the fact; the file names are never stored.`,
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

/** remote_privileged_exec: ssh + sudo/docker/kubectl — privileged remote code. */
function detectPrivilegedRemote(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT tool_call_key, tool, session_id, shape, ts FROM tool_calls
       WHERE (shape LIKE 'ssh%sudo%' OR shape LIKE 'docker exec%' OR shape LIKE 'kubectl exec%')
       ORDER BY ts DESC LIMIT 50`,
    )
    .all() as (CallRow & { shape: string })[];
  return rows.map((r) => ({
    anomaly_key: `remote_privileged_exec:${r.tool_call_key}`,
    rule: 'remote_privileged_exec' as const,
    severity: 'critical' as const,
    tool: r.tool as Anomaly['tool'],
    session_id: r.session_id,
    model: null,
    window_start: r.ts,
    window_end: r.ts,
    title: `Privileged remote execution: ${r.shape}`,
    detail: `A ${r.shape} command ran — code executed on another system with elevated rights. Session ${r.session_id?.slice(0, 8) ?? 'unknown'}.`,
    observed: 1,
    baseline: null,
    threshold: null,
    confidence: 'exact' as const,
    source: 'live' as const,
    detected_at: now,
  }));
}

/** destructive_schema_change: DROP TABLE / TRUNCATE / DELETE FROM in database commands. */
function detectSchemaChange(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT tool_call_key, tool, session_id, shape, ts FROM tool_calls
       WHERE shape LIKE 'psql -c%' AND (
         instr(lower(COALESCE(shape, '')), 'drop') > 0 OR
         instr(lower(COALESCE(shape, '')), 'truncate') > 0
       ) OR name = 'execute_sql' AND shape IS NOT NULL
       ORDER BY ts DESC LIMIT 20`,
    )
    .all() as (CallRow & { shape: string })[];
  return rows.map((r) => ({
    anomaly_key: `destructive_schema_change:${r.tool_call_key}`,
    rule: 'destructive_schema_change' as const,
    severity: 'critical' as const,
    tool: r.tool as Anomaly['tool'],
    session_id: r.session_id,
    model: null,
    window_start: r.ts,
    window_end: r.ts,
    title: `Destructive database change: ${r.shape}`,
    detail: `A database command with schema-destructive potential ran. The shape is recorded; the SQL text is never stored.`,
    observed: 1,
    baseline: null,
    threshold: null,
    confidence: 'exact' as const,
    source: 'live' as const,
    detected_at: now,
  }));
}

/** paged_bulk_read: the agent read a directory wholesale. */
function detectPagedBulkRead(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT session_id, COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi
       FROM tool_calls WHERE name IN ('Read', 'Glob', 'Grep', 'read_file')
         AND ts > ?
       GROUP BY session_id HAVING n >= 30`,
    )
    .all(now - 24 * 3600_000) as { session_id: string | null; n: number; lo: number; hi: number }[];
  return rows.filter((r) => r.session_id).map((r) => ({
    anomaly_key: `paged_bulk_read:${r.session_id}`,
    rule: 'paged_bulk_read' as const,
    severity: 'info' as const,
    tool: 'claude_code' as const,
    session_id: r.session_id,
    model: null,
    window_start: r.lo,
    window_end: r.hi,
    title: `Bulk read: ${r.n} file accesses in one session`,
    detail: `${r.n} read/glob/grep calls in 24h — the agent read a large surface. Not inherently wrong, but the per-call view cannot see it; only the ledger can.`,
    observed: r.n,
    baseline: null,
    threshold: 30,
    confidence: 'exact' as const,
    source: 'live' as const,
    detected_at: now,
  }));
}

/** daily exposure rollup: the autonomy clock — unattended minutes per day. */
function detectDailyExposure(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT session_id, agent_id, started_at, ended_at, calls FROM autonomy_intervals
       WHERE ended_at - started_at > 300000`,
    )
    .all() as { session_id: string; agent_id: string | null; started_at: number; ended_at: number; calls: number }[];
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const day = Math.floor(r.started_at / 86400000);
    byDay.set(String(day), (byDay.get(String(day)) ?? 0) + (r.ended_at - r.started_at));
  }
  const out: Anomaly[] = [];
  for (const [day, ms] of byDay) {
    if (ms < 600000) continue; // ≥10 min of agent-run time
    out.push({
      anomaly_key: `daily_exposure:${day}`,
      rule: 'daily_exposure_rollup',
      severity: 'info',
      tool: 'claude_code' as const,
      session_id: null,
      model: null,
      window_start: Number(day) * 86400000,
      window_end: Number(day) * 86400000 + 86400000,
      title: `Agent autonomy: ${Math.round(ms / 60000)} min on this day`,
      detail: `Across all sessions, agents ran for ${Math.round(ms / 60000)} minutes of active tool time — the autonomy clock. Human presence is not implied by activity; only AskUserQuestion pauses are.`,
      observed: ms,
      baseline: null,
      threshold: 600000,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }
  return out;
}

/** tool_first_seen: a tool name appears for the first time — the MCP dimension. */
function detectToolFirstSeen(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT name, MIN(ts) AS first FROM tool_calls GROUP BY name
       HAVING first > ?`,
    )
    .all(now - 7 * 24 * 3600_000) as { name: string; first: number }[];
  return rows.map((r) => ({
    anomaly_key: `tool_first_seen:${r.name}`,
    rule: 'tool_first_seen' as const,
    severity: 'info' as const,
    tool: 'claude_code' as const,
    session_id: null,
    model: null,
    window_start: r.first,
    window_end: r.first,
    title: `New tool surface: ${r.name}`,
    detail: `The ledger's first sighting of "${r.name}" was ${new Date(r.first).toISOString()}. A tool nobody has used before is a capability that just appeared.`,
    observed: 1,
    baseline: null,
    threshold: null,
    confidence: 'exact' as const,
    source: 'live' as const,
    detected_at: now,
  }));
}

/** posture_escalated: within a session, authority moved from gated to bypass. */
function detectPostureEscalated(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(
      `SELECT d.session_id, d.ts AS denied_ts, h.ts AS bypass_ts
       FROM tool_calls d
       JOIN tool_calls h ON h.session_id = d.session_id
         AND h.shape LIKE '%dangerously-skip-permissions%'
         AND h.ts > d.ts
       WHERE d.status = 'denied' ORDER BY d.ts LIMIT 20`,
    )
    .all() as { session_id: string; denied_ts: number; bypass_ts: number }[];
  const seen = new Set<string>();
  const out: Anomaly[] = [];
  for (const r of rows) {
    const key = `posture_escalated:${r.session_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      anomaly_key: key,
      rule: 'posture_escalated',
      severity: 'critical',
      tool: 'claude_code' as const,
      session_id: r.session_id,
      model: null,
      window_start: r.denied_ts,
      window_end: r.bypass_ts,
      title: 'Posture escalated within session',
      detail: `A call was denied, then the session launched with --dangerously-skip-permissions — the guardrails came off mid-session. The strongest bypass signal the ledger can produce.`,
      observed: r.bypass_ts - r.denied_ts,
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }
  return out;
}

/** The registry: run every ledger rule. */
export const LEDGER_RULE_IDS = [
  'denied_then_achieved', 'denial_then_reshape', 'remote_execution', 'remote_privileged_exec',
  'destructive_command', 'destructive_schema_change', 'tool_failure_storm', 'stuck_tool_call',
  'headless_bypass_launch', 'sensitive_read_unasked', 'agent_wrote_persistence',
  'agent_self_authorised', 'scope_drift', 'remote_database', 'install_after_ingress',
  'unattended_run', 'context_edges', 'subagent_inherited_bypass', 'cross_scope_read_then_publish',
  'vcs_action', 'fetch_ingress', 'human_interrupt', 'agent_pushed_data_off_device',
  'paged_bulk_read', 'daily_exposure_rollup', 'tool_first_seen', 'posture_escalated',
] as const;

export function detectLedgerRules(db: DB, now = Date.now()): Anomaly[] {
  return [
    ...detectToolFirstSeen(db, now),
    ...detectPostureEscalated(db, now),
    ...detectPushedData(db, now),
    ...detectPrivilegedRemote(db, now),
    ...detectSchemaChange(db, now),
    ...detectPagedBulkRead(db, now),
    ...detectDailyExposure(db, now),
    ...detectDeniedThenAchieved(db, now),
    ...detectShapeRules(db, now),
    ...detectFailureStorms(db, now),
    ...detectStuckCalls(db, now),
    ...detectHeadlessBypass(db, now),
    ...detectSensitiveReads(db, now),
    ...detectPersistenceWrites(db, now),
    ...detectSelfAuthorised(db, now),
    ...detectDenialThenReshape(db, now),
    ...detectScopeDrift(db, now),
    ...detectRemoteDatabase(db, now),
    ...detectInstallAfterIngress(db, now),
    ...detectUnattendedRuns(db, now),
    ...detectContextEdges(db, now),
    ...detectSubagentBypass(db, now),
    ...detectCrossScope(db, now),
    ...detectVcsActions(db, now),
    ...detectFetchIngress(db, now),
    ...detectHumanInterrupts(db, now),
  ];
}
