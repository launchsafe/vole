/**
 * MCP inventory export in server.json shape (feature 43): posture_mcp_servers
 * mapped onto the MCP registry's server.json object (name, description,
 * version, packages[], remotes[]) plus an x-vole block (mcp_identity,
 * first_seen, last_seen, observed_call_count, config_path,
 * instruction_block_sha256). One object per server, deterministic ordering,
 * no generation timestamp in the body — two runs against an unchanged
 * machine diff to nothing, so an org can compare its observed MCP estate
 * against a curated internal registry with plain `diff`.
 *
 * server.json describes a package or registry entry; Vole fills only the
 * fields a local registration actually contains — description, publisher and
 * canonical version are omitted when NULL, never invented.
 */
import { createHash } from 'node:crypto';
import type { DB } from '../db';

export interface ServerJson {
  name: string;
  description?: string;
  version?: string;
  packages?: { registryType: string; identifier: string; version?: string; runtimeHint?: string }[];
  remotes?: { type: string; url: string }[];
  'x-vole': {
    mcp_identity: string;
    first_seen: number;
    last_seen: number;
    observed_call_count: number;
    config_path: string;
    instruction_block_sha256: string | null;
  };
}

export interface McpInventory {
  $schema: 'https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/server.json';
  servers: ServerJson[];
}

/** Deterministic run of servers, ordered by identity, no now() anywhere. */
export function mcpInventory(db: DB): McpInventory {
  // A pre-migration store has no posture plane yet: an empty inventory, not an error.
  const hasTable = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'posture_mcp_servers'`,
  ).get();
  if (!hasTable) return { $schema: 'https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/server.json', servers: [] };
  const hasServerCol = (db.prepare('PRAGMA table_info(tool_calls)').all() as { name: string }[])
    .some((c) => c.name === 'server');
  const servers: {
    source: string; config_path: string; client: string; server_name: string; mcp_identity: string;
    transport: string | null; command: string | null; argv: string | null; url: string | null;
    enabled: number | null; first_seen: number; last_seen: number;
  }[] = hasServerCol ? db.prepare(`
    SELECT source, config_path, client, server_name, mcp_identity, transport,
           command, argv, url, enabled, first_seen, last_seen
    FROM posture_mcp_servers ORDER BY mcp_identity, config_path
  `).all() as {
    source: string; config_path: string; client: string; server_name: string; mcp_identity: string;
    transport: string | null; command: string | null; argv: string | null; url: string | null;
    enabled: number | null; first_seen: number; last_seen: number;
  }[] : [];

  const calls = hasServerCol
    ? db.prepare('SELECT server, COUNT(*) AS n FROM tool_calls WHERE server IS NOT NULL GROUP BY server')
        .all() as { server: string; n: number }[]
    : [];
  const callCount = new Map(calls.map((c) => [c.server, c.n]));

  // Instruction-block digest: the posture plane holds injected-text hashes in
  // its own ledgers, not on posture_mcp_servers — the field stays NULL here
  // (an honest unknown, never a placeholder hash) until that join is wired.
  // ponytail: join posture_injected_text hashes into this export when the
  // posture batch's table lands.

  return {
    $schema: 'https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/server.json',
    servers: servers.map((s) => {
      const entry: ServerJson = {
        name: s.server_name,
        'x-vole': {
          mcp_identity: s.mcp_identity,
          first_seen: s.first_seen,
          last_seen: s.last_seen,
          observed_call_count: callCount.get(s.server_name) ?? 0,
          config_path: s.config_path,
          instruction_block_sha256: null,
        },
      };
      if (s.transport === 'http' || s.transport === 'sse' || (s.url && !s.command)) {
        if (s.url) entry.remotes = [{ type: s.transport === 'sse' ? 'sse' : 'http', url: s.url }];
      }
      if (s.command) {
        const argv = s.argv ? (JSON.parse(s.argv) as string[]) : [];
        // A locally registered `npx -y <pkg>` entry: the registry type is a
        // fact of the command, the canonical version is NULL — unknown.
        const npx = s.command.endsWith('npx') || s.command.endsWith('npx.cmd') || s.command === 'npx';
        const pkgArg = argv.find((a) => !a.startsWith('-'));
        if (npx && pkgArg) {
          entry.packages = [{ registryType: 'npm', identifier: pkgArg, runtimeHint: 'node' }];
        } else {
          entry.packages = [{ registryType: 'local', identifier: s.command }];
        }
      }
      return entry;
    }),
  };
}

/** Deterministic serialization: key order fixed, NULLs omitted, 2-space indent. */
export function mcpInventoryJson(inv: McpInventory): string {
  return JSON.stringify(inv, null, 2) + '\n';
}

/** Deterministic digest of the whole inventory — the diff-equality witness. */
export function mcpInventoryDigest(inv: McpInventory): string {
  return createHash('sha256').update(mcpInventoryJson(inv)).digest('hex');
}
