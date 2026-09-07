/**
 * Read-model parity dump: the shared read model as stable JSON, for the CI check
 * that keeps the two readers (queries.ts and DB.swift) answering identically.
 *
 *   VOLE_DB=fixture.db pnpm tsx src/cli/readmodel-dump.ts > ts.json
 *   VOLE_DB=fixture.db swift run -c release Vole --dump=readmodel > swift.json
 *   diff ts.json swift.json
 *
 * The two sides never share code by design (the Swift reader is an independent
 * implementation), which is exactly why they drift: queries.ts gained
 * observed/baseline/threshold on incidents while DB.swift silently didn't, and
 * only a human happened to notice. This dump is the contract both must keep.
 *
 * Determinism rules, because a diff must be meaningful:
 *  - every list is ordered by explicit keys, with ties broken deterministically;
 *  - doubles are rounded to 1e-6 — the last-digit float noise of two runtimes is
 *    not a read-model difference;
 *  - `range` is fixed at 'all' and seed rows are included, so a fixture store
 *    answers the same from both sides regardless of wall-clock.
 */
import { openDbReadOnly } from '../db';
import { MIGRATIONS } from '../db';
import { getSummary, getAnomalies } from '../queries';

const db = openDbReadOnly();

const r6 = (x: number | null | undefined) =>
  x === null || x === undefined ? null : Math.round(x * 1e6) / 1e6;

// The schema contract: what the TS side knows, and what this store is. The Swift
// dump reports the same two numbers — if the app's knownSchemaVersion ever lags
// the collector's migrations head, this diff fails instead of the app shipping
// a version gate that blocks its own store.
const known = MIGRATIONS[MIGRATIONS.length - 1]!.version;
const store = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

const s = getSummary(db, 'all', false); // live-only, matching DB.swift's summary()
const incidents = getAnomalies(db, 'all', false, 500);

const out = {
  schema: { known, store },
  summary: {
    calls: s.calls,
    tokens: s.tokens,
    cost: r6(s.cost),
    sessions: s.sessions,
    errors: s.errors,
    truncated: s.truncated,
    hasActivityOnly: s.hasActivityOnly,
    byTool: [...s.byTool]
      .sort((a, b) => b.calls - a.calls || (a.tool < b.tool ? -1 : 1))
      .map((t) => ({
        tool: t.tool, calls: t.calls, tokens: t.tokens, cost: r6(t.cost),
        confidence: t.confidence, activityOnlyCalls: t.activityOnlyCalls,
      })),
  },
  incidents: [...incidents]
    .sort((a, b) => b.window_start - a.window_start || a.id - b.id)
    .map((i) => ({
      id: i.id, anomaly_key: i.anomaly_key, rule: i.rule, severity: i.severity,
      tool: i.tool, session_id: i.session_id, model: i.model,
      window_start: i.window_start, window_end: i.window_end,
      title: i.title, detail: i.detail,
      observed: r6(i.observed), baseline: r6(i.baseline), threshold: r6(i.threshold),
      confidence: i.confidence, source: i.source, detected_at: i.detected_at,
    })),
};

console.log(JSON.stringify(out, null, 1));
