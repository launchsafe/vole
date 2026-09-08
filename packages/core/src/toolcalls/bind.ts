import { createHash } from 'node:crypto';
import type { DB } from '../db';
import { classifyCommand } from './patterns';

/**
 * The tool-call ledger's write path — the Tier 5 seam every behaviour rule
 * reads from. One row per tool INVOCATION with a source-native key, filled in
 * two phases: the call arrives first (often with NULL outcome), the result
 * widens it later. The bind is NULL-ONLY: a stored fact is never overwritten,
 * only a NULL may be filled — so a late-arriving result from a later pass
 * completes the row, and re-reading old data is always a no-op.
 *
 * Tier 5 deep additions: the mcp__<server>__<tool> split (server + tool_name),
 * four-state authority with evidence for ALL states (not just 'denied'),
 * authorization_basis, and the versioned pattern pack stamp (pattern_id +
 * pack_version). The authority inputs (denial_kind, permission_mode,
 * allowed_tools, command) are derivation-only — never stored, never logged.
 */

export type CallStatus = 'success' | 'error' | 'denied' | 'none';
export type StatusSource = 'result_flag' | 'exit_code' | 'log_flag' | 'turn_status';
export type Authority = 'denied' | 'pre_authorised' | 'posture_waived' | 'no_record';
export type CallDurationKind = 'measured' | 'turn_scoped' | null;
export type { AuthorizationBasis } from '../types';
import type { AuthorizationBasis } from '../types';

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
  // ── derivation-only inputs (never stored) ──
  /** Top-level toolDenialKind on the result entry ('user-rejected', …). */
  denial_kind?: string | null;
  /** The tool_result text matched the versioned denial-phrase list. */
  denied_phrase?: boolean;
  /** Raw posture in force at call time (permissionMode / sandbox_policy.type). */
  permission_mode?: string | null;
  /** allowedTools from the nearest preceding command_permissions attachment. */
  allowed_tools?: string[] | null;
  /** The raw command string, for pattern-pack classification only. */
  command?: string | null;
}

/** permission_mode / sandbox raw string -> normalised autonomy + rank. */
// The autonomy labels are the posture-weight ladder (prompt_each <
// classifier_gated < accept_edits < full_auto) — one vocabulary, not two.
const AUTONOMY: Record<string, { autonomy: string; rank: string }> = {
  'bypassPermissions': { autonomy: 'full_auto', rank: 'bypass' },
  'acceptEdits': { autonomy: 'accept_edits', rank: 'accept_edits' },
  'default': { autonomy: 'prompt_each', rank: 'default' },
  'plan': { autonomy: 'classifier_gated', rank: 'plan' },
  'planMode': { autonomy: 'classifier_gated', rank: 'plan' },
  'auto': { autonomy: 'classifier_gated', rank: 'plan' },
  // Codex sandbox_policy.type values
  'danger-full-access': { autonomy: 'full_auto', rank: 'bypass' },
  'workspace-write': { autonomy: 'accept_edits', rank: 'accept_edits' },
  'read-only': { autonomy: 'prompt_each', rank: 'default' },
};

export function autonomyFor(modeRaw: string | null | undefined): { autonomy: string; rank: string } | null {
  if (!modeRaw) return null;
  return AUTONOMY[modeRaw] ?? null; // an unrecognised raw mode stays unknown — never 'default'
}

/** Split `mcp__<server>__<tool>` into its dimensions (feature 23). */
export function splitMcpName(name: string): { server: string | null; tool_name: string } {
  if (name.startsWith('mcp__')) {
    const rest = name.slice(5);
    const i = rest.indexOf('__');
    if (i > 0) return { server: rest.slice(0, i), tool_name: rest.slice(i + 2) };
  }
  return { server: null, tool_name: name };
}

/**
 * Four-state authority (feature 10) + authorization_basis (feature 8), with the
 * evidence line naming the artifact that proved each state. Precedence: a
 * denial beats a posture waiver beats a rule match — a call inside a bypass
 * interval that was still refused was NOT ungated.
 */
export function resolveAuthority(r: ToolCallRow): {
  authority: Authority | null;
  authority_evidence: string | null;
  authorization_basis: AuthorizationBasis | null;
  autonomy_rank: string | null;
} {
  const denied = Boolean(r.denial_kind) || Boolean(r.denied_phrase);
  const auto = autonomyFor(r.permission_mode);
  const allowed = r.allowed_tools?.includes(r.name) ?? false;
  if (denied) {
    return {
      authority: 'denied',
      authority_evidence: r.denial_kind ? `toolDenialKind=${r.denial_kind}` : 'denial phrase in tool_result',
      authorization_basis: 'human_denied',
      autonomy_rank: null,
    };
  }
  if (auto?.autonomy === 'full_auto') {
    return {
      authority: 'posture_waived',
      authority_evidence: `permissionMode=${r.permission_mode}`,
      authorization_basis: 'bypass_no_gate',
      autonomy_rank: auto.rank,
    };
  }
  if (allowed) {
    return {
      authority: 'pre_authorised',
      authority_evidence: `allowedTools:${r.name}`,
      authorization_basis: 'rule_matched',
      autonomy_rank: auto?.rank ?? null,
    };
  }
  if (auto) {
    return {
      authority: 'no_record',
      authority_evidence: `permissionMode=${r.permission_mode} (no gate recorded for this call)`,
      authorization_basis: 'mode_auto',
      autonomy_rank: auto.rank,
    };
  }
  return { authority: 'no_record', authority_evidence: null, authorization_basis: null, autonomy_rank: null };
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
  server, tool_name, authority_evidence, authorization_basis, pattern_id,
  pack_version, permission_mode, autonomy_rank,
  first_seen, last_seen
) VALUES (
  @tool_call_key, @tool, @name, @shape, @args_digest, @session_id, @agent_id, @ts,
  @status, @status_source, @duration_ms, @duration_kind, @authority, @raw_ref,
  @server, @tool_name, @authority_evidence, @authorization_basis, @pattern_id,
  @pack_version, @permission_mode, @autonomy_rank,
  @now, @now
)
ON CONFLICT(tool_call_key) DO UPDATE SET
  authority     = CASE WHEN excluded.authority = 'denied' THEN 'denied'
                       WHEN tool_calls.authority IS NOT NULL THEN tool_calls.authority
                       ELSE excluded.authority END,
  authority_evidence = CASE WHEN excluded.authority = 'denied' AND tool_calls.authority <> 'denied'
                            THEN excluded.authority_evidence
                            WHEN tool_calls.authority_evidence IS NULL THEN excluded.authority_evidence
                            ELSE tool_calls.authority_evidence END,
  authorization_basis = CASE WHEN excluded.authorization_basis = 'human_denied' AND tool_calls.authorization_basis <> 'human_denied'
                             THEN 'human_denied'
                             WHEN tool_calls.authorization_basis IS NULL THEN excluded.authorization_basis
                             ELSE tool_calls.authorization_basis END,
  status        = CASE WHEN tool_calls.status IS NULL AND excluded.status IS NOT NULL
                        THEN excluded.status ELSE tool_calls.status END,
  status_source = CASE WHEN tool_calls.status_source IS NULL AND excluded.status_source IS NOT NULL
                        THEN excluded.status_source ELSE tool_calls.status_source END,
  duration_ms   = CASE WHEN tool_calls.duration_ms IS NULL AND excluded.duration_ms IS NOT NULL
                        THEN excluded.duration_ms ELSE tool_calls.duration_ms END,
  duration_kind = CASE WHEN tool_calls.duration_kind IS NULL AND excluded.duration_kind IS NOT NULL
                        THEN excluded.duration_kind ELSE tool_calls.duration_kind END,
  shape         = CASE WHEN length(COALESCE(excluded.shape, '')) > length(COALESCE(tool_calls.shape, ''))
                        THEN excluded.shape ELSE tool_calls.shape END,
  args_digest   = COALESCE(tool_calls.args_digest, excluded.args_digest),
  session_id    = COALESCE(tool_calls.session_id, excluded.session_id),
  agent_id      = COALESCE(tool_calls.agent_id, excluded.agent_id),
  server        = COALESCE(tool_calls.server, excluded.server),
  tool_name     = COALESCE(NULLIF(excluded.tool_name, ''), tool_calls.tool_name),
  permission_mode = COALESCE(tool_calls.permission_mode, excluded.permission_mode),
  autonomy_rank = COALESCE(tool_calls.autonomy_rank, excluded.autonomy_rank),
  pattern_id    = COALESCE(tool_calls.pattern_id, excluded.pattern_id),
  pack_version  = COALESCE(tool_calls.pack_version, excluded.pack_version),
  last_seen     = excluded.last_seen
WHERE (tool_calls.status IS NULL AND excluded.status IS NOT NULL)
   OR (tool_calls.duration_ms IS NULL AND excluded.duration_ms IS NOT NULL)
   OR (tool_calls.authority IS NULL AND excluded.authority IS NOT NULL)
   OR (excluded.authority = 'denied' AND tool_calls.authority IS NOT NULL AND tool_calls.authority <> 'denied')
   OR (tool_calls.status_source IS NULL AND excluded.status_source IS NOT NULL)
   OR (tool_calls.authority_evidence IS NULL AND excluded.authority_evidence IS NOT NULL)
   OR (tool_calls.authorization_basis IS NULL AND excluded.authorization_basis IS NOT NULL)
   OR (tool_calls.server IS NULL AND excluded.server IS NOT NULL)
   OR (tool_calls.tool_name IS NULL AND excluded.tool_name IS NOT NULL)
   OR (tool_calls.permission_mode IS NULL AND excluded.permission_mode IS NOT NULL)
   OR (tool_calls.autonomy_rank IS NULL AND excluded.autonomy_rank IS NOT NULL)
   OR (tool_calls.pattern_id IS NULL AND excluded.pattern_id IS NOT NULL)
   OR (length(COALESCE(excluded.shape, '')) > length(COALESCE(tool_calls.shape, '')))`;

/**
 * The two-phase bind. Phase 1 (the call): key + name + shape + digest + ts + the
 * derivation inputs available at issue time (posture, allowedTools). Phase 2
 * (the result): status, duration, denial — each fills a NULL, never overwrites,
 * with the single deliberate exception that a later 'denied' supersedes an
 * earlier weaker authority state, because a refusal is proof a gate existed.
 * Re-emitting the same phase is a no-op, so re-reading sources costs nothing.
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
      const auth = resolveAuthority(r);
      const { server, tool_name } = r.name ? splitMcpName(r.name) : { server: null, tool_name: null };
      const classified = r.command ? classifyCommand(r.command) : null;
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
        authority: auth.authority ?? r.authority ?? null,
        raw_ref: r.raw_ref ?? null,
        server,
        tool_name,
        authority_evidence: auth.authority_evidence,
        authorization_basis: auth.authorization_basis,
        pattern_id: classified?.pattern_id ?? null,
        pack_version: classified?.pack_version ?? null,
        permission_mode: r.permission_mode ?? null,
        autonomy_rank: auth.autonomy_rank,
        now,
      }).changes;
    }
    return changed;
  });
  return run(calls);
}
