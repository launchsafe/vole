import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db';
import type { Anomaly } from '../types';
import { paths } from '../paths';
import { detectLedgerRepeatLoops } from './loop';
import {
  applyPostureWeight,
  autonomyChains,
  callsPerHumanTurn,
  longestChain,
  normalizeAutonomy,
  rankOf,
} from './rules/posture-weight';
import { pairCrossScope, pairDeniedThenAchieved, pairDenialThenReshape, type PairCall } from './rules/call-pairing';
import { scanInterruptMarkers } from './rules/interrupts';
import {
  diffWatchedKeys,
  readIfExists,
  sha256Of,
  watchedConfigPaths,
  watchedKeyFacts,
  type WatchedKeyFact,
} from './rules/permission-keys';

/**
 * The ledger-native behaviour rules — everything the usage_events view could
 * never see, because the question is about INVOCATIONS, not meters: what was
 * denied then achieved anyway, what runs remote, what failed in a storm, what
 * hung, what was destructive, what launched headless with permissions skipped.
 *
 * These rules read the store directly (the ledger is the substrate; pure-array
 * plumbing would just copy it). Every anomaly_key is stable, so re-runs are
 * idempotent, and no key contains a now()-derived value — UTC bucket epochs of
 * observed timestamps are the only time components.
 *
 * Where a fact needs the collector's raw arguments (destinations, object names,
 * statement classes, scopes, target hashes), the rule reads the net ledgers
 * (toolcalls/net-ledgers.ts) and degrades to the stored shape, saying 'not
 * recorded' rather than guessing.
 */

/** The one full-ledger scan most rules share, grouped per session. */
export interface CallLite {
  id: number;
  key: string;
  tool: string;
  name: string;
  /** The MCP-split tool name when collectors populate it; the raw name otherwise. */
  tn: string;
  shape: string | null;
  args_digest: string | null;
  session: string | null;
  agent: string | null;
  status: string | null;
  ts: number;
  origin_kind: string | null;
  permission_mode: string | null;
}

function loadCalls(db: DB): CallLite[] {
  return db
    .prepare(
      `SELECT id, tool_call_key AS key, tool, name, COALESCE(tool_name, name) AS tn, shape, args_digest,
              session_id AS session, agent_id AS agent, status, ts, origin_kind, permission_mode
       FROM tool_calls ORDER BY id`,
    )
    .all() as CallLite[];
}

function bySession(calls: CallLite[]): Map<string, CallLite[]> {
  const m = new Map<string, CallLite[]>();
  for (const c of calls) {
    if (!c.session) continue;
    const arr = m.get(c.session);
    if (arr) arr.push(c);
    else m.set(c.session, [c]);
  }
  return m;
}

function anom(p: {
  key: string;
  rule: Anomaly['rule'];
  severity: Anomaly['severity'];
  tool?: string | null;
  session?: string | null;
  ws: number;
  we: number;
  title: string;
  detail: string;
  observed: number;
  baseline?: number | null;
  threshold?: number | null;
  confidence?: Anomaly['confidence'];
}): Anomaly {
  return {
    anomaly_key: p.key,
    rule: p.rule,
    severity: p.severity,
    tool: (p.tool ?? 'claude_code') as Anomaly['tool'],
    session_id: p.session ?? null,
    model: null,
    window_start: p.ws,
    window_end: p.we,
    title: p.title,
    detail: p.detail,
    observed: p.observed,
    baseline: p.baseline ?? null,
    threshold: p.threshold ?? null,
    confidence: p.confidence ?? 'exact',
    source: 'live',
    detected_at: 0,
  };
}

// ── 27. denied_then_achieved / denial_then_reshape: the guardrail-bypass matcher

function detectDeniedPairs(sessions: Map<string, CallLite[]>, now: number): Anomaly[] {
  const out: Anomaly[] = [];
  for (const [session, calls] of sessions) {
    const pairCalls: PairCall[] = calls.map((c) => ({
      id: c.id, tool_call_key: c.key, tool: c.tool, name: c.name, shape: c.shape,
      args_digest: c.args_digest, status: c.status, ts: c.ts,
    }));
    const denied = pairCalls.filter((c) => c.status === 'denied');
    if (!denied.length) continue;

    const seen = new Set<string>();
    for (const p of pairDeniedThenAchieved(pairCalls)) {
      const key =
        p.kind === 'identical'
          ? `denied_then_achieved:${p.denied.tool}:${session}:${p.denied.args_digest}`
          : `denied_then_achieved:${p.denied.tool}:${session}:${p.denied.tool_call_key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const gap = p.achieved.id - p.denied.id;
      out.push(anom({
        key,
        rule: 'denied_then_achieved',
        severity: 'warn',
        tool: p.denied.tool,
        session,
        ws: p.denied.ts,
        we: p.achieved.ts,
        title: `Guardrail bypass: ${p.denied.name} denied, then achieved via ${p.achieved.name}`,
        detail:
          `A ${p.denied.name} call was denied; ${gap} calls later a ${p.kind === 'identical' ? 're-issue of the identical call' : `different tool (${p.achieved.name}) with the same ${p.target_class}`} succeeded ` +
          `in the same session. Shared target: ${p.target_class}. This is expected agent behaviour and not necessarily malicious — triage, don't panic. ` +
          `Full cross-tool target-hash pairing needs the collector-side target hash; the intent class is the coarse half the stored shape proves.`,
        observed: p.achieved.ts - p.denied.ts,
      }));
    }
    for (const p of pairDenialThenReshape(pairCalls)) {
      const key = `denial_then_reshape:${p.denied.tool}:${session}:${p.denied.name}:${p.denied.ts}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(anom({
        key,
        rule: 'denial_then_reshape',
        severity: 'warn',
        tool: p.denied.tool,
        session,
        ws: p.denied.ts,
        we: p.reshaped.ts,
        title: `Denial then reshape: ${p.denied.name}`,
        detail:
          `A ${p.denied.name} call was denied; a different ${p.denied.name} call (different arguments digest) succeeded ` +
          `${Math.round((p.reshaped.ts - p.denied.ts) / 1000)}s later in the same session — the agent may have worked around the denial by reshaping the request.`,
        observed: p.reshaped.ts - p.denied.ts,
      }));
    }
  }
  return out;
}

const REMOTE_SHAPES = /^(ssh|scp|rsync|docker exec|docker run|kubectl exec|kubectl apply)\b/;
const DESTRUCTIVE_SHAPES = /^(rm -rf|rm -fr|git reset --hard|git clean|truncate|shred|mkfs)\b/;

/** Remote-execution hops and destructive commands: shape-matched, never content. */
function detectShapeRules(calls: CallLite[]): Anomaly[] {
  const out: Anomaly[] = [];
  for (const r of calls) {
    const remote = r.shape !== null && REMOTE_SHAPES.test(r.shape);
    const destructive = r.shape !== null && DESTRUCTIVE_SHAPES.test(r.shape);
    if (!remote && !destructive) continue;
    out.push(anom({
      key: `${remote ? 'remote_execution' : 'destructive_command'}:${r.key}`,
      rule: remote ? 'remote_execution' : 'destructive_command',
      severity: remote ? 'warn' : 'critical',
      tool: r.tool,
      session: r.session,
      ws: r.ts,
      we: r.ts,
      title: remote ? `Remote execution: ${r.shape}` : `Destructive command: ${r.shape}`,
      detail: remote
        ? `A ${r.shape} command ran in session ${r.session?.slice(0, 8) ?? 'unknown'} — execution left this laptop. The shape is recorded, never the command string.`
        : `A ${r.shape} command ran in session ${r.session?.slice(0, 8) ?? 'unknown'}. The shape is recorded, never the command string.`,
      observed: 1,
    }));
  }
  return out;
}

// ── 34. tool_failure_storm: per tool_name, ratio over RECORDED outcomes only

function detectFailureStorms(calls: CallLite[], now: number): Anomaly[] {
  const groups = new Map<string, { tool: string; session: string; tn: string; failed: number; decided: number; unknown: number; n: number; lo: number; hi: number }>();
  for (const c of calls) {
    if (!c.session || c.ts < now - 7 * 24 * 3600_000) continue;
    const gk = `${c.tool}::${c.session}::${c.tn}`;
    let g = groups.get(gk);
    if (!g) {
      g = { tool: c.tool, session: c.session, tn: c.tn, failed: 0, decided: 0, unknown: 0, n: 0, lo: c.ts, hi: c.ts };
      groups.set(gk, g);
    }
    g.n++;
    g.lo = Math.min(g.lo, c.ts);
    g.hi = Math.max(g.hi, c.ts);
    if (c.status === 'error') {
      g.failed++;
      g.decided++;
    } else if (c.status !== null) g.decided++;
    else g.unknown++;
  }
  const out: Anomaly[] = [];
  for (const g of groups.values()) {
    if (g.failed < 5) continue;
    const ratio = g.decided > 0 ? g.failed / g.decided : null;
    if (ratio === null || ratio <= 0.2) continue;
    out.push(anom({
      key: `tool_failure_storm:${g.tool}:${g.session}:${g.tn}`,
      rule: 'tool_failure_storm',
      severity: 'warn',
      tool: g.tool,
      session: g.session,
      ws: g.lo,
      we: g.hi,
      title: `Failing tool: ${g.tn} — ${g.failed} failures`,
      detail:
        `${g.failed} failures of ${g.decided} calls with a recorded outcome (${Math.round(ratio * 100)}%) in session ${g.session.slice(0, 8)} — ` +
        `the tool named ${g.tn} is failing, not the session. ${g.unknown} calls in the window have no recorded outcome and are excluded from the ratio, never counted as success.`,
      observed: g.failed,
      threshold: 5,
    }));
  }
  return out;
}

// ── 37. stuck_tool_call: unbound outcomes + the per-session in-flight ceiling

const STALL_MS = 10 * 60_000;
const IN_FLIGHT_WINDOW = 30 * 60_000;

function detectStuckCalls(calls: CallLite[], now: number): Anomaly[] {
  const out: Anomaly[] = [];
  const sessions = bySession(calls);
  for (const [session, sc] of sessions) {
    const unbound = sc.filter((c) => c.status === null && now - c.ts > STALL_MS && sc.some((l) => l.ts > c.ts));
    if (!unbound.length) continue;

    // In-flight high-water mark: the most unbound calls ever overlapping in a
    // 30-minute window. ponytail: O(n log n) sweep; an interval tree if this
    // ever runs on sessions big enough to notice.
    const ts = unbound.map((u) => u.ts).sort((a, b) => a - b);
    let high = 1;
    for (let i = 0; i < ts.length; i++) {
      let j = i;
      while (j < ts.length && ts[j]! - ts[i]! <= IN_FLIGHT_WINDOW) j++;
      high = Math.max(high, j - i);
    }

    for (const u of unbound) {
      out.push(anom({
        key: `stuck_tool_call:unbound:${u.key}`,
        rule: 'stuck_tool_call',
        severity: 'warn',
        tool: u.tool,
        session,
        ws: u.ts,
        we: now,
        title: `No outcome recorded after ${Math.round((now - u.ts) / 60000)} min: ${u.name}`,
        detail:
          `A ${u.name} call was issued with no bound result ${Math.round((now - u.ts) / 60000)} minutes ago while the session kept issuing calls — ` +
          `'no outcome recorded', not 'still running': without PID liveness a stuck row cannot distinguish the two. ` +
          `Session in-flight high-water mark: ${high}.`,
        observed: now - u.ts,
        threshold: STALL_MS,
      }));
    }
  }
  return out;
}

function detectStuckMeasured(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(`SELECT tool, session_id, name, duration_ms, ts FROM tool_calls
       WHERE duration_ms > ? AND duration_kind = 'measured'`)
    .all(STALL_MS) as { tool: string; session_id: string | null; name: string; duration_ms: number; ts: number }[];
  return rows.map((r) =>
    anom({
      key: `stuck_tool_call:${r.tool}:${r.session_id ?? 'none'}:${r.ts}`,
      rule: 'stuck_tool_call',
      severity: 'warn',
      tool: r.tool,
      session: r.session_id,
      ws: r.ts,
      we: r.ts + r.duration_ms,
      title: `Stuck tool call: ${r.name} ran ${Math.round(r.duration_ms / 60000)} min`,
      detail: `A ${r.name} call ran for ${Math.round(r.duration_ms / 60000)} minutes (measured duration) — either the tool hung or it was waiting on a human.`,
      observed: r.duration_ms,
      threshold: STALL_MS,
    }),
  );
}

// ── 24. headless_bypass_launch: bypass posture + no human + manifest clause

function detectHeadlessBypass(sessions: Map<string, CallLite[]>, db: DB, now: number): Anomaly[] {
  const out: Anomaly[] = [];
  for (const [session, calls] of sessions) {
    const bypass = calls.filter((c) => c.permission_mode === 'bypassPermissions');
    const humans = calls.filter((c) => c.origin_kind === 'human');
    const first = calls[0];
    if (bypass.length && !humans.length && first) {
      const project = (db.prepare(`SELECT project FROM usage_events WHERE session_id = ? AND project IS NOT NULL LIMIT 1`).get(session) as { project: string } | undefined)?.project ?? null;
      let manifestClause = 'no package manifest found at the session cwd';
      if (project) {
        try {
          const mtime = statSync(join(project, 'package.json')).mtimeMs;
          const within = Math.abs(mtime - first.ts) < 10 * 60_000;
          manifestClause = within
            ? `package.json at the session cwd was modified within 10 min of the session start — the postinstall shape`
            : `package.json at the session cwd was NOT modified near the session start (clause only raises severity, never gates)`;
        } catch {
          manifestClause = 'no package.json at the session cwd';
        }
      }
      out.push(anom({
        key: `headless_bypass_launch:${session}`,
        rule: 'headless_bypass_launch',
        severity: 'critical',
        session,
        ws: first.ts,
        we: calls[calls.length - 1]!.ts,
        title: 'Headless, no human, full access',
        detail:
          `The session's observed permissionMode is bypassPermissions and the transcript holds zero origin.kind='human' entries: ` +
          `every call ran with no gate that could have stopped it. ${calls.length} tool calls. Entrypoint: not recorded (no column yet). ` +
          `Manifest clause: ${manifestClause}. Vole sees only the agent leg — the stealer payload and any exfiltration outside a tool call belong to EDR.`,
        observed: calls.length,
        threshold: 1,
      }));
    }
    // The launch-inside-a-session shape (an agent spawning another with --dangerously-skip-permissions).
    for (const c of calls) {
      if (c.shape && c.shape.includes('dangerously-skip-permissions')) {
        out.push(anom({
          key: `headless_bypass_launch:${c.key}`,
          rule: 'headless_bypass_launch',
          severity: 'critical',
          tool: c.tool,
          session,
          ws: c.ts,
          we: c.ts,
          title: 'Headless bypass launch inside a session',
          detail: 'A command launched a coding agent with --dangerously-skip-permissions — the s1ngularity shape. Every tool call it makes is pre-authorised by construction.',
          observed: 1,
          threshold: 1,
        }));
      }
    }
  }
  return out;
}

// ── 33. sensitive_read_unasked: the path-class × basis matrix

function detectSensitiveMatrix(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(`SELECT path_class, path_hash, authorization_basis, count, window_start FROM sensitive_access
       WHERE authorization_basis IS NULL OR authorization_basis IN ('unknown', 'bypass_no_gate', 'mode_auto')`)
    .all() as { path_class: string; path_hash: string; authorization_basis: string | null; count: number; window_start: number }[];
  return rows.map((r) =>
    anom({
      key: `sensitive_read_unasked:${r.path_class}:${r.path_hash}:${r.window_start}`,
      rule: 'sensitive_read_unasked',
      severity: r.authorization_basis === 'bypass_no_gate' ? 'critical' : 'warn',
      session: null,
      ws: r.window_start,
      we: r.window_start + 86400000,
      title: `Sensitive access, no recorded grant: ${r.path_class}`,
      detail:
        `${r.count} access(es) to a ${r.path_class} path with authorization basis '${r.authorization_basis ?? 'no record'}' — ` +
        `the call reached no permission decision that could have refused it. Path recorded as a salted hash, never the path itself. ` +
        `Every count is a floor: reads behind a shell glob, a variable or an invoked script are invisible to it.`,
      observed: r.count,
    }),
  );
}

function detectSensitiveShapeFallback(calls: CallLite[]): Anomaly[] {
  return calls
    .filter((r) => r.shape?.includes('[sensitive') && r.status !== null)
    .slice(-200)
    .map((r) =>
      anom({
        key: `sensitive_read_unasked:${r.key}`,
        rule: 'sensitive_read_unasked',
        severity: 'warn',
        tool: r.tool,
        session: r.session,
        ws: r.ts,
        we: r.ts,
        title: `Sensitive path accessed: ${r.shape?.split(' [')[0] ?? r.name}`,
        detail:
          `A ${r.name} call touched a sensitive path (ssh keys, credentials or .env — the path is the signal, the content is never stored) ` +
          `with no recorded grant. Session ${r.session?.slice(0, 8) ?? 'unknown'}.`,
        observed: 1,
      }),
    );
}

// ── 49. agent_wrote_persistence

const PERSISTENCE_PATH_RE = /LaunchAgents|LaunchDaemons|crontab|\/etc\/periodic|StartupItems|\.git\/hooks|\/etc\/paths\.d|\.app\/Contents\//i;

function detectPersistenceWrites(db: DB, calls: CallLite[]): Anomaly[] {
  const out: Anomaly[] = [];
  const writes = db
    .prepare(`SELECT write_key, path, path_class, change_risk_class, session_id, ts FROM file_writes`)
    .all() as { write_key: string; path: string | null; path_class: string | null; change_risk_class: string | null; session_id: string | null; ts: number | null }[];
  for (const w of writes) {
    const hit = w.change_risk_class === 'machine_persistence' || (w.path !== null && PERSISTENCE_PATH_RE.test(w.path));
    if (!hit) continue;
    out.push(anom({
      key: `agent_wrote_persistence:${w.write_key}`,
      rule: 'agent_wrote_persistence',
      severity: 'critical',
      session: w.session_id,
      ws: w.ts ?? 0,
      we: w.ts ?? 0,
      title: `Persistence write: ${w.path_class ?? w.path?.split('/').pop() ?? 'unknown target'}`,
      detail:
        `A write landed in persistence territory (${w.path_class ?? 'path class not recorded'}) — code that runs on login, on the next shell, ` +
        `or on the next git operation. 'Written on this date', never 'present': a later manual revert is invisible to Vole. ` +
        `PATH precedence facts (entry, position, writability) are not recorded for this write.`,
      observed: 1,
    }));
  }
  for (const r of calls) {
    if (!r.shape?.includes('[persistence')) continue;
    out.push(anom({
      key: `agent_wrote_persistence:${r.key}`,
      rule: 'agent_wrote_persistence',
      severity: 'critical',
      tool: r.tool,
      session: r.session,
      ws: r.ts,
      we: r.ts,
      title: `Persistence write: ${r.shape.split(' [')[0] ?? r.name}`,
      detail:
        `A command wrote into LaunchAgents/LaunchDaemons territory — code that will run on every login. ` +
        `Session ${r.session?.slice(0, 8) ?? 'unknown'}. The shape is recorded, never the command.`,
      observed: 1,
    }));
  }
  return out;
}

// ── 13. agent_self_authorised: watched-key diffs in scope_history

function detectSelfAuthorised(db: DB, calls: CallLite[], now: number): Anomaly[] {
  const out: Anomaly[] = [];
  const insert = db.prepare(`INSERT INTO scope_history (captured_at, sha256, diff, source) VALUES (?, ?, ?, ?)`);
  for (const { path, toml } of watchedConfigPaths()) {
    const text = readIfExists(path);
    if (text === null) continue;
    const sha = sha256Of(text);
    const prev = db.prepare(`SELECT sha256, diff FROM scope_history WHERE source = ? ORDER BY id DESC LIMIT 1`).get(path) as
      | { sha256: string; diff: string | null }
      | undefined;
    const facts = watchedKeyFacts(text, toml);
    if (!prev) {
      insert.run(now, sha, JSON.stringify(facts), path); // baseline, no verdict
      continue;
    }
    if (prev.sha256 === sha) continue;
    let prevFacts: WatchedKeyFact[] = [];
    try {
      prevFacts = JSON.parse(prev.diff ?? '[]') as WatchedKeyFact[];
    } catch {
      prevFacts = [];
    }
    const changes = diffWatchedKeys(prevFacts, facts);
    insert.run(now, sha, JSON.stringify(facts), path);
    if (!changes.length) continue;

    let changeTs = now;
    try {
      changeTs = statSync(path).mtimeMs;
    } catch {
      /* mtime unknown — the diff timestamp is the capture time */
    }
    // Attribution holds only when a tool call in a session named the file near
    // the change; otherwise the actor is unknown and the incident says so.
    const near = calls.find(
      (c) => c.shape?.includes('[own-permissions') && Math.abs(c.ts - changeTs) < 10 * 60_000,
    );
    const grant = changes.some((ch) => ch.grant);
    out.push(anom({
      key: `agent_self_authorised:${path}:${sha.slice(0, 16)}`,
      rule: 'agent_self_authorised',
      severity: grant ? 'critical' : 'warn',
      session: near?.session ?? null,
      ws: changeTs,
      we: now,
      title: `Permission surface changed: ${changes.map((c) => c.key).join(', ')}`,
      detail:
        `A permission-granting key changed in ${path.split('/').slice(-2).join('/')}: ` +
        changes.map((c) => `${c.key}: ${c.from} -> ${c.to}`).join('; ') + '. ' +
        (near ? `A tool call in session ${near.session?.slice(0, 8)} named the file within the poll interval — attribution is that call, not proof.` : `No session named the file near the change: actor unknown (the file may equally have been rewritten by a human clicking 'always allow').`) +
        ` Key names and value classes only — no entry text or value is stored.`,
      observed: changes.length,
    }));
  }
  return out;
}

// ── 25. scope_drift: second repository + write-dir growth

function detectScopeDrift(db: DB, now: number): Anomaly[] {
  const out: Anomaly[] = [];
  const perProject = db
    .prepare(`SELECT session_id, project, COUNT(*) AS n, MIN(ts) AS lo FROM usage_events
       WHERE session_id IS NOT NULL AND project IS NOT NULL AND source = 'live'
       GROUP BY session_id, project`)
    .all() as { session_id: string; project: string; n: number; lo: number }[];
  const bySess = new Map<string, { project: string; n: number; lo: number }[]>();
  for (const r of perProject) {
    const arr = bySess.get(r.session_id);
    if (arr) arr.push(r);
    else bySess.set(r.session_id, [r]);
  }
  for (const [session, repos] of bySess) {
    if (repos.length < 2) continue;
    const sorted = [...repos].sort((a, b) => a.lo - b.lo);
    const first = sorted[0]!;
    const second = sorted[1]!;
    const crossing = db
      .prepare(`SELECT MIN(ts) AS t FROM tool_calls WHERE session_id = ? AND ts > ?`)
      .get(session, first.lo) as { t: number | null };
    out.push(anom({
      key: `scope_drift:${session}`,
      rule: 'scope_drift',
      severity: 'info',
      session,
      ws: first.lo,
      we: sorted[sorted.length - 1]!.lo,
      title: `Scope drift: session spanned ${repos.length} repositories`,
      detail:
        `Repos touched: ${sorted.map((r) => `${r.project} (${r.n} events)`).join(' -> ')}. ` +
        `The crossing happened at call time ${crossing.t !== null ? new Date(crossing.t).toISOString() : 'not recorded'}. ` +
        `A cd inside a Bash command never changes entry.cwd — a parsed cd target is a labelled second signal, never ground truth. ` +
        `Codex, Grok and Devin record cwd sparsely or not at all, so this rule covers Claude Code and OpenCode and says so rather than reporting zero drift for the rest.`,
      observed: repos.length,
      threshold: 1,
    }));
  }
  // Write-dir growth: distinct write directories beyond K after the first N calls.
  const writes = db
    .prepare(`SELECT session_id, path FROM file_writes WHERE session_id IS NOT NULL`)
    .all() as { session_id: string; path: string | null }[];
  const dirs = new Map<string, Set<string>>();
  for (const w of writes) {
    if (!w.path) continue;
    const d = w.path.replace(/\/[^/]*$/, '');
    const s = dirs.get(w.session_id);
    if (s) s.add(d);
    else dirs.set(w.session_id, new Set([d]));
  }
  for (const [session, ds] of dirs) {
    if (ds.size <= 5) continue;
    out.push(anom({
      key: `scope_drift:dirs:${session}`,
      rule: 'scope_drift',
      severity: 'info',
      session,
      ws: 0,
      we: 0,
      title: `Write scope grew to ${ds.size} directories`,
      detail: `The set of distinct directories written in this session grew beyond 5 — the session's write scope widened, which per-call scope rules cannot see.`,
      observed: ds.size,
      threshold: 5,
    }));
  }
  return out;
}

// ── 40. remote-database ledger rules

function detectDbActions(db: DB): Anomaly[] {
  const out: Anomaly[] = [];
  const rows = db
    .prepare(`SELECT da.call_key, da.statement_class, da.object_names, da.target_key, da.ts, tc.tool, tc.session_id
       FROM db_actions da LEFT JOIN tool_calls tc ON tc.tool_call_key = da.call_key`)
    .all() as { call_key: string; statement_class: string; object_names: string | null; target_key: string | null; ts: number | null; tool: string | null; session_id: string | null }[];
  const covered = new Set(rows.map((r) => r.call_key));
  for (const r of rows) {
    const destructive = ['ddl', 'drop', 'truncate', 'migrate_reset'].includes(r.statement_class);
    out.push(anom({
      key: `${destructive ? 'destructive_schema_change' : 'remote_database'}:${r.call_key}:${r.statement_class}`,
      rule: destructive ? 'destructive_schema_change' : 'remote_database',
      severity: destructive ? 'critical' : 'warn',
      tool: r.tool,
      session: r.session_id,
      ws: r.ts ?? 0,
      we: r.ts ?? 0,
      title: destructive ? `Destructive schema change: ${r.statement_class}` : `Database access: ${r.statement_class}`,
      detail:
        `Statement class ${r.statement_class}${r.object_names ? `, objects: ${r.object_names}` : ', object names not recorded'}` +
        `${r.target_key ? `, target: ${r.target_key}` : ', target not recorded'}. ` +
        `The class and the identifier names are stored, never the literal SQL or any value. The incident says 'ran', never 'deleted' — no exit code was recorded for it.`,
      observed: 1,
    }));
  }
  // Shape fallback while the ledger has no rows for a call.
  const shapes = db
    .prepare(`SELECT tool_call_key, tool, session_id, shape, ts FROM tool_calls
       WHERE (shape LIKE 'psql%' OR shape LIKE 'mysql%' OR shape LIKE 'mongosh%') AND shape IS NOT NULL`)
    .all() as { tool_call_key: string; tool: string; session_id: string | null; shape: string; ts: number }[];
  for (const r of shapes) {
    if (covered.has(r.tool_call_key)) continue;
    const destructive = /drop|truncate/i.test(r.shape);
    out.push(anom({
      key: `${destructive ? 'destructive_schema_change' : 'remote_database'}:${r.tool_call_key}`,
      rule: destructive ? 'destructive_schema_change' : 'remote_database',
      severity: destructive ? 'critical' : 'warn',
      tool: r.tool,
      session: r.session_id,
      ws: r.ts,
      we: r.ts,
      title: `${destructive ? 'Destructive database change' : 'Database access'}: ${r.shape}`,
      detail: `A ${r.shape} command ran — the agent touched a database. The shape is recorded, never the command or any SQL text.`,
      observed: 1,
    }));
  }
  return out;
}

// ── 45. install_after_ingress: adjacency by LEDGER ORDINALS, not wall clock

const INGRESS_ORDINALS = 8;

function isMcpIngress(c: CallLite): boolean {
  return c.name.startsWith('mcp__') || c.name === 'WebFetch' || c.name === 'WebSearch' || c.name === 'Fetch';
}

function isShapeIngress(c: CallLite): boolean {
  return isMcpIngress(c) || (c.shape !== null && /^(curl|wget)\b/.test(c.shape));
}

function isShapeAction(c: CallLite): boolean {
  return c.shape !== null && /^(npm install|npm i |pnpm install|yarn add|pip install|npx|pnpx|uvx|cargo install|go install)\b/.test(c.shape);
}

function detectInstallAfterIngress(db: DB, sessions: Map<string, CallLite[]>): Anomaly[] {
  const actionKeys = new Set<string>();
  for (const t of ['package_execs', 'remote_exec', 'secret_store_reads']) {
    for (const r of db.prepare(`SELECT DISTINCT call_key AS k FROM ${t}`).all() as { k: string }[]) actionKeys.add(r.k);
  }
  for (const r of db.prepare(`SELECT DISTINCT call_key AS k FROM db_actions WHERE statement_class != 'read'`).all() as { k: string }[]) actionKeys.add(r.k);
  const ledgerEmpty = actionKeys.size === 0;

  const out: Anomaly[] = [];
  for (const [session, calls] of sessions) {
    const sorted = [...calls].sort((a, b) => a.id - b.id);
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]!;
      const isAction = actionKeys.has(a.key) || (ledgerEmpty && isShapeAction(a));
      if (!isAction) continue;
      for (let j = Math.max(0, i - INGRESS_ORDINALS); j < i; j++) {
        const g = sorted[j]!;
        const isIngress = isMcpIngress(g) || (ledgerEmpty && isShapeIngress(g));
        if (!isIngress) continue;
        out.push(anom({
          key: `install_after_ingress:${session}:${g.key}`,
          rule: 'install_after_ingress',
          severity: 'warn',
          session,
          ws: g.ts,
          we: a.ts,
          title: `Ingress then target-bearing action: ${a.name}`,
          detail:
            `${g.name} (ingress: ${g.name.startsWith('mcp__') ? `MCP server ${g.name.split('__')[1] ?? 'unknown'}` : 'web fetch'}) was followed ` +
            `${i - j} ledger ordinals later by ${a.name} — the exact Agentjacking sequence. Ingress call ${g.key}, action call ${a.key}, ordinal gap ${i - j}. ` +
            `Adjacency is correlation, never causation: the incident says 'followed', not 'caused by'. A slow attack that waits out the window never fires.`,
          observed: i - j,
          threshold: INGRESS_ORDINALS,
        }));
        break;
      }
    }
  }
  return out;
}

// ── 39/18. the autonomy clock: chains, unattended_run, unattended_full_access

function detectAutonomyClock(sessions: Map<string, CallLite[]>, now: number): Anomaly[] {
  const out: Anomaly[] = [];
  const byDay = new Map<number, number>();
  for (const [session, calls] of sessions) {
    const chains = autonomyChains(calls.map((c) => ({ ts: c.ts, origin_kind: c.origin_kind })));
    for (const ch of chains) {
      const day = Math.floor(ch.start_ts / 86400000);
      byDay.set(day, (byDay.get(day) ?? 0) + (ch.end_ts - ch.start_ts));
    }
    const longest = longestChain(chains);
    if (longest && longest.calls >= 20 && longest.end_ts - longest.start_ts > 10 * 60_000) {
      out.push(anom({
        key: `unattended_run:${session}:${longest.start_ts}`,
        rule: 'unattended_run',
        severity: 'info',
        session,
        ws: longest.start_ts,
        we: longest.end_ts,
        title: `Unattended run: ${longest.calls} calls over ${Math.round((longest.end_ts - longest.start_ts) / 60000)} min`,
        detail:
          `The longest chain of consecutive tool calls with no human-authored entry between them: ${longest.calls} calls over ` +
          `${Math.round((longest.end_ts - longest.start_ts) / 60000)} minutes. ${longest.origin_recorded ? '' : 'origin.kind is not recorded for this session, so the whole session reads as one chain — absence of a recorded human, not a proven absence. '}` +
          `A human watching silently is indistinguishable from an absent one: the metric is 'no human input recorded'. ` +
          `calls_per_human_turn: ${callsPerHumanTurn(calls.map((c) => ({ ts: c.ts, origin_kind: c.origin_kind }))).ratio ?? 'no human turn recorded'}.`,
        observed: longest.calls,
        threshold: 20,
      }));
    }

    // unattended_full_access: a contiguous bypass stretch with no human entry
    // between its bounds — the no-human evidence chain, not just a duration.
    const bypass = calls.filter((c) => c.permission_mode === 'bypassPermissions');
    if (bypass.length) {
      const ws = bypass[0]!.ts;
      const we = bypass[bypass.length - 1]!.ts;
      const humansIn = calls.filter((c) => c.origin_kind === 'human' && c.ts >= ws && c.ts <= we);
      if (!humansIn.length && we - ws >= 15 * 60_000) {
        const prevHuman = [...calls].filter((c) => c.origin_kind === 'human' && c.ts < ws).sort((a, b) => b.ts - a.ts)[0];
        const nextHuman = calls.find((c) => c.origin_kind === 'human' && c.ts > we);
        out.push(anom({
          key: `unattended_full_access:${session}:${ws}`,
          rule: 'unattended_full_access',
          severity: 'critical',
          session,
          ws,
          we,
          title: `Unattended full access: ${Math.round((we - ws) / 60000)} min, no human input recorded`,
          detail:
            `A contiguous stretch where the autonomy interval is full_auto (bypassPermissions) and no entry with origin.kind='human' appears: ` +
            `${Math.round((we - ws) / 60000)} minutes, ${calls.length} calls. Evidence chain — posture interval: the interval covering ${new Date(ws).toISOString()} in autonomy_intervals; ` +
            `last human input before the window: ${prevHuman ? new Date(prevHuman.ts).toISOString() : 'none recorded (start of session)'}; ` +
            `next human input after the window: ${nextHuman ? new Date(nextHuman.ts).toISOString() : 'none recorded (end of session)'}; ` +
            `first/last call of the window: ${bypass[0]!.key} / ${bypass[bypass.length - 1]!.key} (raw_ref on the ledger rows names the transcript offsets). ` +
            `'No human input recorded for N minutes' — someone watching without typing is indistinguishable from an empty room.`,
          observed: we - ws,
          threshold: 15 * 60_000,
        }));
      }
    }
  }
  for (const [day, ms] of byDay) {
    if (ms < 10 * 60_000) continue;
    out.push(anom({
      key: `daily_exposure:${day}`,
      rule: 'daily_exposure_rollup',
      severity: 'info',
      session: null,
      ws: day * 86400000,
      we: day * 86400000 + 86400000,
      title: `Agent autonomy: ${Math.round(ms / 60000)} min on this day`,
      detail: `Across all sessions, agents ran ${Math.round(ms / 60000)} minutes with no human-authored entry in the chain — the autonomy clock. Human presence is not implied by activity.`,
      observed: ms,
      threshold: 10 * 60_000,
    }));
  }
  return out;
}

// ── 12. agent_pushed_data_off_device: direction from the crossing ledger

function detectPushedData(db: DB): Anomaly[] {
  const rows = db
    .prepare(`SELECT ce.call_key, ce.transport, ce.verb, ce.destination, ce.direction, ce.ts, tc.tool, tc.session_id
       FROM context_edges ce LEFT JOIN tool_calls tc ON tc.tool_call_key = ce.call_key
       WHERE ce.direction IN ('push', 'pull', 'mount')`)
    .all() as { call_key: string; transport: string; verb: string | null; destination: string | null; direction: string; ts: number | null; tool: string | null; session_id: string | null }[];
  const out: Anomaly[] = [];
  const covered = new Set(rows.map((r) => r.call_key));
  for (const r of rows) {
    out.push(anom({
      key: `agent_pushed:${r.call_key}:${r.direction}`,
      rule: 'agent_pushed_data_off_device',
      severity: 'warn',
      tool: r.tool,
      session: r.session_id,
      ws: r.ts ?? 0,
      we: r.ts ?? 0,
      title: `Data ${r.direction === 'pull' ? 'pulled from' : 'pushed toward'} ${r.destination ?? 'an unrecorded destination'}`,
      detail:
        `A ${r.transport} ${r.verb ?? 'transfer'} with direction ${r.direction}${r.destination ? ` to ${r.destination}` : ' (destination not recorded — the stored shape carries no host)'}. ` +
        `Vole reads the command, not the transfer: the copy is not confirmed, the byte count is unknown, and for a directory push every file inside is unknown and reported as unknown. ` +
        `A push to a host that is in fact monitored still shows as a push.`,
      observed: 1,
    }));
  }
  const shapes = db
    .prepare(`SELECT tool_call_key, tool, session_id, shape, ts FROM tool_calls WHERE shape LIKE 'scp%' OR shape LIKE 'rsync%'`)
    .all() as { tool_call_key: string; tool: string; session_id: string | null; shape: string; ts: number }[];
  for (const r of shapes) {
    if (covered.has(r.tool_call_key)) continue;
    out.push(anom({
      key: `agent_pushed:${r.session_id ?? 'none'}:${Math.floor(r.ts / 3600000)}`,
      rule: 'agent_pushed_data_off_device',
      severity: 'warn',
      tool: r.tool,
      session: r.session_id,
      ws: r.ts,
      we: r.ts,
      title: `Data pushed off device: ${r.shape}`,
      detail: `A ${r.shape} command ran — files left this laptop. The shape is the fact; the file names are never stored.`,
      observed: 1,
    }));
  }
  return out;
}

// ── 43. remote_privileged_exec: from the hop ledger

function detectPrivilegedRemote(db: DB): Anomaly[] {
  const rows = db
    .prepare(`SELECT re.call_key, re.hop, re.host, re.user, re.inner_pattern, re.ts, tc.tool, tc.session_id
       FROM remote_exec re LEFT JOIN tool_calls tc ON tc.tool_call_key = re.call_key
       WHERE re.inner_pattern LIKE '%sudo%' OR re.inner_pattern LIKE '%docker exec%' OR re.inner_pattern LIKE '%kubectl exec%' OR re.hop > 1`)
    .all() as { call_key: string; hop: number; host: string | null; user: string | null; inner_pattern: string | null; ts: number | null; tool: string | null; session_id: string | null }[];
  const out: Anomaly[] = [];
  const covered = new Set(rows.map((r) => r.call_key));
  for (const r of rows) {
    out.push(anom({
      key: `remote_privileged_exec:${r.call_key}`,
      rule: 'remote_privileged_exec',
      severity: 'critical',
      tool: r.tool,
      session: r.session_id,
      ws: r.ts ?? 0,
      we: r.ts ?? 0,
      title: `Privileged remote execution: hop ${r.hop}${r.host ? ` via ${r.host}` : ''}`,
      detail:
        `An execution hop ${r.host ? `to ${r.host}${r.user ? ` as ${r.user}` : ''} ` : '(host not recorded) '}carried an inner command whose skeleton is ${r.inner_pattern ?? 'not recorded'}. ` +
        `Host identity deduped through ~/.ssh/config when an alias was used. Vole sees the instruction, never the remote result — 'sent to', not 'ran on'.`,
      observed: r.hop,
    }));
  }
  const shapes = db
    .prepare(`SELECT tool_call_key, tool, session_id, shape, ts FROM tool_calls
       WHERE shape LIKE 'ssh%sudo%' OR shape LIKE 'docker exec%' OR shape LIKE 'kubectl exec%'`)
    .all() as { tool_call_key: string; tool: string; session_id: string | null; shape: string; ts: number }[];
  for (const r of shapes) {
    if (covered.has(r.tool_call_key)) continue;
    out.push(anom({
      key: `remote_privileged_exec:${r.tool_call_key}`,
      rule: 'remote_privileged_exec',
      severity: 'critical',
      tool: r.tool,
      session: r.session_id,
      ws: r.ts,
      we: r.ts,
      title: `Privileged remote execution: ${r.shape}`,
      detail: `A ${r.shape} command ran — code executed on another system with elevated rights. Session ${r.session_id?.slice(0, 8) ?? 'unknown'}.`,
      observed: 1,
    }));
  }
  return out;
}

// ── 41. context_edges: crossings by transport

function detectContextEdges(db: DB): Anomaly[] {
  const rows = db
    .prepare(`SELECT ce.transport, ce.destination, ce.direction, ce.ts, tc.session_id FROM context_edges ce
       LEFT JOIN tool_calls tc ON tc.tool_call_key = ce.call_key`)
    .all() as { transport: string; destination: string | null; direction: string; ts: number | null; session_id: string | null }[];
  const grouped = new Map<string, { transport: string; session: string | null; day: number; dests: Set<string>; n: number; ts: number | null }>();
  for (const r of rows) {
    const day = r.ts !== null ? Math.floor(r.ts / 86400000) : 0;
    const k = `${r.session_id ?? 'none'}::${day}::${r.transport}`;
    let g = grouped.get(k);
    if (!g) {
      g = { transport: r.transport, session: r.session_id, day, dests: new Set(), n: 0, ts: r.ts };
      grouped.set(k, g);
    }
    g.n++;
    if (r.destination) g.dests.add(r.destination);
  }
  const out: Anomaly[] = [];
  for (const [k, g] of grouped) {
    out.push(anom({
      key: `context_edges:${k}`,
      rule: 'context_edges',
      severity: 'info',
      session: g.session,
      ws: g.day * 86400000,
      we: g.day * 86400000 + 86400000,
      title: `Crossing by ${g.transport}: ${g.n} in one day`,
      detail:
        `${g.n} ${g.transport} crossing(s)${g.dests.size ? ` toward ${[...g.dests].slice(0, 3).join(', ')}` : ' — destinations not recorded (the stored shape carries no host)'}. ` +
        `Only the skeleton survives: transport, destination label and direction. Vole cannot know whether the remote command ran, succeeded, or what it touched.`,
      observed: g.n,
    }));
  }
  // fetch_ingress (tier 5 #32) supersedes the curl count; kept until it lands.
  const curls = db
    .prepare(`SELECT session_id, COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi FROM tool_calls
       WHERE shape LIKE 'curl%' GROUP BY session_id HAVING n >= 1`)
    .all() as { session_id: string | null; n: number; lo: number; hi: number }[];
  for (const r of curls) {
    if (!r.session_id) continue;
    out.push(anom({
      key: `context_edges:${r.session_id}:curl`,
      rule: 'context_edges',
      severity: 'info',
      session: r.session_id,
      ws: r.lo,
      we: r.hi,
      title: `External fetch in session`,
      detail: `A curl command ran in session ${r.session_id.slice(0, 8)} — untrusted web bytes entered the agent's context. Shape recorded, never the URL.`,
      observed: r.n,
    }));
  }
  return out;
}

// ── 42. subagent_inherited_bypass

function detectSubagentBypass(sessions: Map<string, CallLite[]>, db: DB): Anomaly[] {
  const out: Anomaly[] = [];
  for (const [session, calls] of sessions) {
    const byAgent = new Map<string, CallLite[]>();
    for (const c of calls) {
      if (!c.agent || c.agent === 'main') continue;
      const arr = byAgent.get(c.agent);
      if (arr) arr.push(c);
      else byAgent.set(c.agent, [c]);
    }
    for (const [agent, acalls] of byAgent) {
      const inheritedBypass = acalls.some((c) => c.permission_mode === 'bypassPermissions');
      const parentLaunchedHeadless = !inheritedBypass && calls.some((c) => c.shape?.includes('dangerously-skip-permissions'));
      if (!inheritedBypass && !parentLaunchedHeadless) continue;
      const edge = db
        .prepare(`SELECT agent_type, spawn_depth FROM agent_edges WHERE session_id = ? AND agent_id = ? LIMIT 1`)
        .get(session, agent) as { agent_type: string | null; spawn_depth: number | null } | undefined;
      out.push(anom({
        key: `subagent_inherited_bypass:${session}:${agent}`,
        rule: 'subagent_inherited_bypass',
        severity: 'warn',
        session,
        ws: acalls[0]!.ts,
        we: acalls[acalls.length - 1]!.ts,
        title: `Subagent inherited bypass: ${agent.slice(0, 12)}`,
        detail:
          `A subagent never gets its own permission dialog — it inherits the parent's posture at spawn — so ${acalls.length} calls by ${agent} ran under the parent's ` +
          `${inheritedBypass ? 'bypassPermissions interval' : 'headless launch'}. Agent type: ${edge?.agent_type ?? 'not recorded'}; spawn depth: ${edge?.spawn_depth ?? 'not recorded'}. ` +
          `autonomy_inherited/depth columns are not yet on autonomy_intervals — this fires from the per-call posture, not the interval tree.`,
        observed: acalls.length,
      }));
    }
  }
  return out;
}

// ── 52. cross_scope_read_then_publish

function detectCrossScope(sessions: Map<string, CallLite[]>): Anomaly[] {
  const out: Anomaly[] = [];
  for (const [session, calls] of sessions) {
    const pairCalls: PairCall[] = calls.map((c) => ({
      id: c.id, tool_call_key: c.key, tool: c.tool, name: c.name, shape: c.shape,
      args_digest: c.args_digest, status: c.status, ts: c.ts,
    }));
    const pairs = pairCrossScope(pairCalls);
    const seen = new Set<string>();
    for (const p of pairs) {
      const key = `cross_scope:${session}:${Math.floor(p.read.ts / 3600000)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const resolved = p.read_scope !== null && p.publish_scope !== null;
      out.push(anom({
        key,
        rule: 'cross_scope_read_then_publish',
        severity: resolved ? 'critical' : 'warn',
        session,
        ws: p.read.ts,
        we: p.publish.ts,
        title: 'Cross-scope read then publish',
        detail:
          `A read-class call (${p.read.name}) was followed within 30 min by a publish-class call (${p.publish.name}) in the same session. ` +
          (resolved
            ? `Read scope ${p.read_scope} -> publish scope ${p.publish_scope}.`
            : `Scopes not recorded — the MCP argument names are not bound to the ledger row yet, so this fires on the class pair, not a resolved A -> B.`) +
          ` Scope resolution is only as good as the server's argument names: an unknown argument name means the rule does not fire, under-reporting by design.`,
        observed: p.publish.ts - p.read.ts,
      }));
    }
  }
  return out;
}

// ── 46. vcs_actions: the agent's own gitOperation ledger

function detectVcsActions(db: DB): Anomaly[] {
  const rows = db
    .prepare(`SELECT va.call_key, va.verb, va.repo, va.escape_state, va.push_evidence, va.ts, tc.tool, tc.session_id
       FROM vcs_actions va LEFT JOIN tool_calls tc ON tc.tool_call_key = va.call_key`)
    .all() as { call_key: string; verb: string; repo: string | null; escape_state: string; push_evidence: string | null; ts: number | null; tool: string | null; session_id: string | null }[];
  const out: Anomaly[] = [];
  const covered = new Set<string>();
  for (const r of rows) {
    covered.add(r.call_key);
    const structured = r.push_evidence !== null;
    out.push(anom({
      key: `vcs_action:${r.call_key}:${r.verb}`,
      rule: 'vcs_action',
      severity: 'info',
      tool: r.tool,
      session: r.session_id,
      ws: r.ts ?? 0,
      we: r.ts ?? 0,
      title: `git ${r.verb} (${r.escape_state}${structured ? ', structured' : ', parsed'})`,
      detail:
        `git ${r.verb} reached ${r.escape_state} state${structured ? ` — the agent's own structured record (${r.push_evidence})` : ' — parsed from the command, no structured record'}. ` +
        `Repository identity: ${r.repo ?? 'not recorded (gitOperation names branch and sha but never the remote; repo_ref stays NULL rather than a guess)'}.`,
      observed: 1,
    }));
  }
  const shapes = db
    .prepare(`SELECT tool_call_key, tool, session_id, shape, ts FROM tool_calls
       WHERE shape LIKE 'git push%' OR shape LIKE 'git reset%' OR shape LIKE 'git clean%'`)
    .all() as { tool_call_key: string; tool: string; session_id: string | null; shape: string; ts: number }[];
  for (const r of shapes) {
    if (covered.has(r.tool_call_key)) continue;
    out.push(anom({
      key: `vcs_action:${r.session_id ?? 'none'}:${Math.floor(r.ts / 3600000)}`,
      rule: 'vcs_action',
      severity: 'info',
      tool: r.tool,
      session: r.session_id,
      ws: r.ts,
      we: r.ts,
      title: `State-changing git: ${r.shape}`,
      detail: `A ${r.shape} ran — repository state changed (pushed, reset or cleaned). Session ${r.session_id?.slice(0, 8) ?? 'unknown'}.`,
      observed: 1,
    }));
  }
  return out;
}

/** fetch_ingress: bytes entering the session from the web. */
function detectFetchIngress(db: DB): Anomaly[] {
  const rows = db
    .prepare(`SELECT session_id, COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi FROM tool_calls
       WHERE shape LIKE 'curl%' OR name IN ('WebFetch', 'Fetch') GROUP BY session_id HAVING n >= 1`)
    .all() as { session_id: string | null; n: number; lo: number; hi: number }[];
  const out: Anomaly[] = [];
  for (const r of rows) {
    if (!r.session_id) continue;
    out.push(anom({
      key: `fetch_ingress:${r.session_id}`,
      rule: 'fetch_ingress',
      severity: 'info',
      session: r.session_id,
      ws: r.lo,
      we: r.hi,
      title: `Web ingress: ${r.n} fetch(es) entered the session`,
      detail: `${r.n} web fetch(es) brought untrusted bytes into the agent's context — the prompt-injection surface. URLs are never stored; the shape is the fact.`,
      observed: r.n,
    }));
  }
  return out;
}

// ── 28. the human-interrupt ledger (text marker)

function detectHumanInterrupts(db: DB, now: number, projectsDir = paths.claudeCodeProjects()): Anomaly[] {
  const prev = db.prepare(`SELECT MAX(window_end) AS m FROM anomalies WHERE rule = 'human_interrupt'`).get() as { m: number | null };
  const since = prev?.m ?? 0;
  const rows = scanInterruptMarkers(projectsDir, since);
  const bySess = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = bySess.get(r.session_id);
    if (arr) arr.push(r);
    else bySess.set(r.session_id, [r]);
  }
  const out: Anomaly[] = [];
  for (const [session, ms] of bySess) {
    const calls = (db.prepare(`SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ?`).get(session) as { n: number }).n;
    const per100 = calls > 0 ? (ms.length / calls) * 100 : null;
    const resolved = ms.filter((m) => m.tool_call_key !== null).length;
    const ts = ms.map((m) => m.ts).filter((t): t is number => t !== null);
    out.push(anom({
      key: `human_interrupt:${session}`,
      rule: 'human_interrupt',
      severity: 'info',
      session,
      ws: ts.length ? Math.min(...ts) : since,
      we: ts.length ? Math.max(...ts) : now,
      title: `Human in the loop: ${ms.length} interrupt(s) (text marker)`,
      detail:
        `${ms.length} '[Request interrupted by user]' markers in this session — a TEXT MARKER, not a vendor signal: version-fragile, reproducible by pasting the string. ` +
        `${resolved} resolved to the immediately preceding unbound tool call. ${per100 !== null ? `${per100.toFixed(1)} interrupts per 100 tool calls.` : 'No tool calls recorded for this session.'} ` +
        `Only Claude Code emits the marker; other tools render an em dash, never 0.`,
      observed: ms.length,
    }));
  }
  return out;
}

// ── 36. posture_escalated / policy_downgraded over the interval timeline

function detectPostureTransitions(db: DB): Anomaly[] {
  const out: Anomaly[] = [];
  const rows = db
    .prepare(`SELECT session_id, agent_id, started_at, ended_at, calls, autonomy, approval_policy, sandbox_policy, permission_profile
       FROM autonomy_intervals WHERE session_id IS NOT NULL ORDER BY session_id, started_at`)
    .all() as { session_id: string; agent_id: string | null; started_at: number; ended_at: number; calls: number; autonomy: string | null; approval_policy: string | null; sandbox_policy: string | null; permission_profile: string | null }[];
  const bySess = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = bySess.get(r.session_id);
    if (arr) arr.push(r);
    else bySess.set(r.session_id, [r]);
  }
  for (const [session, ivs] of bySess) {
    for (let i = 1; i < ivs.length; i++) {
      const a = ivs[i - 1]!;
      const b = ivs[i]!;
      const ra = rankOf(a.autonomy);
      const rb = rankOf(b.autonomy);
      if (ra !== null && rb !== null && rb > ra && b.calls > 0) {
        out.push(anom({
          key: `posture_escalated:${session}:${b.started_at}`,
          rule: 'posture_escalated',
          severity: 'critical',
          session,
          ws: b.started_at,
          we: b.ended_at,
          title: `Posture escalated: ${a.autonomy} -> ${b.autonomy}`,
          detail:
            `Autonomy ${a.autonomy} -> ${b.autonomy} at ${new Date(b.started_at).toISOString()}, ${b.calls} calls after — the rank rose and calls executed inside the higher interval. ` +
            `A transition proved only by an untimestamped permission-mode line is placed at the following timestamped entry, so the escalation time carries up to one entry of error. ` +
            `A session launched already in bypass is not an escalation — that is headless_bypass_launch's job.`,
          observed: b.calls,
        }));
      }
      // The Codex confinement axis.
      const ap = [a.approval_policy, b.approval_policy];
      const sp = [a.sandbox_policy, b.sandbox_policy];
      const pp = [a.permission_profile, b.permission_profile];
      const approvalDown = ap[0] === 'managed' && (ap[1] === 'disabled' || ap[1] === 'never');
      const sandboxDown = (sp[0] === 'read-only' || sp[0] === 'workspace-write') && sp[1] === 'danger-full-access';
      const profileDown = pp[0] === 'managed' && pp[1] === 'disabled';
      if (approvalDown || sandboxDown || profileDown) {
        out.push(anom({
          key: `policy_downgraded:${session}:${b.started_at}`,
          rule: 'policy_downgraded',
          severity: 'critical',
          session,
          ws: b.started_at,
          we: b.ended_at,
          title: 'Policy downgraded within session',
          detail:
            `Codex confinement weakened mid-session: approval_policy ${ap[0]} -> ${ap[1]}, sandbox_policy ${sp[0]} -> ${sp[1]}, permission_profile ${pp[0]} -> ${pp[1]}. ` +
            `Both turn ids and timestamps are the interval bounds [${new Date(b.started_at).toISOString()}].`,
          observed: b.calls,
        }));
      }
    }
  }
  return out;
}

// ── 35. paged_bulk_read (count leg; distinct-line-range keying needs collector-side reads)

function detectPagedBulkRead(sessions: Map<string, CallLite[]>, now: number): Anomaly[] {
  const out: Anomaly[] = [];
  for (const [session, calls] of sessions) {
    const reads = calls.filter((c) => ['Read', 'Glob', 'Grep', 'read_file'].includes(c.name) && c.ts > now - 24 * 3600_000);
    if (reads.length < 30) continue;
    out.push(anom({
      key: `paged_bulk_read:${session}`,
      rule: 'paged_bulk_read',
      severity: 'info',
      session,
      ws: reads[0]!.ts,
      we: reads[reads.length - 1]!.ts,
      title: `Bulk read: ${reads.length} file accesses in one session`,
      detail:
        `${reads.length} read/glob/grep calls in 24h — the agent read a large surface. Distinct-line-range keying (so a re-read after an edit does not inflate coverage) ` +
        `needs the collector's numLines/totalLines parse; until it lands this is a call count, and the covered fraction is unknown rather than assumed.`,
      observed: reads.length,
      threshold: 30,
    }));
  }
  return out;
}

/** tool_first_seen: a tool name appears for the first time — the MCP dimension. */
function detectToolFirstSeen(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(`SELECT name, MIN(ts) AS first FROM tool_calls GROUP BY name HAVING first > ?`)
    .all(now - 7 * 24 * 3600_000) as { name: string; first: number }[];
  return rows.map((r) =>
    anom({
      key: `tool_first_seen:${r.name}`,
      rule: 'tool_first_seen',
      severity: 'info',
      session: null,
      ws: r.first,
      we: r.first,
      title: `New tool surface: ${r.name}`,
      detail: `The ledger's first sighting of "${r.name}" was ${new Date(r.first).toISOString()}. A tool nobody has used before is a capability that just appeared.`,
      observed: 1,
    }),
  );
}

// ── 48. posture-weighted severity across every rule ──────────────────────────

interface PostureInterval {
  session: string;
  autonomy: string | null;
  started_at: number;
  ended_at: number;
}

export function weightByPosture(a: Anomaly, intervals: PostureInterval[]): Anomaly {
  if (!a.session_id) return a;
  const own = intervals.filter((i) => i.session === a.session_id);
  if (!own.length) return a;
  const windowMs = Math.max(1, a.window_end - a.window_start);
  let fullAuto = 0;
  for (const i of own) {
    if (i.autonomy !== 'full_auto') continue;
    const overlap = Math.min(i.ended_at, a.window_end) - Math.max(i.started_at, a.window_start);
    if (overlap > 0) fullAuto += overlap;
  }
  return applyPostureWeight(a, { known: true, fullAutoOverlapMs: fullAuto, windowMs });
}

// ── the autonomy intervals table: posture as a timeline ──────────────────────

/**
 * Rebuilt every pass (idempotent by rebuild). Intervals are runs of consecutive
 * calls sharing one permission_mode within a (session, agent) — the call joins to
 * the posture in force at its own timestamp, not a session-level label. Calls
 * before the first mode stamp stay autonomy NULL ('unknown', never 'default').
 */
export function buildAutonomyIntervals(db: DB): number {
  db.exec('DELETE FROM autonomy_intervals');
  const rows = db
    .prepare(`SELECT session_id, agent_id, ts, permission_mode, status FROM tool_calls
       WHERE session_id IS NOT NULL ORDER BY session_id, COALESCE(agent_id, 'main'), ts, id`)
    .all() as { session_id: string; agent_id: string | null; ts: number; permission_mode: string | null; status: string | null }[];
  const insert = db.prepare(`INSERT OR IGNORE INTO autonomy_intervals
    (session_id, agent_id, started_at, ended_at, calls, denied, errors, mode_raw, autonomy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let n = 0;
  let cur: { session: string; agent: string; mode: string | null; start: number; end: number; calls: number; denied: number; errors: number } | null = null;
  const flush = () => {
    if (!cur) return;
    insert.run(cur.session, cur.agent === 'main' ? null : cur.agent, cur.start, cur.end, cur.calls, cur.denied, cur.errors, cur.mode, normalizeAutonomy(cur.mode));
    n++;
    cur = null;
  };
  for (const r of rows) {
    const agent = r.agent_id ?? 'main';
    const mode = r.permission_mode ?? null;
    if (!cur || cur.session !== r.session_id || cur.agent !== agent || cur.mode !== mode) {
      flush();
      cur = { session: r.session_id, agent, mode, start: r.ts, end: r.ts, calls: 0, denied: 0, errors: 0 };
    }
    cur.end = r.ts;
    cur.calls++;
    if (r.status === 'denied') cur.denied++;
    if (r.status === 'error') cur.errors++;
  }
  flush();
  return n;
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

/** The registry: every ledger rule id, in a stable order. */
export const LEDGER_RULE_IDS = [
  'denied_then_achieved', 'denial_then_reshape', 'remote_execution', 'remote_privileged_exec',
  'destructive_command', 'destructive_schema_change', 'tool_failure_storm', 'stuck_tool_call',
  'headless_bypass_launch', 'sensitive_read_unasked', 'agent_wrote_persistence',
  'agent_self_authorised', 'scope_drift', 'remote_database', 'install_after_ingress',
  'unattended_run', 'context_edges', 'subagent_inherited_bypass', 'cross_scope_read_then_publish',
  'vcs_action', 'fetch_ingress', 'human_interrupt', 'agent_pushed_data_off_device',
  'paged_bulk_read', 'daily_exposure_rollup', 'tool_first_seen', 'posture_escalated',
  'unattended_full_access', 'policy_downgraded', 'repeat_call_loop',
] as const;

export function detectLedgerRules(db: DB, now = Date.now()): Anomaly[] {
  const calls = loadCalls(db);
  const sessions = bySession(calls);

  const postureIntervals = db
    .prepare(`SELECT session_id AS session, autonomy, started_at, ended_at FROM autonomy_intervals WHERE session_id IS NOT NULL`)
    .all() as PostureInterval[];

  const anomalies = [
    ...detectToolFirstSeen(db, now),
    ...detectPostureTransitions(db),
    ...detectPostureEscalatedLegacy(sessions),
    ...detectPushedData(db),
    ...detectPrivilegedRemote(db),
    ...detectDbActions(db),
    ...detectPagedBulkRead(sessions, now),
    ...detectDeniedPairs(sessions, now),
    ...detectShapeRules(calls),
    ...detectFailureStorms(calls, now),
    ...detectStuckCalls(calls, now),
    ...detectStuckMeasured(db, now),
    ...detectHeadlessBypass(sessions, db, now),
    ...detectSensitiveMatrix(db, now),
    ...detectSensitiveShapeFallback(calls),
    ...detectPersistenceWrites(db, calls),
    ...detectSelfAuthorised(db, calls, now),
    ...detectScopeDrift(db, now),
    ...detectInstallAfterIngress(db, sessions),
    ...detectAutonomyClock(sessions, now),
    ...detectContextEdges(db),
    ...detectSubagentBypass(sessions, db),
    ...detectCrossScope(sessions),
    ...detectVcsActions(db),
    ...detectFetchIngress(db),
    ...detectHumanInterrupts(db, now),
    ...detectLedgerRepeatLoops(calls, now),
  ];

  return anomalies.map((a) => ({ ...weightByPosture({ ...a, detected_at: now }, postureIntervals), detected_at: now }));
}

/** The denied-call -> skip-permissions-launch shape: the pre-interval approximation,
 *  kept until permission_mode is populated on every collector. */
function detectPostureEscalatedLegacy(sessions: Map<string, CallLite[]>): Anomaly[] {
  const out: Anomaly[] = [];
  for (const [session, calls] of sessions) {
    const denied = calls.find((c) => c.status === 'denied');
    const launch = calls.find((c) => c.shape?.includes('dangerously-skip-permissions') && denied && c.ts > denied.ts);
    if (!denied || !launch) continue;
    out.push(anom({
      key: `posture_escalated:${session}`,
      rule: 'posture_escalated',
      severity: 'critical',
      session,
      ws: denied.ts,
      we: launch.ts,
      title: 'Posture escalated within session',
      detail: `A call was denied, then the session launched with --dangerously-skip-permissions — the guardrails came off mid-session. The strongest bypass signal the ledger can produce.`,
      observed: launch.ts - denied.ts,
    }));
  }
  return out;
}
