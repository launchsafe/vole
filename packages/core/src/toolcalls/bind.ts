import { createHash } from 'node:crypto';
import type { DB } from '../db';

/**
 * The tool-call ledger's write path — the Tier 5 seam every behaviour rule
 * reads from. One row per tool INVOCATION with a source-native key, filled in
 * two phases: the call arrives first (often with NULL outcome), the result
 * widens it later. The bind is NULL-ONLY: a stored fact is never overwritten,
 * only a NULL may be filled — so a late-arriving result from a later pass
 * completes the row, and re-reading old data is always a no-op.
 */

export type CallStatus = 'success' | 'error' | 'denied' | 'none';
export type StatusSource = 'result_flag' | 'exit_code' | 'log_flag' | 'turn_status';
export type Authority = 'denied' | 'pre_authorised' | 'posture_waived' | 'no_record';
export type CallDurationKind = 'measured' | 'turn_scoped' | null;

export interface ToolCallRow {
  tool_call_key: string;
  tool: string;
  name: string;
  shape?: string | null;
  args_digest?: string | null;
  session_id?: string | null;
  agent_id?: string | null;
  ts: number;
  status?: CallStatus | null;
  status_source?: StatusSource | null;
  duration_ms?: number | null;
  duration_kind?: CallDurationKind;
  authority?: Authority | null;
  raw_ref?: string | null;
}

/**
 * The command-shape skeleton: structure, never content. `rm -rf /tmp/build`
 * and `rm -rf /Users/x/secret` are the SAME shape (`rm -rf *`) — which is the
 * point: rules match classes of command, the ledger never stores the string.
 * Only the first argv token and its known flags survive; everything else
 * collapses to `*`.
 */
const SHAPE_FLAGS: Record<string, string[]> = {
  rm: ['-rf', '-fr', '-r', '-f'],
  ssh: ['-t', '-p'],
  scp: ['-r', '-P'],
  rsync: ['-a', '-v', '-z', '--delete'],
  docker: ['exec', 'run', 'ps', 'build', 'kill', 'rm'],
  kubectl: ['exec', 'get', 'delete', 'apply', 'logs'],
  git: ['push', 'pull', 'commit', 'reset', 'checkout', 'clone', 'clean'],
  claude: ['-p', '--dangerously-skip-permissions', '--print'],
  curl: ['-X', '-d', '-H', '-L', '-s'],
  psql: ['-c', '-U', '-h'],
  mysql: ['-e', '-u', '-h'],
};

export function skeletonize(name: string, args: unknown): string | null {
  // Structural path tags: the DIRECTORY is the signal, never the file's content.
  // 'cat ~/.ssh/id_rsa' and 'Read .env' carry their risk in the path itself.
  const text = typeof args === 'string' ? args : JSON.stringify(args ?? '');
  const tags: string[] = [];
  if (/~\/\.ssh|\.ssh\/|id_rsa|id_ed25519|\.pem\b|\.env\b|credentials|\.aws|\.netrc|keychain/i.test(text)) {
    tags.push('sensitive');
  }
  if (/LaunchAgents|LaunchDaemons|crontab|\/etc\/periodic|StartupItems/i.test(text)) {
    tags.push('persistence');
  }
  // Own-permission edits only: reading settings to CHECK permissions is routine;
  // writing them is the agent changing its own guardrails.
  if (/\.claude\/settings|settings\.local\.json|\.codex\/config/i.test(text) &&
      /(cp|mv|tee|chmod|sed -i|rm|>|Write|Edit)/.test(name + ' ' + text.slice(0, 200))) {
    tags.push('own-permissions');
  }
  const base = shellShape(name, args);
  return tags.length ? `${base} [${tags.join(',')}]` : base;
}

function shellShape(name: string, args: unknown): string | null {
  if (name !== 'Bash' && name !== 'bash' && name !== 'shell' && name !== 'exec_command') {
    // Non-shell tools: the tool name IS the shape.
    return name;
  }
  const cmd = typeof args === 'string' ? args : extractCommand(args);
  if (!cmd) return name;
  const tokens = cmd.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return name;
  const head = tokens[0]!.replace(/^["']|["']$/g, '');
  const flags = SHAPE_FLAGS[head];
  if (!flags) return head; // unknown binary: shape is just the program
  const kept = tokens.slice(1).filter((t) => flags.includes(t));
  return kept.length ? `${head} ${kept.join(' ')}` : head;
}

function extractCommand(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const c = a.command ?? a.cmd ?? a.script ?? a.input ?? a.body;
  return typeof c === 'string' ? c : null;
}

/** A digest of the full arguments — the repeat-detection key. Content-derived,
 *  content-free: identical calls collide, different calls (almost) never. */
export function argsDigest(args: unknown): string | null {
  if (args === undefined || args === null) return null;
  const canonical = typeof args === 'string' ? args : stableStringify(args);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

const INSERT_CALL = `
INSERT INTO tool_calls (
  tool_call_key, tool, name, shape, args_digest, session_id, agent_id, ts,
  status, status_source, duration_ms, duration_kind, authority, raw_ref,
  first_seen, last_seen
) VALUES (
  @tool_call_key, @tool, @name, @shape, @args_digest, @session_id, @agent_id, @ts,
  @status, @status_source, @duration_ms, @duration_kind, @authority, @raw_ref,
  @now, @now
)
ON CONFLICT(tool_call_key) DO UPDATE SET
  status        = CASE WHEN tool_calls.status IS NULL AND excluded.status IS NOT NULL
                        THEN excluded.status ELSE tool_calls.status END,
  status_source = CASE WHEN tool_calls.status_source IS NULL AND excluded.status_source IS NOT NULL
                        THEN excluded.status_source ELSE tool_calls.status_source END,
  duration_ms   = CASE WHEN tool_calls.duration_ms IS NULL AND excluded.duration_ms IS NOT NULL
                        THEN excluded.duration_ms ELSE tool_calls.duration_ms END,
  duration_kind = CASE WHEN tool_calls.duration_kind IS NULL AND excluded.duration_kind IS NOT NULL
                        THEN excluded.duration_kind ELSE tool_calls.duration_kind END,
  authority     = CASE WHEN tool_calls.authority IS NULL AND excluded.authority IS NOT NULL
                        THEN excluded.authority ELSE tool_calls.authority END,
  shape         = CASE WHEN length(COALESCE(excluded.shape, '')) > length(COALESCE(tool_calls.shape, ''))
                        THEN excluded.shape ELSE tool_calls.shape END,
  args_digest   = COALESCE(tool_calls.args_digest, excluded.args_digest),
  session_id    = COALESCE(tool_calls.session_id, excluded.session_id),
  agent_id      = COALESCE(tool_calls.agent_id, excluded.agent_id),
  last_seen     = excluded.last_seen
WHERE (tool_calls.status IS NULL AND excluded.status IS NOT NULL)
   OR (tool_calls.duration_ms IS NULL AND excluded.duration_ms IS NOT NULL)
   OR (tool_calls.authority IS NULL AND excluded.authority IS NOT NULL)
   OR (tool_calls.status_source IS NULL AND excluded.status_source IS NOT NULL)
   OR (length(COALESCE(excluded.shape, '')) > length(COALESCE(tool_calls.shape, '')))`;

/**
 * The two-phase bind. Phase 1 (the call): key + name + shape + digest + ts.
 * Phase 2 (the result): status, duration, authority — each fills a NULL, never
 * overwrites. Re-emitting the same phase is a no-op (the WHERE gates the update
 * on actual widening), so re-reading sources costs nothing.
 *
 * @returns number of rows inserted or widened.
 */
export function insertToolCalls(db: DB, calls: ToolCallRow[]): number {
  if (!calls.length) return 0;
  const stmt = db.prepare(INSERT_CALL);
  const run = db.transaction((rows: ToolCallRow[]) => {
    let changed = 0;
    const now = Date.now();
    for (const r of rows) {
      changed += stmt.run({
        tool_call_key: r.tool_call_key,
        tool: r.tool,
        name: r.name,
        shape: r.shape ?? null,
        args_digest: r.args_digest ?? null,
        session_id: r.session_id ?? null,
        agent_id: r.agent_id ?? null,
        ts: r.ts,
        status: r.status ?? null,
        status_source: r.status_source ?? null,
        duration_ms: r.duration_ms ?? null,
        duration_kind: r.duration_kind ?? null,
        authority: r.authority ?? null,
        raw_ref: r.raw_ref ?? null,
        now,
      }).changes;
    }
    return changed;
  });
  return run(calls);
}
