import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db';
import { insertAnomalies } from '../db';
import { paths } from '../paths';
import {
  home, sha, readJson, readJsonc, parseToml, bumpCounter, knownProjectRoots,
  type PostureState,
} from './shared';

/**
 * The MCP posture plane, keyed on ENDPOINT identity — the same endpoint under
 * two display names is one server, because a name is a choice and an endpoint
 * is a fact. Covers every client config on the machine, the registered-vs-
 * observed spend join, the shadow set, the instruction rug-pull detector and
 * the offered-tool-surface ledger.
 *
 * Never stored: env var VALUES, header values, key values. Key NAMES only.
 */

export interface McpRegistration {
  client: string;       // claude_code | codex | opencode | cursor
  server_name: string;
  config_path: string;
  transport: 'stdio' | 'http' | null;
  command: string | null;
  argv: string | null;  // JSON array text of args
  url: string | null;
  cwd: string | null;
  enabled: number | null; // 1/0; NULL when the config states nothing
  env_key_names: string | null; // sorted, comma-joined
}

interface RawServer {
  command?: string;
  args?: string[];
  url?: string;
  cwd?: string;
  env?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  enabled?: boolean;
  type?: string;
}

/**
 * mcp_identity = sha256 over the normalised endpoint: transport, command, argv
 * array, cwd, url and the SORTED KEY NAMES of env/headers — never the values,
 * never the display name. A relative command is hashed as-written (spec: its
 * identity is recorded and flagged unresolvable, not silently resolved).
 */
export function mcpIdentity(r: Omit<McpRegistration, 'client' | 'server_name' | 'config_path' | 'enabled'>): string {
  return sha(JSON.stringify({
    transport: r.transport,
    command: r.command ?? null,
    argv: r.argv ? (JSON.parse(r.argv) as string[]) : null,
    cwd: r.cwd ?? null,
    url: r.url ?? null,
    envKeys: r.env_key_names ? r.env_key_names.split(',').sort() : null,
  }));
}

function fromRaw(client: string, name: string, configPath: string, srv: RawServer): McpRegistration | null {
  const transport = srv.url ? 'http' : srv.command ? 'stdio' : null;
  if (!transport) return null; // no endpoint at all: not a server Vole can key on
  return {
    client,
    server_name: name,
    config_path: configPath,
    transport,
    command: srv.command ?? null,
    argv: srv.args?.length ? JSON.stringify(srv.args) : null,
    url: srv.url ?? null,
    cwd: srv.cwd ?? null,
    enabled: srv.enabled === true ? 1 : srv.enabled === false ? 0 : null,
    env_key_names: [...new Set([...Object.keys(srv.env ?? {}), ...Object.keys(srv.headers ?? {})])].sort().join(',') || null,
  };
}

/** The full sweep: every MCP client config on the machine. */
export function collectMcpRegistrations(db: DB): McpRegistration[] {
  const out: McpRegistration[] = [];
  const push = (client: string, name: string, path: string, srv: RawServer) => {
    const r = fromRaw(client, name, path, srv);
    if (r) out.push(r);
  };

  // ~/.claude.json — top-level mcpServers AND per-project mcpServers.
  const claudeJson = join(home(), '.claude.json');
  const cj = readJson(claudeJson) as {
    mcpServers?: Record<string, RawServer>;
    projects?: Record<string, { mcpServers?: Record<string, RawServer>; enabledMcpjsonServers?: string[] }>;
  } | undefined;
  if (cj) {
    for (const [name, srv] of Object.entries(cj.mcpServers ?? {})) push('claude_code', name, claudeJson, srv);
    for (const [cwd, proj] of Object.entries(cj.projects ?? {})) {
      for (const [name, srv] of Object.entries(proj.mcpServers ?? {})) {
        push('claude_code', name, `${claudeJson}#projects[${cwd}]`, srv);
      }
    }
  }

  // Repo .mcp.json under every root Vole has live evidence for.
  for (const root of knownProjectRoots(db)) {
    const f = join(root, '.mcp.json');
    if (!existsSync(f)) continue;
    const m = readJson(f) as { mcpServers?: Record<string, RawServer> } | undefined;
    for (const [name, srv] of Object.entries(m?.mcpServers ?? {})) push('claude_code', name, f, srv);
  }

  // ~/.codex/config.toml [mcp_servers.*]
  const codexToml = join(paths.codexHome(), 'config.toml');
  if (existsSync(codexToml)) {
    try {
      const doc = parseToml(readFileSync(codexToml, 'utf8'));
      for (const [section, kv] of doc.sections) {
        if (!section.startsWith('mcp_servers.')) continue;
        const command = kv.get('command');
        if (typeof command !== 'string') continue;
        const args = kv.get('args');
        push('codex', section.slice('mcp_servers.'.length), codexToml, {
          command,
          args: Array.isArray(args) ? args : undefined,
          env: undefined,
        });
      }
    } catch { /* malformed */ }
  }

  // ~/.config/opencode/opencode.jsonc — { mcp: { name: {...} } }
  const opencode = join(home(), '.config', 'opencode', 'opencode.jsonc');
  const oc = readJsonc(opencode) as { mcp?: Record<string, RawServer> } | undefined;
  for (const [name, srv] of Object.entries(oc?.mcp ?? {})) push('opencode', name, opencode, srv);

  // Cursor: global ~/.cursor/mcp.json (and per-project .cursor/mcp.json).
  const cursorGlobal = join(home(), '.cursor', 'mcp.json');
  const cg = readJson(cursorGlobal) as { mcpServers?: Record<string, RawServer> } | undefined;
  for (const [name, srv] of Object.entries(cg?.mcpServers ?? {})) push('cursor', name, cursorGlobal, srv);
  for (const root of knownProjectRoots(db)) {
    const f = join(root, '.cursor', 'mcp.json');
    if (!existsSync(f)) continue;
    const m = readJson(f) as { mcpServers?: Record<string, RawServer> } | undefined;
    for (const [name, srv] of Object.entries(m?.mcpServers ?? {})) push('cursor', name, f, srv);
  }

  return out;
}

/** Idempotent upsert into posture_mcp_servers on (source='live', mcp_identity). */
export function sweepMcpServers(db: DB, now: number): { registered: number; aliases: number } {
  const regs = collectMcpRegistrations(db);
  const upsert = db.prepare(`
    INSERT INTO posture_mcp_servers (source, config_path, client, server_name, mcp_identity, transport, command, argv, url, cwd, enabled, env_key_names, first_seen, last_seen)
    VALUES ('live', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, mcp_identity) DO UPDATE SET last_seen = excluded.last_seen`);
  // Identity -> the configs that registered it: the alias view. Keying on the
  // display name would count one endpoint as two servers.
  const byIdentity = new Map<string, McpRegistration[]>();
  for (const r of regs) {
    const id = mcpIdentity(r);
    const arr = byIdentity.get(id) ?? [];
    arr.push(r);
    byIdentity.set(id, arr);
    upsert.run(r.config_path, r.client, r.server_name, id, r.transport, r.command, r.argv, r.url, r.cwd, r.enabled, r.env_key_names, now, now);
  }
  let aliases = 0;
  for (const [id, group] of byIdentity) {
    if (group.length < 2) continue;
    aliases++;
    insertAnomalies(db, [{
      anomaly_key: `mcp_endpoint_alias:${id.slice(0, 12)}`,
      rule: 'mcp_endpoint_alias',
      severity: 'warn',
      tool: 'claude_code' as never,
      session_id: null,
      model: null,
      window_start: now,
      window_end: now,
      title: `MCP endpoint registered under ${group.length} names`,
      detail:
        `One endpoint is registered ${group.length} times: ${group.map((g) => `"${g.server_name}" (${g.client}, ${g.config_path})`).join(', ')}. ` +
        `The endpoint is the identity; the display name is a choice.`,
      observed: group.length,
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    }]);
  }
  return { registered: regs.length, aliases };
}

/** Observed server prefixes from the tool ledger (mcp__<server>__<tool>). */
export function observedMcpServers(db: DB): Map<string, { calls: number; sessions: number }> {
  const out = new Map<string, { calls: number; sessions: number }>();
  const rows = db.prepare(`
    SELECT substr(name, 6, instr(substr(name, 6), '__') - 1) AS server,
           COUNT(*) AS calls, COUNT(DISTINCT session_id) AS sessions
    FROM tool_calls
    WHERE name LIKE 'mcp\\_\\_%' ESCAPE '\\' AND session_id IS NOT NULL
    GROUP BY server`).all() as { server: string; calls: number; sessions: number }[];
  for (const r of rows) out.set(r.server, { calls: r.calls, sessions: r.sessions });
  return out;
}

/**
 * The registered-vs-observed join: per server, calls, sessions and the spend
 * side attributed from usage_events rows whose tools column names the server.
 * Every count is a FLOOR: tools is NULL on stop_reason=tool_use rows and six of
 * seven collectors record no tool names at all, so a zero reads 'no call
 * observed in range on this machine', never 'unused'.
 */
export function mcpSpendJoin(db: DB, now: number): { registered: number; observed: number; dormant: number } {
  const observed = observedMcpServers(db);
  const regs = db.prepare("SELECT server_name FROM posture_mcp_servers WHERE source = 'live'").all() as { server_name: string }[];
  const byName = new Set(regs.map((r) => r.server_name));
  const tokensStmt = db.prepare(`
    SELECT SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost FROM usage_events
    WHERE source = 'live' AND tools LIKE '%mcp__' || ? || '__%'`);
  for (const [server, agg] of observed) {
    bumpCounter(db, `mcp:${server}`, 'calls', agg.calls, now);
    bumpCounter(db, `mcp:${server}`, 'sessions', agg.sessions, now);
    const spend = tokensStmt.get(server) as { tokens: number | null; cost: number | null };
    if (spend.tokens !== null) bumpCounter(db, `mcp:${server}`, 'tokens_floor', spend.tokens, now);
    // cost_usd is REAL and surface_activity.counter is INTEGER — the dollar side
    // stays a query (mcpSpendQuery below), never a rounded counter. ponytail: add
    // a REAL column if a stored by-server dollar figure is ever needed.
  }
  let dormant = 0;
  for (const name of byName) {
    if (!observed.has(name)) {
      dormant++;
      bumpCounter(db, `mcp:${name}`, 'dormant', 1, now);
    }
  }
  return { registered: regs.length, observed: observed.size, dormant };
}

/** Shadow MCP: called in the ledgers, present in no local config. */
export function detectShadowMcp(db: DB, now: number): number {
  const observed = observedMcpServers(db);
  if (!observed.size) return 0;
  const configured = new Set(
    (db.prepare("SELECT server_name FROM posture_mcp_servers WHERE source = 'live'").all() as { server_name: string }[]).map((r) => r.server_name),
  );
  let n = 0;
  for (const [server, agg] of observed) {
    if (configured.has(server)) continue;
    n++;
    insertAnomalies(db, [{
      anomaly_key: `shadow_mcp:${sha(server).slice(0, 16)}`,
      rule: 'shadow_mcp_server',
      severity: 'warn',
      tool: 'claude_code' as never,
      session_id: null,
      model: null,
      window_start: now,
      window_end: now,
      title: `Shadow MCP server: "${server}" called but in no local config`,
      detail:
        `The agent called mcp__${server}__ tools ${agg.calls} time(s) across ${agg.sessions} session(s), ` +
        `but no client config on this machine registers a server by that name: ~/.claude.json, repo .mcp.json, ` +
        `Codex config.toml, opencode.jsonc and Cursor mcp.json were all swept. A server reached through the ` +
        `vendor's own proxy leaves no command, URL or transport locally — those fields stay NULL, never guessed.`,
      observed: agg.calls,
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    }]);
  }
  return n;
}

// ── The rug-pull detector ──────────────────────────────────────────────────────
//
// Claude Code persists the full text every MCP server injects into the system
// prompt as attachment.type='mcp_instructions_delta' (addedNames[]/addedBlocks[]).
// Vole keeps sha256 + length + session count per (server, block) — never the
// text — and mcp_instructions_changed fires when a stable server emits a NEW
// hash: instructions that read differently to the human who approved the server
// and to the model that obeys them.

export interface InstructionSighting {
  server: string;
  block_sha: string;
  block_len: number;
  ts: number | null;
}

export function instructionSightingsFromLine(line: Record<string, unknown>): InstructionSighting[] {
  if (line.type !== 'attachment') return [];
  const a = line.attachment as { type?: string; addedNames?: string[]; addedBlocks?: string[] } | undefined;
  if (a?.type !== 'mcp_instructions_delta') return [];
  const names = a.addedNames ?? [];
  const blocks = a.addedBlocks ?? [];
  const out: InstructionSighting[] = [];
  const n = Math.min(names.length, blocks.length);
  for (let i = 0; i < n; i++) {
    const block = blocks[i]!;
    out.push({ server: names[i]!, block_sha: sha(block), block_len: block.length, ts: null });
  }
  return out;
}

export function recordInstructionSightings(
  db: DB, state: PostureState, file: string, sightings: InstructionSighting[], now: number,
): number {
  state.mcpInstructions ??= {};
  // Per (file, server) dedup: a transcript re-read must not re-count a session
  // or re-fire a pull the state has already absorbed.
  state.mcpInstructionFiles ??= {};
  const seenInFile = new Set(state.mcpInstructionFiles[file] ?? []);
  const freshServers = [...new Set(sightings.map((s) => s.server))].filter((s) => !seenInFile.has(s));
  state.mcpInstructionFiles[file] = [...seenInFile, ...freshServers];
  let changed = 0;
  for (const s of sightings) {
    if (!freshServers.includes(s.server)) continue;
    const prev = state.mcpInstructions[s.server];
    if (!prev) {
      state.mcpInstructions[s.server] = { block_sha: s.block_sha, block_len: s.block_len, first_seen: now, last_seen: now, session_count: 1 };
      continue;
    }
    prev.last_seen = now;
    prev.session_count++;
    if (prev.block_sha === s.block_sha) continue;
    changed++;
    insertAnomalies(db, [{
      // Keyed on the OLD hash: one row per pull, not per poll.
      anomaly_key: `mcp_instructions_changed:${sha(s.server)}:${prev.block_sha.slice(0, 12)}`,
      rule: 'mcp_instructions_changed',
      severity: 'critical',
      tool: 'claude_code' as never,
      session_id: null,
      model: null,
      window_start: prev.last_seen,
      window_end: now,
      title: `MCP server "${s.server}" changed its injected instructions`,
      detail:
        `The instructions server "${s.server}" injects into every system prompt changed between observations. ` +
        `Previous block sha256 ${prev.block_sha.slice(0, 16)}… (${prev.block_len} chars, first seen ${new Date(prev.first_seen).toISOString()}); ` +
        `new block sha256 ${s.block_sha.slice(0, 16)}… (${s.block_len} chars). Text is never stored — only the ` +
        `hashes, lengths and dates, which is exactly what proves the rug pull.`,
      observed: 2,
      baseline: prev.block_len,
      threshold: s.block_len,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    }]);
    state.mcpInstructions[s.server] = { ...prev, block_sha: s.block_sha, block_len: s.block_len, first_seen: prev.first_seen };
  }
  return changed;
}

// ── The offered-tool-surface ledger ────────────────────────────────────────────
//
// Config says which servers are registered; the transcript says which tools
// reached the model. deferred_tools_delta (added/removed/readded names),
// agent_listing_delta (added types) and skill_listing (the roster) are counted
// per session; names not traceable to any config are counted separately.
// Names themselves are returned, not stored (the posture_tool_surface table is
// an integration need) — counts land in surface_activity.

export interface ToolSurfaceDelta {
  session: string;
  kind: 'deferred_tools_delta' | 'agent_listing_delta' | 'skill_listing';
  action: 'added' | 'removed' | 'readded' | 'roster';
  names: string[];
}

export function toolSurfaceFromLine(session: string, line: Record<string, unknown>): ToolSurfaceDelta[] {
  if (line.type !== 'attachment') return [];
  const a = line.attachment as {
    type?: string; addedNames?: string[]; removedNames?: string[]; readdedNames?: string[];
    addedTypes?: string[]; addedLines?: string[]; skills?: string[];
  } | undefined;
  if (!a?.type) return [];
  const out: ToolSurfaceDelta[] = [];
  if (a.type === 'deferred_tools_delta') {
    if (a.addedNames?.length) out.push({ session, kind: a.type, action: 'added', names: a.addedNames });
    if (a.removedNames?.length) out.push({ session, kind: a.type, action: 'removed', names: a.removedNames });
    if (a.readdedNames?.length) out.push({ session, kind: a.type, action: 'readded', names: a.readdedNames });
  } else if (a.type === 'agent_listing_delta' && a.addedTypes?.length) {
    out.push({ session, kind: a.type, action: 'added', names: a.addedTypes });
  } else if (a.type === 'skill_listing' && a.addedLines?.length) {
    out.push({ session, kind: a.type, action: 'roster', names: a.addedLines });
  }
  return out;
}

export function recordToolSurface(db: DB, deltas: ToolSurfaceDelta[], now: number): { offered: number; unconfigured: number } {
  const configured = new Set(
    (db.prepare("SELECT server_name FROM posture_mcp_servers WHERE source = 'live'").all() as { server_name: string }[]).map((r) => r.server_name),
  );
  // Per-file batch: one transcript file is one session, so the totals are
  // absolute for that session and MAX keeps a re-read a no-op.
  const totals = new Map<string, number>();
  let offered = 0;
  let unconfigured = 0;
  for (const d of deltas) {
    const k = `${d.kind}:${d.action}`;
    totals.set(k, (totals.get(k) ?? 0) + d.names.length);
    offered += d.names.length;
    for (const name of d.names) {
      if (name.startsWith('mcp__') && !configured.has(name.split('__')[1] ?? '')) unconfigured++;
    }
  }
  if (!deltas.length) return { offered: 0, unconfigured: 0 };
  const session = deltas[0]!.session;
  for (const [k, n] of totals) bumpCounter(db, `tool_surface:${session}`, k, n, now);
  if (unconfigured) bumpCounter(db, `tool_surface:${session}`, 'offered_unconfigured', unconfigured, now);
  return { offered, unconfigured };
}
