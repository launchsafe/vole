import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { skeletonize, type ToolCallRow } from '../toolcalls/bind';
import { paths } from '../paths';
import { getState, type DB } from '../db';
import { parseLine } from '../util/jsonl';
import { contentOf, type Content } from '../content';
import { computeCost } from '../pricing';
import { Database } from '../sqlite';
import { advanceCursor } from '../cursors';
import { insertEventLinks, insertAgentEdges, recordSessionPlan, insertQuotaObservations, stampObservedAt, widenToolCalls } from './ledger';
import type { CollectorResult, RateLimitObservation, UsageEvent } from '../types';

/**
 * Codex CLI — exact tokens, but structured differently than Claude Code.
 *
 * Rollouts live at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Each `token_count`
 * event carries BOTH a cumulative `total_token_usage` (the meter) and a per-turn
 * `last_token_usage` (the breakdown of what the current turn consumed).
 *
 * The METER is authoritative. Consumption per event is the delta of the cumulative
 * total: summing `total_token_usage` would double-count catastrophically, and a
 * duplicate emission (Codex sometimes writes the same token_count event twice at
 * session start) advances the meter by zero and is skipped.
 *
 * The BREAKDOWN is best-effort attribution, and not every Codex version fills it:
 * older rollouts emit all-zero component fields with a non-zero meter total. Those
 * tokens are real but unattributable, so the component columns are stored NULL —
 * never 0, which would both understate the session and fabricate a cache split —
 * and cost stays NULL, since pricing needs the input/output split. The exact meter
 * delta is always kept in `total_tokens`.
 *
 * v2 (tier 1 #10 + #21 + #51): the collector joins ~/.codex/state_5.sqlite —
 * `threads` carries the git branch and the spawn tree per rollout path
 * (`first_user_message` is prompt content and is never SELECTed) — keys tool
 * calls by the source-native `function_call.call_id`, captures the turn_context
 * confinement claim (sandbox_policy / permission_profile / workspace_roots) so
 * the claim-violation rules can falsify it, and proves the account plan from
 * the session's own rate_limits payload with binding evidence 'session_proved'.
 */

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface RateLimits {
  primary?: {
    used_percent?: number;
    window_minutes?: number;
    plan_type?: string;
    limit_id?: string;
    individual_limit?: number | null;
    spend_control_reached?: boolean | null;
  };
}

interface TurnContextPayload {
  type?: string;
  model?: string;
  cwd?: string;
  approval_policy?: string | null;
  sandbox_policy?: { type?: string | null } | null;
  permission_profile?: {
    file_system?: { entries?: { access?: string | null }[] } | null;
    network?: { access?: string | null } | null;
  } | null;
  workspace_roots?: string[] | null;
}

interface CodexLine {
  type?: string;
  timestamp?: string;
  ordinal?: number;
  payload?: {
    type?: string;
    id?: string;
    /** response_item function_call / custom_tool_call / local_shell_call call_id */
    call_id?: string;
    model?: string;
    cwd?: string;
    name?: string;
    arguments?: { cmd?: string | string[]; workdir?: string | null } | null;
    info?: {
      total_token_usage?: TokenUsage;
      last_token_usage?: TokenUsage;
      model_context_window?: number;
    };
    rate_limits?: RateLimits;
    /* turn_context (a nested payload under the event wrapper) */
    approval_policy?: string | null;
    sandbox_policy?: { type?: string | null } | null;
    permission_profile?: TurnContextPayload['permission_profile'];
    workspace_roots?: string[] | null;
    /* token_usage_record (tier 7 #37): the vendor-join keys */
    response_id?: string | null;
    turn_id?: string | null;
    root_turn_id?: string | null;
    thread_id?: string | null;
    ord?: number | null;
  };
}

const TOOL_ITEMS = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);

function walkRollouts(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkRollouts(p, out);
    else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push(p);
  }
}

// ── state_5.sqlite: the thread registry (v2) ─────────────────────────────────

interface ThreadRow {
  id: string;
  rollout_path: string | null;
  git_branch: string | null;
}

interface StateDb {
  /** rollout_path -> git branch (only non-NULL branches). */
  branchByRollout: Map<string, string>;
  /** spawn edges straight from the vendor's own table, mapped into agent_edges rows. */
  edges: { edge_key: string; session_id: string; agent_id: string | null; parent_agent_id: string | null; spawn_depth: number | null }[];
}

/**
 * ~/.codex/state_5.sqlite: `threads` (id, rollout_path, git_branch, …) and
 * `thread_spawn_edges` (parent/child thread ids). Read-only; the columns are
 * probed by name so an older layout degrades to "no join" instead of throwing.
 * threads.first_user_message is PROMPT CONTENT — never SELECTed.
 */
function readCodexState(sessionsRoot: string): StateDb {
  const empty: StateDb = { branchByRollout: new Map(), edges: [] };
  // state_5.sqlite sits beside the sessions/ directory the rollouts live in —
  // derived from the resolved root so a redirected CODEX_HOME follows along.
  const dbPath = join(sessionsRoot, '..', 'state_5.sqlite');
  if (!existsSync(dbPath)) return empty;
  let src: InstanceType<typeof Database>;
  try {
    src = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return empty;
  }
  try {
    const tables = new Set(
      (src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name),
    );
    const state: StateDb = { branchByRollout: new Map(), edges: [] };
    if (tables.has('threads')) {
      for (const t of src
        .prepare('SELECT id, rollout_path, git_branch FROM threads')
        .all() as ThreadRow[]) {
        if (t.rollout_path && t.git_branch) state.branchByRollout.set(t.rollout_path, t.git_branch);
      }
    }
    if (tables.has('thread_spawn_edges')) {
      // Column names are probed, not assumed: (parent, child, depth) under
      // whichever names this Codex build uses.
      const cols = new Set(
        (src.prepare('PRAGMA table_info(thread_spawn_edges)').all() as { name: string }[]).map((c) => c.name),
      );
      const pick = (...names: string[]) => names.find((n) => cols.has(n)) ?? null;
      const parentCol = pick('parent_thread_id', 'parent_id', 'parent');
      const childCol = pick('child_thread_id', 'child_id', 'thread_id', 'child');
      const depthCol = pick('depth', 'spawn_depth');
      if (parentCol && childCol) {
        // Column names come from PRAGMA, never user input — quoted as identifiers.
        const q = (c: string) => `"${c.replace(/"/g, '""')}"`;
        const sql = `SELECT ${q(parentCol)} AS parent, ${q(childCol)} AS child` +
          (depthCol ? `, ${q(depthCol)} AS depth` : ', NULL AS depth') +
          ' FROM thread_spawn_edges';
        for (const e of src.prepare(sql).all() as { parent: string; child: string; depth: number | null }[]) {
          // The child thread is its own agent under the PARENT's session tree —
          // a session's spend stays one tree, the same contract Claude Code's
          // agentId gives.
          state.edges.push({
            edge_key: `codex-spawn:${e.child}`,
            session_id: e.parent,
            agent_id: e.child,
            parent_agent_id: e.parent,
            spawn_depth: typeof e.depth === 'number' ? e.depth : null,
          });
        }
      }
    }
    return state;
  } catch {
    return empty;
  } finally {
    src.close();
  }
}

// ── the declared claim (tier 5 #51) ──────────────────────────────────────────

export interface CodexTurnClaim {
  session_id: string | null;
  ts: number;
  sandbox_type: string | null;
  network_access: string | null;
  workspace_roots: string[];
  approval_policy: string | null;
}

export interface CodexClaimViolation {
  kind: 'sandbox' | 'network';
  call_key: string;
  session_id: string | null;
  tool: string;
  /** The path the call touched, resolved as far as the line allows. */
  path: string | null;
  declared_root: string | null;
  declared_policy: string | null;
}

/**
 * Falsifies the turn_context confinement claim against the observed call.
 * sandbox: a function_call workdir (or a path resolved out of exec cmd) outside
 * workspace_roots while sandbox_policy.type is read-only / workspace-write.
 * network: permission_profile.network claims restricted/none but the call is a
 * fetch-shaped tool (the observed wire, tier 8's OTLP lane, completes it).
 *
 * Pure on purpose: the detection registry (detect/) calls this per pass with
 * the rows the collector stored; the rule literals `sandbox_claim_violated` /
 * `network_claim_violated` are flagged for the types.ts union.
 */
export function codexClaimViolations(
  claims: CodexTurnClaim[],
  calls: { tool_call_key: string; session_id: string | null; name: string; path: string | null; ts: number }[],
): CodexClaimViolation[] {
  const out: CodexClaimViolation[] = [];
  for (const c of calls) {
    // The claim in force: the latest turn_context at or before the call.
    const claim = claims
      .filter((t) => (c.session_id ? t.session_id === c.session_id : true) && t.ts <= c.ts)
      .sort((a, b) => a.ts - b.ts)
      .at(-1);
    if (!claim || !c.path) continue;
    const callPath = c.path;
    if (claim.sandbox_type === 'read-only' || claim.sandbox_type === 'workspace-write') {
      const inside = claim.workspace_roots.some((r) => callPath === r || callPath.startsWith(r.endsWith('/') ? r : `${r}/`));
      if (!inside) {
        out.push({
          kind: 'sandbox',
          call_key: c.tool_call_key,
          session_id: c.session_id,
          tool: c.name,
          path: c.path,
          declared_root: claim.workspace_roots[0] ?? null,
          declared_policy: claim.sandbox_type,
        });
      }
    }
  }
  return out;
}

// ── the collector ───────────────────────────────────────────────────────────

/**
 * CollectorResult widened locally (types.ts is a coordinated seam): this pass's
 * parsed turn claims, for the claim-violation rules the detection registry runs.
 */
export interface CodexCollectorResult extends CollectorResult {
  codexClaims?: CodexTurnClaim[];
}

export function collectCodex(db: DB): CodexCollectorResult {
  const root = paths.codexSessions();
  const events: UsageEvent[] = [];
  const rateLimits: RateLimitObservation[] = [];
  const notes: string[] = [];
  const calls: ToolCallRow[] = [];
  const links: { event_key: string; vendor: string; link_kind: string; link_id: string }[] = [];
  const claims: CodexTurnClaim[] = [];
  // tool_calls posture widening + observed_at stamping are deferred to commit:
  // the CLI inserts this pass's rows (insertEvents, insertToolCalls) before it.
  const pendingWiden: { keys: string[]; permission_mode: string | null; autonomy_rank: string | null }[] = [];
  const eventKeys: string[] = [];
  const now = Date.now(); // the collector clock — observed_at, never a key
  let filesScanned = 0;
  let filesSkipped = 0;

  if (!existsSync(root)) {
    return { tool: 'codex', events, filesScanned: 0, notes: [`No directory at ${root}`], sourceState: 'no_source' };
  }

  const state = readCodexState(root);
  if (state.edges.length) {
    insertAgentEdges(db, state.edges.map((e) => ({ ...e, agent_type: 'codex_subagent' })));
  }

  const files: string[] = [];
  walkRollouts(root, files);

  for (const filePath of files) {
    // Scan cursor: rollout files are append-only, so the byte offset IS the
    // declared cursor — an unchanged offset means every line is already stored
    // under its stable event_key (mtime is checked too: an in-place rewrite at
    // the same size is caught by the head digest in advanceCursor).
    let st;
    try {
      st = statSync(filePath);
    } catch (err) {
      notes.push(`Could not stat ${filePath}: ${(err as Error).message}`);
      continue;
    }
    const prev = getState(db, filePath);
    if (prev && prev.last_offset === st.size && prev.last_mtime === Math.trunc(st.mtimeMs)) {
      filesSkipped++;
      continue;
    }

    let lines: Content[];
    try {
      // contentOf: the boundary crossing for full-file readers. The rollout line
      // can be measured (hashOf/lengthOf, Tier 4/5) but never stored.
      lines = readFileSync(filePath, 'utf8').split('\n').filter((l) => l.length > 0).map(contentOf);
    } catch (err) {
      notes.push(`Could not read ${filePath}: ${(err as Error).message}`);
      continue;
    }
    filesScanned++;

    // rollout-<timestamp>-<uuid>.jsonl: the uuid is this rollout's own identity,
    // the one thing a sub-agent does NOT replay from its parent. Matched by shape
    // at the stem's end — the timestamp's dashes make position-based slicing wrong.
    const rolloutId = basename(filePath, '.jsonl').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0] ?? null;
    // v2: the thread registry holds the git branch keyed by rollout path —
    // read from the vendor's own DB, never guessed.
    const gitBranch = state.branchByRollout.get(filePath) ?? null;

    let sessionId: string | null = null;
    let model: string | null = null;
    let project: string | null = null;
    let prevTotal = 0;
    // Tool calls the model issued since the previous token_count; attributed to the
    // next one, which is the meter reading that covers them.
    let pendingTools: string[] = [];
    // The confinement claim in force for calls until the next turn_context.
    let claim: CodexTurnClaim | null = null;

    // Turn-scoped duration: the gap from the previous event in this rollout to
    // the token_count that closed the turn. Includes queue time; the kind says so.
    let prevEventTs: number | null = null;
    lines.forEach((line, index) => {
      const entry = parseLine<CodexLine>(line);
      if (!entry) {
        return;
      }
      const anyTs = entry.timestamp ? Date.parse(entry.timestamp) : null;
      const eventTs = entry.payload?.type === 'token_count' ? anyTs : null;

      if (entry.type === 'session_meta') {
        sessionId = entry.payload?.id ?? null;
        project = entry.payload?.cwd ?? project;
        return;
      }
      // session_meta.model is null in real logs; the live model lives on turn_context,
      // as does the cwd (it can change mid-session). v2: turn_context is also the
      // DECLARED confinement claim — sandbox_policy, permission_profile and
      // workspace_roots — which the claim-violation rules falsify against calls.
      if (entry.type === 'turn_context') {
        model = entry.payload?.model ?? model;
        project = entry.payload?.cwd ?? project;
        const sandboxType = entry.payload?.sandbox_policy?.type ?? null;
        const networkAccess = entry.payload?.permission_profile?.network?.access ?? null;
        claim = {
          session_id: sessionId,
          ts: anyTs ?? 0,
          sandbox_type: sandboxType,
          network_access: networkAccess,
          workspace_roots: entry.payload?.workspace_roots ?? [],
          approval_policy: entry.payload?.approval_policy ?? null,
        };
        claims.push(claim);
        return;
      }
      // Agent identity (v2): computed once per event, before every consumer.
      const agentIdNow = rolloutId && rolloutId !== sessionId ? rolloutId : null;
      if (entry.type === 'response_item' && TOOL_ITEMS.has(entry.payload?.type ?? '')) {
        const name = entry.payload?.name ?? entry.payload?.type ?? 'tool';
        pendingTools.push(name);
        // Source-native key (tier 5 #5): the call_id the vendor itself mints —
        // `codex:<function_call.call_id|custom_tool_call.call_id>`. The
        // file:index fallback only exists for rollouts from before call ids.
        const callKey = `codex:${entry.payload?.call_id ?? entry.payload?.id ?? `${filePath}:${index}`}`;
        // The ledger, phase 1: the call itself. Codex states no per-call outcome,
        // so status stays NULL until (never, today) a result shape exists — an
        // honest unknown, and turn_status says so when a turn-level verdict lands.
        calls.push({
          tool_call_key: callKey,
          tool: 'codex',
          name,
          shape: skeletonize(name, entry.payload?.arguments?.cmd ?? null),
          args_digest: null, // call args are encrypted reasoning payloads
          session_id: sessionId,
          agent_id: agentIdNow,
          ts: anyTs ?? now, // explicit fallback: the collector clock, labelled by observed_at ≈ ts
          raw_ref: `${filePath}#${index}`,
        });
        if (claim && (claim.sandbox_type || claim.approval_policy)) {
          pendingWiden.push({
            keys: [callKey],
            permission_mode: claim.approval_policy,
            autonomy_rank: claim.sandbox_type,
          });
        }
        return;
      }
      // token_usage_record (tier 7 #37): the vendor-join keys — response_id,
      // turn_id, root_turn_id, thread_id and the line ordinal. These are what a
      // SIEM pivots on to reach the vendor's own record of this call.
      if (entry.payload?.type === 'token_usage_record') {
        const p = entry.payload;
        const key = `codex:${filePath}:${index}`;
        if (p.response_id) links.push({ event_key: key, vendor: 'codex', link_kind: 'response_id', link_id: p.response_id });
        if (p.turn_id) links.push({ event_key: key, vendor: 'codex', link_kind: 'turn_id', link_id: p.turn_id });
        if (p.root_turn_id) links.push({ event_key: key, vendor: 'codex', link_kind: 'root_turn_id', link_id: p.root_turn_id });
        if (p.thread_id) links.push({ event_key: key, vendor: 'codex', link_kind: 'thread_id', link_id: p.thread_id });
        const ord = p.ord ?? entry.ordinal ?? null;
        if (ord !== null) links.push({ event_key: key, vendor: 'codex', link_kind: 'ordinal', link_id: String(ord) });
        return;
      }
      if (entry.payload?.type !== 'token_count') return;

      const ts = anyTs ?? now; // explicit fallback: labelled by observed_at ≈ ts

      const rl = entry.payload.rate_limits?.primary;
      if (rl?.used_percent !== undefined) {
        rateLimits.push({
          tool: 'codex',
          session_id: sessionId,
          ts,
          used_percent: rl.used_percent,
          window_minutes: rl.window_minutes ?? 0,
        });
        // The plan, proved by the session's own file (tier 3 #21) — never by
        // opening auth.json, which holds three live tokens. plan_type is what
        // the server told the client at that moment, not a billing record.
        if (sessionId && rl.plan_type) {
          recordSessionPlan(db, sessionId, rl.plan_type, 'codex', ts);
        }
        if (sessionId && rl.limit_id !== undefined) {
          insertQuotaObservations(db, [
            {
              tool: 'codex',
              session_id: sessionId,
              ts,
              // kind names the meter the observation came from; limit_value
              // carries individual_limit when the server stated one.
              kind: rl.limit_id ?? 'rate_limit_primary',
              used_percent: rl.used_percent,
              limit_value: typeof rl.individual_limit === 'number' ? rl.individual_limit : null,
            },
          ]);
        }
      }

      const info = entry.payload.info;
      const total = info?.total_token_usage;
      const last = info?.last_token_usage;
      if (!total && !last) return;
      const tools = pendingTools.length ? pendingTools.join(',') : null;
      pendingTools = [];

      // Agent identity (v2): sub-agent rollouts REPLAY the parent's session_meta,
      // so sessionId alone cannot tell parent from child — every row of a spawned
      // rollout used to look like the main thread. The rollout's own filename
      // carries a uuid distinct from the session id; when they differ, this file IS
      // a sub-agent and the uuid is its agent id (the spawn edge: this rollout, of
      // that session).
      const agentId = agentIdNow ?? null;

      // Meter delta: what this event consumed, per Codex's own running total.
      let delta: number;
      let usage: TokenUsage;

      if (total) {
        const runningTotal = total.total_tokens ?? 0;
        if (runningTotal > prevTotal) {
          // Normal path: consume only what is new since the previous token_count.
          delta = runningTotal - prevTotal;
          // The per-turn figure is trustworthy only when it bridges the meter exactly;
          // otherwise fall back to whichever figure we have.
          usage =
            last && (last.total_tokens ?? 0) + prevTotal === runningTotal ? last : (last ?? total);
          prevTotal = runningTotal;
        } else if (runningTotal < prevTotal) {
          // Counter reset (new turn context): the whole meter is new-segment consumption.
          delta = runningTotal;
          usage = last ?? total;
          prevTotal = runningTotal;
        } else {
          // No new tokens — a duplicate emission. Skip rather than count it again.
          return;
        }
      } else {
        // No cumulative meter in this event: trust the per-turn figure as-is.
        usage = last!;
        delta = usage.total_tokens ?? 0;
        if (delta <= 0) return;
      }

      const input = usage.input_tokens ?? 0;
      const cached = usage.cached_input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;
      // Codex reports cached input inside input_tokens; separate them so cache maths holds.
      const freshInput = Math.max(0, input - cached);
      const attributed = freshInput + cached + output;

      // attributed === 0 with delta > 0 means the version never split the meter
      // (all-zero breakdown). The tokens are exact, the components are unknown.
      const breakdownKnown = attributed > 0;
      // Cost needs the full input/output split; a partial breakdown leaves part of the
      // meter unattributable, so the cost is unknown even though the total is exact.
      const costKnown = breakdownKnown && attributed === delta;

      const tokens = {
        input_tokens: freshInput,
        output_tokens: output,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        cache_read_tokens: cached,
      };

      const duration =
        eventTs !== null && prevEventTs !== null && eventTs > prevEventTs && eventTs - prevEventTs < 600_000
          ? eventTs - prevEventTs
          : null;
      events.push({
        // Keyed on the rollout file, never on sessionId: sub-agent rollout files
        // replay the parent's session_meta, so a session id can appear in several
        // files and rows from parent and child would collide on one key — silently
        // losing whichever was inserted first. The file path is the source-native
        // identity: unique per rollout, stable across re-reads.
        event_key: `codex:${filePath}:${index}`,
        tool: 'codex',
        model,
        session_id: sessionId,
        project,
        // v2: the branch from the vendor's own thread registry (state_5.sqlite),
        // not a guess — NULL only when the registry has no row for this rollout.
        git_branch: gitBranch,
        ts,
        // Codex has no cache-write concept: 0 here is structural, not a measurement.
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        input_tokens: breakdownKnown ? freshInput : null,
        output_tokens: breakdownKnown ? output : null,
        cache_read_tokens: breakdownKnown ? cached : null,
        reasoning_tokens: breakdownKnown ? (usage.reasoning_output_tokens ?? 0) : null,
        total_tokens: delta,
        cost_usd: costKnown ? computeCost(model, tokens) : null,
        confidence: 'exact',
        is_error: 0,
        stop_reason: null,
        source: 'live',
        raw_ref: `${filePath}#${index}`,
        tools,
        agent_id: agentId,
        // Codex states its own window on every meter event — exact, no lookup needed.
        context_window: info?.model_context_window ?? null,
        // Turn-scoped: the gap from the previous rollout event; a lower bound.
        duration_ms: duration,
        duration_kind: duration !== null ? ('turn_scoped' as const) : null,
      });
      eventKeys.push(`codex:${filePath}:${index}`);
      if (anyTs !== null) prevEventTs = anyTs;
    });

    // Advance the declared cursor after a successful full read. Append-only files
    // make this safe even if the store insert later fails: re-reading recomputes
    // the same stable event_keys and the upsert no-ops. The chained prefix digest
    // covers only the bytes consumed this pass (offset → size).
    advanceCursor(db, {
      sourceKey: filePath,
      tool: 'codex',
      offset: st.size,
      mtimeMs: st.mtimeMs,
      stat: { ino: st.ino, birthtimeMs: st.birthtimeMs },
    });
  }

  if (links.length) insertEventLinks(db, links);

  return {
    tool: 'codex',
    events,
    filesScanned,
    notes,
    rateLimits,
    toolCalls: calls,
    // Exposed for the detection registry's claim-violation rules (integration):
    // the parsed turn claims, joined against tool_calls by the registry.
    codexClaims: claims,
    commit: () => {
      // Posture widening after insertToolCalls stored this pass's calls.
      for (const w of pendingWiden) {
        widenToolCalls(db, w.keys, {
          permission_mode: w.permission_mode,
          autonomy_rank: w.autonomy_rank,
        });
      }
      stampObservedAt(db, eventKeys, now);
    },
  };
}
