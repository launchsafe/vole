import { openDb, type DB } from './db';

/**
 * Tier 3 privacy floor: the egress inventory, the network_calls ledger and the
 * VOLE_NO_EGRESS switch every caller honours.
 *
 * SECURITY.md claims nothing leaves the machine. This makes the claim
 * mechanically checkable: every network-adjacent call site in core routes
 * through `egress()`, which (a) records the attempt in the network_calls
 * ledger — even the denied ones, the ledger is the audit trail — and (b)
 * honours VOLE_NO_EGRESS read at call time, not module-load time, so a reader
 * process (UpdateChecker.swift reads the same env on its side) and a test can
 * both toggle it. Fail-open on accounting, fail-closed on the opt-out: a failed
 * ledger write never blocks or permits anything, the switch always blocks.
 *
 * Dry-run contract for adapters: a vendor/cloud adapter passes its `enabler`
 * flag name. Unless that env flag is exactly '1', egress() returns
 * { allowed: false, dryRun: true } — the adapter must complete without the
 * network, offline, by design. The attempt is still ledgered, so the Privacy
 * Center's network log shows what WOULD have left, which is the honest answer
 * to "what does this build want to send".
 */

export interface NetworkCall {
  /** Call site, stable across builds: 'reconcile:cli' or 'UpdateChecker.swift:74'. */
  caller: string;
  /** host[:path] that would be contacted. */
  destination: string;
  purpose: string;
  /** Env flag that must be '1' for this call to ever be allowed. Absent = disclosed always-on (none today). */
  enabler?: string;
  ts?: number;
}

export interface EgressDecision {
  allowed: boolean;
  /** true when the only thing that stopped it was the missing explicit opt-in. */
  dryRun: boolean;
  /** true when the ledger row landed; accounting is best-effort by contract. */
  recorded: boolean;
  reason: 'no_egress' | 'not_enabled' | 'allowed';
}

/** Read at call time: the reader-side guard (UpdateChecker.swift) and tests must see toggles. */
export function noEgress(): boolean {
  return process.env.VOLE_NO_EGRESS === '1';
}

/** The single choke point for any code that is about to touch the network. */
export function egress(call: NetworkCall): EgressDecision {
  let reason: EgressDecision['reason'];
  if (noEgress()) reason = 'no_egress';
  else if (call.enabler && process.env[call.enabler] !== '1') reason = 'not_enabled';
  else reason = 'allowed';
  let recorded = false;
  try {
    // The ledger row is written for EVERY attempt, allowed or not — a denied
    // attempt is exactly the fact "this build tried to phone home and the
    // switch stopped it", which is what an auditor asks for.
    recordNetworkCall(call, reason);
    recorded = true;
  } catch {
    /* the ledger is accounting, not a gate */
  }
  return {
    allowed: reason === 'allowed',
    dryRun: reason === 'not_enabled',
    recorded,
    reason,
  };
}

function recordNetworkCall(call: NetworkCall, reason: EgressDecision['reason']): void {
  // Table shape is migration 25's — the old CREATE TABLE IF NOT EXISTS here
  // shadowed it and is deliberately gone. A static import (not createRequire)
  // keeps this the SAME db module instance every other writer uses, so the
  // cached handle can never diverge between loaders.
  const db = openDb();
  db.prepare(
    'INSERT INTO network_calls (caller, destination, purpose, ts) VALUES (?, ?, ?, ?)',
  ).run(call.caller, call.destination, `${call.purpose} [${reason}]`, call.ts ?? Date.now());
}

/** The last N ledger rows, newest first — the Settings → Network log. */
export function recentNetworkCalls(
  db: DB,
  limit = 50,
): { caller: string; destination: string; purpose: string | null; ts: number }[] {
  return db
    .prepare('SELECT caller, destination, purpose, ts FROM network_calls ORDER BY ts DESC, id DESC LIMIT ?')
    .all(limit) as { caller: string; destination: string; purpose: string | null; ts: number }[];
}

export interface EgressInventoryEntry {
  caller: string;
  destination: string;
  purpose: string;
  /** env flag whose presence would allow it; null = always-on disclosed call. */
  enabler: string | null;
  /** where the guard lives — 'reader-side' means apps/mac, not this package. */
  guard: 'choke-point' | 'reader-side';
}

/**
 * The declared inventory: every network-adjacent call site that exists in the
 * shipped product. scripts/check-egress.mjs fails CI when a network API call
 * appears in the tree that is neither routed through egress() nor listed here.
 * Two rows today — the update check (disclosed, reader-side guard pending
 * wiring) and the reconcile adapter (opt-in, dry-run offline, enabler-gated).
 */
export function egressInventory(): EgressInventoryEntry[] {
  return [
    {
      caller: 'UpdateChecker.swift',
      destination: 'api.github.com/repos/launchsafe/vole/releases',
      purpose: 'version check on launch',
      enabler: null,
      guard: 'reader-side',
    },
    {
      caller: 'reconcile:cli',
      destination: 'vendor console (per-adapter)',
      purpose: 'opt-in vendor cost reconciliation',
      enabler: 'VOLE_RECONCILE',
      guard: 'choke-point',
    },
  ];
}

/** The self-DSAR export (Art. 15): everything the store holds about sessions,
 *  with the logic stated — the rows AND the reasons. */
export function selfDsar(): string {
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
