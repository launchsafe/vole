import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DB } from '../db';
import { widenUpsert } from './upsert';

/**
 * agent_edges (feature 14): the subagent tree from what the metadata actually
 * carries. The edge is an exact fact of the directory layout:
 *   <projects>/<project>/<parent_session>/subagents/[workflows/<wf>/]agent-<id>.jsonl
 * names both the parent session and the workflow; agent-*.meta.json carries
 * {agentType, spawnDepth} and — on 23 of 479 files here — toolUseId, a foreign
 * key straight into the tool_calls ledger. parent_call_key is NULL whenever the
 * meta carries no toolUseId: it is never guessed from timing.
 */

export interface AgentEdgeRow {
  edge_key: string;
  session_id: string;
  agent_id: string;
  parent_agent_id: string | null;
  workflow_id: string | null;
  agent_type: string | null;
  spawn_depth: number | null;
  parent_call_key: string | null;
}

interface AgentMeta {
  agentType?: string;
  spawnDepth?: number;
  toolUseId?: string;
  parentAgentId?: string;
}

/** Parse one agent-*.meta.json path into an edge. Returns null when the path is
 *  not under a subagents/ directory (no parent is knowable). */
export function agentEdgeFromMeta(metaPath: string): AgentEdgeRow | null {
  const parts = metaPath.split('/');
  const subIdx = parts.lastIndexOf('subagents');
  if (subIdx < 1) return null;
  const parentSession = parts[subIdx - 1]!;
  const file = basename(metaPath);
  if (!file.startsWith('agent-') || !file.endsWith('.meta.json')) return null;
  const child = file.slice('agent-'.length, -'.meta.json'.length);
  if (!child) return null;

  let meta: AgentMeta = {};
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8')) as AgentMeta;
  } catch {
    // An unreadable meta still proves the edge (the directory said it); the
    // metadata columns stay NULL rather than inventing an agentType.
  }

  // workflows/<wf>/ may sit between subagents/ and the file.
  let workflow: string | null = null;
  const between = parts.slice(subIdx + 1, -1);
  const wfIdx = between.indexOf('workflows');
  if (wfIdx >= 0 && between[wfIdx + 1]) workflow = between[wfIdx + 1]!;

  return {
    edge_key: `claude_code:${parentSession}:${child}`,
    session_id: parentSession,
    agent_id: child,
    parent_agent_id: meta.parentAgentId ?? null,
    workflow_id: workflow,
    agent_type: meta.agentType ?? null,
    spawn_depth: typeof meta.spawnDepth === 'number' ? meta.spawnDepth : null,
    parent_call_key: meta.toolUseId ? `claude_code:${meta.toolUseId}` : null,
  };
}

/** Every agent-*.meta.json under a projects root (at any depth). */
export function collectAgentMetaPaths(root: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // vanished or unreadable — skip, do not abort the pass
  }
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) collectAgentMetaPaths(p, out);
    else if (e.isFile() && e.name.startsWith('agent-') && e.name.endsWith('.meta.json')) out.push(p);
  }
  return out;
}

/** Collect + bind in one pass. `root` is the Claude projects root. */
export function collectAgentEdges(db: DB, root: string): number {
  if (!existsSync(root)) return 0;
  const rows = collectAgentMetaPaths(root)
    .map(agentEdgeFromMeta)
    .filter((e): e is AgentEdgeRow => e !== null);
  return insertAgentEdges(db, rows);
}

export function insertAgentEdges(db: DB, rows: AgentEdgeRow[]): number {
  return widenUpsert(db, {
    table: 'agent_edges',
    keyCols: ['edge_key'],
    cols: ['session_id', 'agent_id', 'parent_agent_id', 'workflow_id', 'agent_type', 'spawn_depth', 'parent_call_key'],
    stamped: true,
  }, rows);
}
