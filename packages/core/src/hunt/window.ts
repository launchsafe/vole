import { createHash } from 'node:crypto';
import type { DB } from '../db';

/**
 * The window hunt (tier 6 #27): every first appearance across the ledgers that
 * already carry a first_seen (or a MIN(ts) that is one), inside [A,B].
 * Read-only over the store — the only write is the hunt_runs receipt, keyed
 * deterministically (pack + signature + window), never on now().
 *
 * first_seen is FIRST OBSERVED, not first present: anything whose first
 * observation coincides with the answerable_from floor is reported floored and
 * can never be claimed to have arrived inside the window. An artifact that
 * arrived and was removed before the collector's first pass leaves nothing
 * here — only the residue hunt can reach it.
 */

export interface WindowHit {
  ledger: string;
  /** Stable identity inside the ledger (package name, mcp_identity, host, ...). */
  identity: string;
  /** Human label for the row that jumps to the owning ledger card. */
  label: string;
  first_seen: number;
  floored: boolean;
}

export interface WindowHuntResult {
  a: number;
  b: number;
  hits: WindowHit[];
  ledgersScanned: string[];
}

interface LedgerQuery {
  ledger: string;
  sql: string;
  identity: (r: Record<string, unknown>) => { identity: string; label: string };
}

/** Each entry: the ledger, its first-appearance query, its identity field. */
const LEDGERS: LedgerQuery[] = [
  {
    ledger: 'package_execs',
    sql: 'SELECT package_name AS id, MIN(ts) AS first_ts FROM package_execs WHERE package_name IS NOT NULL GROUP BY package_name',
    identity: (r) => ({ identity: String(r.id), label: String(r.id) }),
  },
  {
    ledger: 'posture_mcp_servers',
    sql: 'SELECT mcp_identity AS id, client AS label, MIN(first_seen) AS first_ts FROM posture_mcp_servers GROUP BY mcp_identity',
    identity: (r) => ({ identity: String(r.id), label: `${r.label ?? r.id}` }),
  },
  {
    ledger: 'hook_ledger',
    sql: 'SELECT agent AS agent, command_hash AS id, MIN(first_seen) AS first_ts FROM hook_ledger GROUP BY agent, command_hash',
    identity: (r) => ({ identity: `${r.agent}:${r.id}`, label: `${r.agent} hook ${String(r.id).slice(0, 12)}` }),
  },
  {
    ledger: 'ai_surfaces',
    sql: 'SELECT surface_key AS id, name AS label, MIN(first_seen) AS first_ts FROM ai_surfaces GROUP BY surface_key',
    identity: (r) => ({ identity: String(r.id), label: String(r.label ?? r.id) }),
  },
  {
    ledger: 'context_edges',
    sql: 'SELECT destination AS id, MIN(ts) AS first_ts FROM context_edges WHERE destination IS NOT NULL GROUP BY destination',
    identity: (r) => ({ identity: String(r.id), label: String(r.id) }),
  },
  {
    ledger: 'plugins',
    sql: 'SELECT agent AS agent, name AS id, MIN(first_seen) AS first_ts FROM plugins GROUP BY agent, name',
    identity: (r) => ({ identity: `${r.agent}:${r.id}`, label: `${r.agent} plugin ${r.id}` }),
  },
  {
    ledger: 'work_roots',
    sql: 'SELECT root_path AS id, MIN(first_seen) AS first_ts FROM work_roots GROUP BY root_path',
    identity: (r) => ({ identity: String(r.id), label: String(r.id) }),
  },
  {
    ledger: 'extension_versions',
    sql: 'SELECT root AS root, ext_id AS id, version AS ver, MIN(first_seen) AS first_ts FROM extension_versions GROUP BY root, ext_id, version',
    identity: (r) => ({ identity: `${r.root}:${r.id}:${r.ver}`, label: `${r.id} ${r.ver}` }),
  },
  {
    ledger: 'agent_roots',
    sql: 'SELECT root_path AS id, tool AS label, MIN(first_seen) AS first_ts FROM agent_roots GROUP BY root_path',
    identity: (r) => ({ identity: String(r.id), label: String(r.label ?? r.id) }),
  },
];

/** The answerable_from floors, per ledger: before this ts, 'not seen' cannot be claimed. */
function floorsByLedger(db: DB): Map<string, number> {
  const rows = db
    .prepare("SELECT source, horizon_ts FROM answerable_from WHERE indicator_kind = 'first_seen'")
    .all() as Array<{ source: string; horizon_ts: number | null }>;
  const out = new Map<string, number>();
  for (const r of rows) if (r.horizon_ts !== null) out.set(r.source, r.horizon_ts);
  return out;
}

/** The single-grouped list the Triage date-range picker renders. */
export function huntWindow(db: DB, a: number, b: number): WindowHuntResult {
  const floors = floorsByLedger(db);
  const hits: WindowHit[] = [];
  for (const { ledger, sql, identity } of LEDGERS) {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
    } catch {
      continue; // a ledger this store predates: absent, not empty
    }
    const floor = floors.get(ledger) ?? null;
    for (const r of rows) {
      const first = Number(r.first_ts);
      if (!Number.isFinite(first) || first < a || first > b) continue;
      const { identity: id, label } = identity(r);
      hits.push({ ledger, identity: id, label, first_seen: first, floored: floor !== null && first <= floor });
    }
  }
  hits.sort((x, y) => x.first_seen - y.first_seen || x.ledger.localeCompare(y.ledger));
  return { a, b, hits, ledgersScanned: LEDGERS.map((l) => l.ledger) };
}

// ── hunt_runs: the receipt (tier 6 #38's "found by hunt run N") ──────────────

export interface HuntRunVerdicts {
  confirmed: number;
  cleared: number;
  unanswerable: number;
  not_seen: number;
}

export interface HuntRunRecord {
  pack_kind: string;
  pack_version: number | null;
  /** Checksum of the pack content the verdicts were computed against. */
  signature: string;
  window: [number, number];
  ran_at: number;
  verdicts: HuntRunVerdicts;
  horizon_ts: number | null;
  answer_sentence: string | null;
}

/** Deterministic: the same pack over the same window is the same hunt. */
export function huntRunId(r: Pick<HuntRunRecord, 'pack_kind' | 'signature' | 'window'>): string {
  return `hunt:${createHash('sha256').update(`${r.pack_kind}|${r.signature}|${r.window[0]}|${r.window[1]}`).digest('hex').slice(0, 24)}`;
}

/**
 * Records the run into hunt_runs. The key carries no now()-derived value
 * (idempotent re-runs of the same hunt update the verdicts, never duplicate).
 */
export function recordHuntRun(db: DB, r: HuntRunRecord): string {
  const hunt_id = huntRunId(r);
  db.prepare(
    `INSERT INTO hunt_runs (
       hunt_id, pack_kind, pack_version, signature, ran_at,
       verdict_confirmed, verdict_cleared, verdict_unanswerable, verdict_not_seen,
       horizon_ts, answer_sentence
     ) VALUES (
       @hunt_id, @pack_kind, @pack_version, @signature, @ran_at,
       @confirmed, @cleared, @unanswerable, @not_seen,
       @horizon_ts, @answer_sentence
     )
     ON CONFLICT(hunt_id) DO UPDATE SET
       ran_at               = excluded.ran_at,
       verdict_confirmed    = excluded.verdict_confirmed,
       verdict_cleared      = excluded.verdict_cleared,
       verdict_unanswerable = excluded.verdict_unanswerable,
       verdict_not_seen     = excluded.verdict_not_seen,
       horizon_ts           = COALESCE(excluded.horizon_ts, hunt_runs.horizon_ts),
       answer_sentence      = COALESCE(excluded.answer_sentence, hunt_runs.answer_sentence)`,
  ).run({
    hunt_id,
    pack_kind: r.pack_kind,
    pack_version: r.pack_version,
    signature: r.signature,
    ran_at: r.ran_at,
    confirmed: r.verdicts.confirmed,
    cleared: r.verdicts.cleared,
    unanswerable: r.verdicts.unanswerable,
    not_seen: r.verdicts.not_seen,
    horizon_ts: r.horizon_ts,
    answer_sentence: r.answer_sentence,
  });
  return hunt_id;
}
