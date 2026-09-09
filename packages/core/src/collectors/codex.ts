import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { paths } from '../paths';
import { getState, setState, type DB } from '../db';
import { parseLine } from '../util/jsonl';
import { computeCost } from '../pricing';
import { Database } from '../sqlite';
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
 * v2: the collector joins ~/.codex/state_5.sqlite — `threads` carries the git
 * branch per rollout path (`first_user_message` is prompt content and is never
 * SELECTed).
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
  };
}

interface CodexLine {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    id?: string;
    model?: string;
    cwd?: string;
    name?: string;
    info?: {
      total_token_usage?: TokenUsage;
      last_token_usage?: TokenUsage;
      model_context_window?: number;
    };
    rate_limits?: RateLimits;
  };
}

const TOOL_ITEMS = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);

/** One unreadable entry must not end the walk. A broken symlink, a rollout rotated
 *  away between readdir and stat, or a directory the process cannot enter used to
 *  throw straight out of collectCodex — collectAll caught it and discarded the whole
 *  Codex result, so a single bad path silently disabled Codex collection on every
 *  pass. Skip what cannot be read and keep walking. */
function walkRollouts(dir: string, out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue; // vanished or unreadable between readdir and stat
    }
    if (isDir) walkRollouts(p, out);
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
}

/**
 * ~/.codex/state_5.sqlite: `threads` (id, rollout_path, git_branch, …).
 * Read-only; the table is probed by name so an older layout degrades to
 * "no join" instead of throwing. threads.first_user_message is PROMPT CONTENT
 * — never SELECTed.
 */
function readCodexState(sessionsRoot: string): StateDb {
  const empty: StateDb = { branchByRollout: new Map() };
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
    const state: StateDb = { branchByRollout: new Map() };
    if (tables.has('threads')) {
      for (const t of src
        .prepare('SELECT id, rollout_path, git_branch FROM threads')
        .all() as ThreadRow[]) {
        if (t.rollout_path && t.git_branch) state.branchByRollout.set(t.rollout_path, t.git_branch);
      }
    }
    return state;
  } catch {
    return empty;
  } finally {
    src.close();
  }
}

// ── the collector ───────────────────────────────────────────────────────────

export function collectCodex(db: DB): CollectorResult {
  const root = paths.codexSessions();
  const events: UsageEvent[] = [];
  const rateLimits: RateLimitObservation[] = [];
  const notes: string[] = [];
  const pending: [string, number, number][] = [];
  const now = Date.now(); // the collector clock — a fallback ts, never a key
  let filesScanned = 0;
  let filesSkipped = 0;

  if (!existsSync(root)) {
    return { tool: 'codex', events, filesScanned: 0, notes: [`No directory at ${root}`], sourceState: 'no_source' };
  }

  const state = readCodexState(root);

  const files: string[] = [];
  walkRollouts(root, files);

  for (const filePath of files) {
    // Scan cursor: rollout files are append-only, so the byte offset IS the
    // declared cursor — an unchanged offset means every line is already stored
    // under its stable event_key (mtime is checked too).
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

    let lines: string[];
    try {
      lines = readFileSync(filePath, 'utf8').split('\n').filter((l) => l.length > 0);
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
      // as does the cwd (it can change mid-session).
      if (entry.type === 'turn_context') {
        model = entry.payload?.model ?? model;
        project = entry.payload?.cwd ?? project;
        return;
      }
      // Agent identity (v2): computed once per event, before every consumer.
      const agentIdNow = rolloutId && rolloutId !== sessionId ? rolloutId : null;
      if (entry.type === 'response_item' && TOOL_ITEMS.has(entry.payload?.type ?? '')) {
        pendingTools.push(entry.payload?.name ?? entry.payload?.type ?? 'tool');
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
      if (anyTs !== null) prevEventTs = anyTs;
    });

    // Queue the cursor; it is written in commit(), which the CLI calls only after
    // insertEvents succeeded. Writing it here was NOT safe despite the old comment:
    // setState autocommits immediately while insertEvents runs in a transaction, so
    // a failed or interrupted store left the cursor advanced — and the (size, mtime)
    // gate above then skips the file forever, because a finished rollout never grows
    // again. Those events became permanently unreachable. claude-code.ts already
    // deferred this correctly.
    pending.push([filePath, st.size, Math.trunc(st.mtimeMs)]);
  }

  return {
    tool: 'codex',
    events,
    filesScanned,
    notes,
    rateLimits,
    commit: () => {
      for (const [p, off, mtime] of pending) setState(db, p, 'codex', off, mtime);
    },
  };
}
