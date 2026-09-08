import { dirname } from 'node:path';
import type { DB } from '../db';
import { COMMAND_PATTERNS } from './patterns';

/**
 * anomaly_context (feature 9): the blast radius attached to every behaviour
 * incident, computed from the tool-call and file-write ledgers over the
 * incident's own window and upserted ONLY when window_end grows — which keeps
 * collection idempotent without entangling it with the anomalies upsert
 * semantics. Reach is only what the ledger recorded: unresolved shell redirect
 * targets appear as NULL-path rows, never as zero.
 */

export interface AnomalyContextRow {
  anomaly_key: string;
  distinct_files: number;
  distinct_dirs: number;
  out_of_repo_writes: number;
  destructive_calls: number;
  failed_calls: number;
  unknown_outcome_calls: number;
  top_path_classes: string | null; // JSON: [{class, count}] top 5
  contributing_sessions: string | null; // JSON: [session ids]
  window_end: number;
}

// The destructive heads, derived from the single versioned pack: each
// destructive pattern is /^<head>\b, so the head is the source minus anchors.
const DESTRUCTIVE_HEADS = new Set(
  COMMAND_PATTERNS.filter((p) => p.class === 'destructive').map((p) =>
    p.re.source.replace(/^\^/, '').replace(/\\b.*$/, ''),
  ),
);

function isDestructiveShape(shape: string | null): boolean {
  if (!shape) return false;
  return DESTRUCTIVE_HEADS.has(shape.split(/\s+/)[0]!);
}

/**
 * Recompute reach for every anomaly of one source partition and upsert the
 * rows whose window_end grew. Sessions = the anomaly's session plus its
 * subagent children from agent_edges (their calls carry the parent session_id
 * in tool_calls, but a child edge names them explicitly).
 */
export function upsertAnomalyContext(db: DB, source: 'live' | 'seed' = 'live'): number {
  const anomalies = db
    .prepare(
      `SELECT anomaly_key, session_id, window_start, window_end FROM anomalies
       WHERE source = ? AND session_id IS NOT NULL`,
    )
    .all(source) as { anomaly_key: string; session_id: string; window_start: number; window_end: number }[];
  if (!anomalies.length) return 0;

  const childStmt = db.prepare('SELECT agent_id FROM agent_edges WHERE session_id = ?');
  const callsStmt = db.prepare(
    `SELECT shape, status FROM tool_calls
     WHERE ts BETWEEN ? AND ? AND session_id IN (SELECT value FROM json_each(?))`,
  );
  const writeStmt = db.prepare(
    `SELECT path, path_class, visibility_class FROM file_writes
     WHERE ts BETWEEN ? AND ? AND session_id IN (SELECT value FROM json_each(?))`,
  );
  const storedStmt = db.prepare('SELECT window_end FROM anomaly_context WHERE anomaly_key = ?');
  const insert = db.prepare(
    `INSERT INTO anomaly_context (
       anomaly_key, distinct_files, distinct_dirs, out_of_repo_writes,
       destructive_calls, failed_calls, unknown_outcome_calls,
       top_path_classes, contributing_sessions, window_end
     ) VALUES (@anomaly_key, @distinct_files, @distinct_dirs, @out_of_repo_writes,
       @destructive_calls, @failed_calls, @unknown_outcome_calls,
       @top_path_classes, @contributing_sessions, @window_end)
     ON CONFLICT(anomaly_key) DO UPDATE SET
       distinct_files = excluded.distinct_files,
       distinct_dirs = excluded.distinct_dirs,
       out_of_repo_writes = excluded.out_of_repo_writes,
       destructive_calls = excluded.destructive_calls,
       failed_calls = excluded.failed_calls,
       unknown_outcome_calls = excluded.unknown_outcome_calls,
       top_path_classes = excluded.top_path_classes,
       contributing_sessions = excluded.contributing_sessions,
       window_end = excluded.window_end`,
  );

  let changed = 0;
  for (const a of anomalies) {
    const stored = storedStmt.get(a.anomaly_key) as { window_end: number } | undefined;
    if (stored && a.window_end <= stored.window_end) continue; // only when window_end grows

    const children = (childStmt.all(a.session_id) as { agent_id: string | null }[])
      .map((c) => c.agent_id)
      .filter((c): c is string => c !== null);
    const sessions = [a.session_id, ...children];
    const sessionsJson = JSON.stringify(sessions);

    const writes = writeStmt.all(a.window_start, a.window_end, sessionsJson) as {
      path: string | null; path_class: string | null; visibility_class: string | null;
    }[];
    const calls = callsStmt.all(a.window_start, a.window_end, sessionsJson) as {
      shape: string | null; status: string | null;
    }[];

    const paths = writes.map((w) => w.path).filter((p): p is string => p !== null);
    const classCounts = new Map<string, number>();
    for (const w of writes) {
      if (w.path_class) classCounts.set(w.path_class, (classCounts.get(w.path_class) ?? 0) + 1);
    }
    const top = [...classCounts.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 5)
      .map(([c, n]) => ({ class: c, count: n }));

    const row: AnomalyContextRow = {
      anomaly_key: a.anomaly_key,
      distinct_files: new Set(paths).size,
      distinct_dirs: new Set(paths.map(dirname)).size,
      out_of_repo_writes: writes.filter((w) => w.visibility_class === 'outside_repo').length,
      destructive_calls: calls.filter((c) => isDestructiveShape(c.shape)).length,
      failed_calls: calls.filter((c) => c.status === 'error').length,
      unknown_outcome_calls: calls.filter((c) => c.status === null).length,
      top_path_classes: top.length ? JSON.stringify(top) : null,
      contributing_sessions: JSON.stringify(sessions),
      window_end: a.window_end,
    };
    changed += insert.run(row as unknown as Record<string, unknown>).changes;
  }
  return changed;
}
