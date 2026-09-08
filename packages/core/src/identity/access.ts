/**
 * Tier 3 — view-governance helpers shared by the CLI and the MCP server
 * (features 15/20/42): the access log, the people_view gate, the MCP master
 * off switch and caller identity.
 *
 * A local admin holding the SQLite file bypasses every gate — this is the
 * product's default behaviour plus an audit trail, not a security boundary
 * against the machine's owner.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { DB } from '../db';
import { paths } from '../paths';
import type { IdentityPolicy } from './policy';

/** Who is asking: stdio MCP carries no authenticated caller, so parent pid + cwd + OS user is the strongest evidence available. */
export function callerIdentity(): { pid: number; cwd: string; user: string | null } {
  let user: string | null = null;
  try {
    user = userInfo().username || null;
  } catch {
    /* uid unreadable */
  }
  return { pid: process.ppid, cwd: process.cwd(), user };
}

/** One row in the view-governance ledger: who looked at per-person data, under which purpose. */
export function logAccess(db: DB, accessor: string, purpose: string, view: string, ts = Date.now()): void {
  db.prepare('INSERT INTO access_log (accessor, purpose, view, ts) VALUES (?, ?, ?, ?)').run(accessor, purpose, view, ts);
}

/**
 * The per-person view gate (feature 20): the People view refuses to render a
 * multi-person table unless a people_view {enabled, granted_to, reason} block
 * exists in the policy file — its absence is a hard off, not a warning.
 */
export function peopleViewGranted(policy: IdentityPolicy | null): boolean {
  return policy?.people_view?.enabled === true;
}

export interface McpGate {
  enabled: boolean;
  source: string;
}

/**
 * The MCP master off switch (feature 15), in precedence order: VOLE_MCP_OFF
 * (any invocation the machine's owner controls) > the managed declaration >
 * the per-user declaration. Default on — but off at either declaration wins.
 */
export function mcpEnabled(): McpGate {
  if (process.env.VOLE_MCP_OFF) return { enabled: false, source: 'env VOLE_MCP_OFF' };
  const files = [
    join(paths.managedRoot(), 'mcp.json'),
    join(process.env.VOLE_HOME_OVERRIDE ?? homedir(), '.vole', 'mcp.json'),
  ];
  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      const cfg = JSON.parse(readFileSync(f, 'utf8')) as { enabled?: boolean };
      if (cfg.enabled === false) return { enabled: false, source: f };
    } catch {
      /* malformed: skip the layer */
    }
  }
  return { enabled: true, source: 'default (on)' };
}

/**
 * The multi-principal gate `vole whoami` and the vole_identity MCP tool honour:
 * on a store with more than one principal they return only the caller's own
 * principal unless people_view is granted (feature 42).
 */
export function restrictToCallerPrincipal(db: DB, policy: IdentityPolicy | null): boolean {
  if (peopleViewGranted(policy)) return false;
  const n = (db.prepare('SELECT COUNT(*) AS n FROM principals').get() as { n: number }).n;
  return n > 1;
}
