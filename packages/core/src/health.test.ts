import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './sqlite';
import { SCHEMA } from './schema';
import { insertEvents, LATEST_MIGRATION } from './db';
import { checkTools, checkStore, worstLevel, STALE_AFTER_DAYS } from './health';
import { getModelComparison } from './queries';
import type { UsageEvent } from './types';

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-01T12:00:00Z');

function db() {
  const d = new Database(join(mkdtempSync(join(tmpdir(), 'vole-h-')), 'v.db'));
  d.exec(SCHEMA);
  return d;
}

function ev(over: Partial<UsageEvent>): UsageEvent {
  return {
    event_key: `k${Math.random()}`, tool: 'claude_code', model: 'claude-opus-5',
    session_id: 's', project: null, git_branch: null, ts: NOW, input_tokens: 10,
    output_tokens: 10, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0,
    cache_read_tokens: 0, reasoning_tokens: 0, total_tokens: 20, cost_usd: 1,
    confidence: 'exact', is_error: 0, stop_reason: null, source: 'live', raw_ref: null,
    tools: null, agent_id: null, context_window: null, duration_ms: null,
    duration_kind: null, ...over,
  };
}

const forTool = (d: ReturnType<typeof db>, tool: string) =>
  checkTools(d, NOW).find((t) => t.tool === tool)!;

// ── the check this command exists for ────────────────────────────────────────

test('a source still being read but no longer measuring anything is a warning', () => {
  // The Cursor case: the parser works, rows keep arriving, and the token total
  // silently stops growing. A health check that only asked "did the last pass
  // succeed?" would call this perfectly healthy.
  const d = db();
  const state = process.env.VOLE_CURSOR_STATE_DB;
  process.env.VOLE_CURSOR_STATE_DB = join(mkdtempSync(join(tmpdir(), 'vole-src-')), 'state.vscdb');
  try {
    // Measured long ago; still producing activity-only rows today.
    insertEvents(d, [
      ev({ tool: 'cursor', model: null, event_key: 'old', ts: NOW - 200 * DAY, total_tokens: 500 }),
      ev({ tool: 'cursor', model: null, event_key: 'new', ts: NOW - DAY,
           total_tokens: null, input_tokens: null, output_tokens: null, cost_usd: null,
           confidence: 'activity_only' }),
    ]);
    // The source path must exist for this to be "still active" rather than "gone".
    writeFileSync(process.env.VOLE_CURSOR_STATE_DB, 'x');

    const h = forTool(d, 'cursor');
    assert.equal(h.level, 'warn');
    assert.ok(h.staleDays !== null && h.staleDays >= STALE_AFTER_DAYS);
    assert.match(h.verdict, /still active, but no token counts/);
  } finally {
    if (state === undefined) delete process.env.VOLE_CURSOR_STATE_DB;
    else process.env.VOLE_CURSOR_STATE_DB = state;
  }
});

test('a tool that is simply not installed is not reported as a problem', () => {
  // Flagging every absent tool would train people to ignore the list, which is how a
  // real failure goes unnoticed.
  const d = db();
  const prev = process.env.VOLE_GROK_LOG;
  process.env.VOLE_GROK_LOG = '/nonexistent/grok.jsonl';
  try {
    const h = forTool(d, 'grok');
    assert.equal(h.level, 'ok');
    assert.match(h.verdict, /not installed/);
  } finally {
    if (prev === undefined) delete process.env.VOLE_GROK_LOG;
    else process.env.VOLE_GROK_LOG = prev;
  }
});

test('recent measurements read as healthy', () => {
  const d = db();
  insertEvents(d, [ev({ ts: NOW - 2 * DAY })]);
  const h = forTool(d, 'claude_code');
  assert.equal(h.level, 'ok');
  assert.equal(h.staleDays, 2);
});

// ── the store ────────────────────────────────────────────────────────────────

test('a store written by a newer Vole is a failure, not a warning', () => {
  const d = db();
  d.exec(`PRAGMA user_version = ${LATEST_MIGRATION + 5}`);
  const s = checkStore(d, '/nonexistent.db');
  assert.equal(s.level, 'fail');
  assert.match(s.verdict, /newer Vole/);
});

test('a store behind the current schema is a warning with the remedy', () => {
  const d = db();
  d.exec('PRAGMA user_version = 1');
  const s = checkStore(d, '/nonexistent.db');
  assert.equal(s.level, 'warn');
  assert.match(s.verdict, /run the collector once to migrate/);
});

test('the worst level is what the exit code should follow', () => {
  assert.equal(worstLevel(['ok', 'warn', 'fail']), 'fail');
  assert.equal(worstLevel(['ok', 'warn']), 'warn');
  assert.equal(worstLevel(['ok', 'ok']), 'ok');
});

// ── model comparison ─────────────────────────────────────────────────────────

test('a tool spanning two tiers gets a row per tier, never a self-contradicting one', () => {
  // Collapsing to the worst tier made Cursor report its real 65M tokens under a
  // "no tokens" label.
  const d = db();
  insertEvents(d, [
    ev({ tool: 'cursor', model: null, event_key: 'x1', total_tokens: 1000, cost_usd: null }),
    ev({ tool: 'cursor', model: null, event_key: 'x2', total_tokens: null, cost_usd: null,
         input_tokens: null, output_tokens: null, confidence: 'activity_only' }),
  ]);
  const rows = getModelComparison(d, 'all', false).filter((r) => r.tool === 'cursor');
  assert.equal(rows.length, 2, 'one row per tier');

  const exact = rows.find((r) => r.confidence === 'exact')!;
  const activity = rows.find((r) => r.confidence === 'activity_only')!;
  assert.equal(exact.tokens, 1000);
  assert.equal(activity.tokens, 0, 'an unmeasured row contributes no tokens');
  assert.equal(activity.calls, 1, 'but is still counted as a call');
});

test('cost per call is withheld when any call in the row is unpriced', () => {
  // An average over a partial total reads as "cheap" rather than as "unknown".
  const d = db();
  insertEvents(d, [
    ev({ model: 'half-priced', event_key: 'p1', cost_usd: 2 }),
    ev({ model: 'half-priced', event_key: 'p2', cost_usd: null }),
  ]);
  const r = getModelComparison(d, 'all', false).find((x) => x.model === 'half-priced')!;
  assert.equal(r.calls, 2);
  assert.equal(r.costPerCall, null);
});

test('a fully unpriced model shows no cost rather than zero', () => {
  const d = db();
  insertEvents(d, [ev({ model: 'unpriced', event_key: 'u1', cost_usd: null })]);
  const r = getModelComparison(d, 'all', false).find((x) => x.model === 'unpriced')!;
  assert.equal(r.cost, null, 'null, never 0 — a zero would understate a total');
});
