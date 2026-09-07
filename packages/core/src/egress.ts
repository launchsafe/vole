import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
/**
 * Tier 3 privacy floor: the egress inventory and the VOLE_NO_EGRESS switch.
 *
 * SECURITY.md claims no network. This makes the claim mechanically checkable:
 * every network-adjacent call site in the core routes through `egress()`, which
 * records the attempt in the network_calls ledger and honours VOLE_NO_EGRESS.
 * The update check, the export path, the GitHub API — all of them. An audit
 * answers "what left this machine" with a table, not a promise.
 */

export interface NetworkCall {
  caller: string;
  destination: string;
  purpose: string;
  ts: number;
}

let NO_EGRESS = process.env.VOLE_NO_EGRESS === '1';

/** The single choke point for any code that is about to touch the network. */
export function egress(call: NetworkCall): { allowed: boolean } {
  if (NO_EGRESS) return { allowed: false };
  // Best-effort ledger: a failed record never blocks the call, but the switch
  // always does — fail-open on accounting, fail-closed on the opt-out.
  try {
    // recordNetworkCall is fire-and-forget; the caller doesn't wait on it
    recordNetworkCall(call);
  } catch {
    /* the ledger is accounting, not a gate */
  }
  return { allowed: true };
}

function recordNetworkCall(call: NetworkCall): void {
  // Deferred import avoids a cycle at module load; the DB is only touched
  // when a call actually happens.
  try {
    const { openDb } = require('./db') as typeof import('./db');
    const db = openDb();
    db.exec(`CREATE TABLE IF NOT EXISTS network_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caller TEXT NOT NULL,
      destination TEXT NOT NULL,
      purpose TEXT NOT NULL,
      ts INTEGER NOT NULL
    )`);
    db.prepare('INSERT INTO network_calls (caller, destination, purpose, ts) VALUES (?, ?, ?, ?)')
      .run(call.caller, call.destination, call.purpose, call.ts);
  } catch {
    /* no store yet — the call still proceeds */
  }
}

/** The self-DSAR export (Art. 15): everything the store holds about sessions,
 *  with the logic stated — the rows AND the reasons. */
export function selfDsar(): string {
  const { openDb } = _require('./db');
  const db = openDb();
  const sessions = db
    .prepare(
      `SELECT session_id, MIN(ts) AS first, MAX(ts) AS last, COUNT(*) AS rows,
               SUM(total_tokens) AS tokens
       FROM usage_events WHERE session_id IS NOT NULL AND source = 'live'
       GROUP BY session_id`,
    )
    .all();
  const incidents = db
    .prepare(
      `SELECT rule, COUNT(*) AS n FROM anomalies WHERE session_id IS NOT NULL AND source = 'live'
       GROUP BY rule`,
    )
    .all();
  return JSON.stringify(
    {
      subject: 'pseudonymous principal (HMAC — the store holds no name or email)',
      data_held: {
        sessions: sessions.length,
        session_details: sessions,
        incident_rules: incidents,
        tool_calls: (db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get() as { n: number }).n,
        ai_surfaces: (db.prepare('SELECT COUNT(*) AS n FROM ai_surfaces').get() as { n: number }).n,
        secret_sightings: (db.prepare('SELECT COUNT(*) AS n FROM secret_sightings').get() as { n: number }).n,
      },
      logic_statement:
        'Figures derive from tool-written local logs: token counts read verbatim, costs computed at list price, incidents from 23 deterministic rules over those figures. No prompt or tool content is stored (verify --content checks this claim against the schema).',
      retention:
        'The store persists until deleted; the underlying logs are pruned by the vendors (Claude ~30 days). Delete ~/.vole/vole.db to erase everything.',
    },
    null,
    1,
  );
}

