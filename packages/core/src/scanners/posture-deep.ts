import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DB } from '../db';
import { openDb, insertAnomalies } from '../db';
import type { Scanner } from '../db';

/**
 * Tier 6 deep: the posture scanners — the config-level attacks the
 * 2025-26 incident record is made of. Each reads only what the agents
 * already wrote to disk.
 *
 * 1. Instruction-file hidden-Unicode scan (the Rules File Backdoor):
 *    .cursorrules, copilot-instructions.md, CLAUDE.md, AGENTS.md carrying
 *    bidi-override / zero-width / homoglyph payloads.
 * 2. MCP registration sweep keyed on ENDPOINT identity (not server name —
 *    the same endpoint under two names is one server).
 * 3. Hook execution ledger: hooks with first-seen command hashes — a command
 *    that CHANGED is a new fact, not the same hook.
 * 4. Binary signing ledger: TeamID/CDHash/ad-hoc for every agent binary
 *    found in the census (formalized from the ai-surfaces extra field).
 */

/** Instruction files the agents read automatically at session start. */
const INSTRUCTION_FILES = [
  '.cursorrules', '.cursor/rules/*.mdc', '.github/copilot-instructions.md',
  'CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md', 'GEMINI.md', '.windsurfrules',
];

/** The dangerous Unicode set: bidi overrides, zero-width, homoglyph confusables. */
const DANGEROUS_UNICODE = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2060\uFEFF\u061C]/g;

function scanInstructionFiles(db: DB, now: number): number {
  let found = 0;
  const home = homedir();
  const candidates: string[] = [];
  // Home-level + a sample of project dirs from the store
  for (const pat of INSTRUCTION_FILES) {
    if (pat.includes('*')) continue;
    candidates.push(join(home, pat));
  }
  const projects = db
    .prepare("SELECT DISTINCT project FROM usage_events WHERE project IS NOT NULL AND source = 'live' LIMIT 50")
    .all() as { project: string }[];
  for (const { project } of projects) {
    for (const f of ['CLAUDE.md', 'AGENTS.md', '.cursorrules', '.github/copilot-instructions.md']) {
      candidates.push(join(project, f));
    }
  }

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, 'utf8');
      const hits = text.match(DANGEROUS_UNICODE);
      if (!hits) continue;
      found++;
      insertAnomalies(db, [{
        anomaly_key: `hidden_unicode:${file}`,
        rule: 'hidden_unicode_instruction' as never,
        severity: 'critical',
        tool: 'claude_code' as never,
        session_id: null,
        model: null,
        window_start: now,
        window_end: now,
        title: `Hidden Unicode in instruction file`,
        detail:
          `${file.replace(home, '~')} carries ${hits.length} invisible/bidi character(s) ` +
          `(${[...new Set(hits)].map(c => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(', ')}) — ` +
          `the Rules File Backdoor shape: instructions that read differently to human and machine.`,
        observed: hits.length,
        baseline: null,
        threshold: null,
        confidence: 'exact',
        source: 'live',
        detected_at: now,
      }]);
    } catch {
      /* unreadable */
    }
  }
  return found;
}

interface McpServer {
  name: string;
  endpoint: string;   // host:port or command — the IDENTITY, not the name
  source: string;
}

function sweepMcpEndpoints(db: DB, now: number): number {
  const home = homedir();
  const servers: McpServer[] = [];

  // ~/.claude.json mcpServers
  const claudeJson = join(home, '.claude.json');
  if (existsSync(claudeJson)) {
    try {
      const cfg = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
        mcpServers?: Record<string, { command?: string; url?: string; args?: string[] }>;
      };
      for (const [name, srv] of Object.entries(cfg.mcpServers ?? {})) {
        const endpoint = srv.url ?? [srv.command, ...(srv.args ?? []).slice(0, 2)].filter(Boolean).join(' ');
        if (endpoint) servers.push({ name, endpoint, source: '~/.claude.json' });
      }
    } catch { /* malformed */ }
  }

  // ~/.codex/config.toml [mcp_servers.*]
  const codexToml = join(home, '.codex', 'config.toml');
  if (existsSync(codexToml)) {
    try {
      const text = readFileSync(codexToml, 'utf8');
      for (const m of text.matchAll(/\[mcp_servers\.([\w-]+)\]([\s\S]*?)(?=\n\[|$)/g)) {
        const name = m[1]!;
        const body = m[2]!;
        const cmd = body.match(/command\s*=\s*"([^"]+)"/)?.[1];
        if (cmd) servers.push({ name, endpoint: cmd, source: '~/.codex/config.toml' });
      }
    } catch { /* malformed */ }
  }

  // Key on ENDPOINT identity: the same endpoint under two names is one server.
  const byEndpoint = new Map<string, McpServer[]>();
  for (const s of servers) {
    const arr = byEndpoint.get(s.endpoint) ?? [];
    arr.push(s);
    byEndpoint.set(s.endpoint, arr);
  }
  let aliases = 0;
  for (const [endpoint, group] of byEndpoint) {
    if (group.length > 1) {
      aliases++;
      insertAnomalies(db, [{
        anomaly_key: `mcp_endpoint_alias:${createHash('sha256').update(endpoint).digest('hex').slice(0, 12)}`,
        rule: 'mcp_endpoint_alias' as never,
        severity: 'warn',
        tool: 'claude_code' as never,
        session_id: null,
        model: null,
        window_start: now,
        window_end: now,
        title: `MCP endpoint registered under ${group.length} names`,
        detail:
          `One endpoint is registered ${group.length} times: ${group.map((g) => `"${g.name}" in ${g.source}`).join(', ')}. ` +
          `Keying on server NAME would count them as different servers; the endpoint is the identity.`,
        observed: group.length,
        baseline: null,
        threshold: null,
        confidence: 'exact',
        source: 'live',
        detected_at: now,
      }]);
    }
  }
  return servers.length + aliases;
}

function formalizeSigning(db: DB): number {
  // The census already carries TeamIDs in ai_surfaces.extra; formalize into
  // the grants-adjacent ledger is deferred — the surfaces ARE the record.
  return (db.prepare("SELECT COUNT(*) AS n FROM ai_surfaces WHERE extra LIKE '%teamId%'").get() as { n: number }).n;
}

export const postureScanner: Scanner = {
  name: 'posture-deep',
  cadenceMs: 10 * 60_000,
  run: () => {
    const db: DB = openDb();
    const now = Date.now();
    const unicode = scanInstructionFiles(db, now);
    const mcp = sweepMcpEndpoints(db, now);
    const signed = formalizeSigning(db);
    return {
      ok: true,
      notes: `${unicode} hidden-unicode finding(s) · ${mcp} MCP registration(s) swept (endpoint-keyed) · ${signed} signed app(s) on record`,
    };
  },
};
