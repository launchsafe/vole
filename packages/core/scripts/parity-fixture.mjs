/**
 * Builds the deterministic fixture store the read-model parity check runs against.
 *
 *   pnpm tsx scripts/parity-fixture.mjs /tmp/parity/vole.db
 *   VOLE_DB=/tmp/parity/vole.db pnpm tsx src/cli/readmodel-dump.ts > ts.json
 *   VOLE_DB=/tmp/parity/vole.db swift run Vole --dump=readmodel > swift.json
 *   diff ts.json swift.json
 *
 * Every value is fixed (no Date.now, no randomness): a diff is a read-model
 * difference, never a timing artifact. Rows cover the cases the readers have
 * historically disagreed about — mixed exact/activity_only groups, NULL tokens,
 * incidents with figures, unpriced models.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, resetDbCache, insertEvents, insertAnomalies } from '../src/db';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/parity-fixture.mjs <db-path>');
  process.exit(1);
}

mkdirSync(dirname(file), { recursive: true });
rmSync(file, { force: true });
// openDb (not a raw Database + SCHEMA): the fixture must carry everything a real
// store has, including the migration ledger and the shared views both readers
// select from — otherwise the parity check proves less than it claims.
const db = openDb(file);

const T = 1_700_000_000_000; // fixed epoch — 2023-11-14T22:13:20Z

function ev(over) {
  return {
    event_key: `k${Math.random()}`, tool: 'claude_code', model: 'claude-opus-5',
    session_id: 's1', project: '/w', git_branch: null, ts: T,
    input_tokens: 100, output_tokens: 50, cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0,
    total_tokens: 150, cost_usd: 0.0015, confidence: 'exact', is_error: 0,
    stop_reason: 'end_turn', source: 'live', raw_ref: '/f', tools: null,
    agent_id: null, context_window: null, ...over,
  };
}

insertEvents(db, [
  // exact rows, two models, one unpriced
  ev({ event_key: 'p1', ts: T }),
  ev({ event_key: 'p2', ts: T + 1000, model: 'claude-sonnet-5', session_id: 's2', cost_usd: 0.0006 }),
  ev({ event_key: 'p3', ts: T + 2000, model: 'qwen3.8-27b-fp8', cost_usd: null }),
  // a tool with mixed rows: exact tokens alongside activity-only
  ev({ event_key: 'g1', tool: 'grok', model: 'grok-4', ts: T + 3000, total_tokens: 40_000, cost_usd: null }),
  ev({ event_key: 'g2', tool: 'grok', model: 'grok-4', ts: T + 4000, confidence: 'activity_only',
       input_tokens: null, output_tokens: null, cache_read_tokens: null, total_tokens: null, cost_usd: null }),
  // an activity-only-only tool: tokens NULL for the whole group
  ev({ event_key: 'c1', tool: 'cursor', model: null, ts: T + 5000, confidence: 'activity_only',
       input_tokens: null, output_tokens: null, cache_read_tokens: null, total_tokens: null, cost_usd: null }),
  // error + truncation counters
  ev({ event_key: 'e1', ts: T + 6000, is_error: 1 }),
  ev({ event_key: 'e2', ts: T + 7000, stop_reason: 'max_tokens' }),
  // seed rows must be included by includeSeed=true
  ev({ event_key: 's9', ts: T + 8000, source: 'seed' }),
]);

insertAnomalies(db, [
  {
    anomaly_key: 'billable_burn_spike:claude_code:claude-opus-5:s1:1700000000000',
    rule: 'billable_burn_spike', severity: 'critical', tool: 'claude_code', session_id: 's1',
    model: 'claude-opus-5', window_start: T, window_end: T + 600_000,
    title: 'Billable burn spike on claude_code (claude-opus-5)',
    detail: '$1.25 in 10 min ($0.13/min) across 4 calls — 6.2x this session\'s typical window ($0.20). Raw 900,000 tokens including cache reads. Session s1xxxxxx.',
    observed: 1.25, baseline: 0.2, threshold: 0.6, confidence: 'exact', source: 'live', detected_at: T + 600_000,
  },
  {
    anomaly_key: 'repeat_call_loop:grok:grok-4:main:1700000300000',
    rule: 'repeat_call_loop', severity: 'warn', tool: 'grok', session_id: 's9',
    model: 'grok-4', window_start: T + 300_000, window_end: T + 600_000,
    title: 'Runaway loop in grok session s9xxxxxx',
    detail: '50 calls in 5 min while average output stayed at 40 tokens.',
    observed: 50, baseline: null, threshold: 45, confidence: 'exact', source: 'live', detected_at: T + 600_000,
  },
]);

resetDbCache();   // closes the cached handle the fixtures opened
console.log(`fixture store → ${file}`);
