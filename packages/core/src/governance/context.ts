import { createHmac } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import type { DB } from '../db';
import { deviceKey } from '../identity';

/**
 * execution_context_id and the origin quarantine (tier 3 #16).
 *
 * db.ts stamps os.userInfo().username and os.hostname() on every row at
 * insert, which silently asserts that whoever runs the collector is whoever
 * ran the agent. For a bind-mounted or synced agent home that assertion is
 * false, and the People view would present another machine's work as this
 * employee's. The fix is a context id stamped at insert (the db.ts insert
 * spreads call currentExecutionContext() — the integrator wires it) plus a
 * read-time quarantine: rows whose context differs from this collector's are
 * flagged and banded, never merged into a named principal.
 *
 * A context id is only as good as the evidence that produced it, and there
 * are exactly two kinds of evidence — a foreign root and a declared import —
 * so everything else is 'local' by default and that default is itself an
 * assumption stated here.
 */

export type ContextOrigin = 'local' | 'foreign' | 'imported';

export interface ExecutionContext {
  execution_context_id: string;
  origin: ContextOrigin;
  /** The evidence the classification rests on, in plain words. */
  basis: string;
}

function digest(parts: string): string {
  return createHmac('sha256', 'vole-execution-context').update(parts).digest('hex').slice(0, 16);
}

/**
 * The context THIS collector stamps on rows it inserts. Stable across restarts
 * (derived from the device key and the OS user, never from a clock), so
 * re-collection is idempotent and rows land in the same context band.
 */
export function currentExecutionContext(): ExecutionContext {
  let user = 'unknown';
  try {
    user = userInfo().username || 'unknown';
  } catch {
    /* container without resolvable uid */
  }
  return {
    execution_context_id: `ctx:${digest(`${deviceKey()}:${user}`)}`,
    origin: 'local',
    basis: 'collected on this machine by a local collector — the default and itself an assumption (no foreign root, no import receipt)',
  };
}

/**
 * A foreign context: rows whose agent home lives on another filesystem (a
 * bind-mounted or synced root). The root path is hashed, never stored raw.
 */
export function foreignContext(rootPath: string): ExecutionContext {
  return {
    execution_context_id: `ctx:${digest(`foreign:${rootPath}`)}`,
    origin: 'foreign',
    basis: `agent home outside this machine's own roots (foreign root, path hashed): ${digest(`foreign-path:${rootPath}`)}`,
  };
}

/** A declared import: rows that arrived via a recorded import receipt (context_imports). */
export function importedContext(receiptKey: string): ExecutionContext {
  return {
    execution_context_id: `ctx:${digest(`import:${receiptKey}`)}`,
    origin: 'imported',
    basis: `declared import with receipt ${receiptKey}`,
  };
}

export interface OriginBands {
  /** rows stamped with this collector's own context. */
  this_machine: number;
  /** rows stamped with a different, KNOWN context — flagged, never merged into a named principal. */
  other_contexts: number;
  /** rows with NULL context — collected before the column existed; unknown, shown even when zero. */
  origin_unknown: number;
}

/**
 * The read-time quarantine: every usage row banded by context. The People view
 * renders 'this machine' / 'other contexts' bands, and the unknown-origin
 * band is shown even when empty so its absence is a measurement.
 */
export function originBands(db: DB, current: ExecutionContext = currentExecutionContext()): OriginBands {
  const rows = db
    .prepare(
      `SELECT execution_context_id, COUNT(*) AS n FROM usage_events
       WHERE source = 'live' GROUP BY execution_context_id`,
    )
    .all() as { execution_context_id: string | null; n: number }[];
  const bands: OriginBands = { this_machine: 0, other_contexts: 0, origin_unknown: 0 };
  for (const r of rows) {
    if (r.execution_context_id === null) bands.origin_unknown += r.n;
    else if (r.execution_context_id === current.execution_context_id) bands.this_machine += r.n;
    else bands.other_contexts += r.n;
  }
  return bands;
}

/** The other-context rows themselves, for the quarantine band / your-own-rows inspector. */
export function quarantinedRows(
  db: DB,
  current: ExecutionContext = currentExecutionContext(),
  limit = 100,
): { execution_context_id: string; tool: string; sessions: number; rows: number }[] {
  return db
    .prepare(
      `SELECT execution_context_id, tool, COUNT(DISTINCT session_id) AS sessions, COUNT(*) AS rows
       FROM usage_events
       WHERE source = 'live' AND execution_context_id IS NOT NULL AND execution_context_id != ?
       GROUP BY execution_context_id, tool LIMIT ?`,
    )
    .all(current.execution_context_id, limit) as { execution_context_id: string; tool: string; sessions: number; rows: number }[];
}

/** Is a row's context this collector's? NULL is unknown, never 'local'. */
export function isOwnContext(rowContext: string | null, current: ExecutionContext = currentExecutionContext()): boolean | null {
  if (rowContext === null) return null;
  return rowContext === current.execution_context_id;
}
