import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './sqlite';
import { SCHEMA } from './schema';
import { enableWal, insertAnomalies, insertEvents, purgeRetiredRules, repriceUnpriced } from './db';
import {
  getBreakdown, getCacheRewarm, getLiveSessions, getSessionDetail, getTimeseries, getSummary, getWhatIf, rangeStart,
} from './queries';
import type { Anomaly, UsageEvent } from './types';

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'vole-'));
  const db = new Database(join(dir, 'test.db'));
  db.exec(SCHEMA);
  return db;
}

const DAY = 86_400_000;
const BASE = Date.parse('2026-08-20T00:00:00Z');

function ev(over: Partial<UsageEvent>): UsageEvent {
  return {
    event_key: `k${Math.random()}`, tool: 'claude_code', model: 'claude-opus-5',
    session_id: 's1', project: null, git_branch: null, ts: BASE,
    input_tokens: 0, output_tokens: 100, cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0,
    total_tokens: 100, cost_usd: 0.001, confidence: 'exact', is_error: 0,
    stop_reason: null, source: 'live', raw_ref: null, tools: null, agent_id: null,
    context_window: null, duration_ms: null, duration_kind: null, ...over,
  };
}

test('timeseries buckets align to day boundaries, not per-event', () => {
  const db = tmpDb();
  // Three events on the same day, a few seconds apart.
  insertEvents(db, [
    ev({ ts: BASE + 1_000 }), ev({ ts: BASE + 5_629 }), ev({ ts: BASE + 60_000 }),
    ev({ ts: BASE + DAY + 1_000 }),
  ]);
  const pts = getTimeseries(db, 'all', true, BASE + DAY + 1);
  assert.equal(pts.length, 2, 'four events on two days must collapse to two buckets');
  assert.equal(pts[0]!.bucket % DAY, 0, 'bucket must sit on a day boundary');
  assert.equal(pts[0]!.claude_code, 300, 'same-day tokens must sum');
});

test('timeseries fills quiet buckets so the axis is continuous', () => {
  const db = tmpDb();
  insertEvents(db, [ev({ ts: BASE }), ev({ ts: BASE + 3 * DAY })]);
  const all = getTimeseries(db, 'all', true, BASE + 3 * DAY + 1);
  assert.deepEqual(all.map((p) => p.bucket - BASE), [0, DAY, 2 * DAY, 3 * DAY], "'all' starts at the first data bucket");
  assert.equal(all[1]!.claude_code, 0);
  const week = getTimeseries(db, '7d', true, BASE + 7 * DAY);
  assert.equal(week.length, 8, 'a bounded range spans the window start bucket through the current one');
  assert.equal(getTimeseries(db, '24h', true, BASE + 30 * DAY).length, 0, 'no data at all stays empty');
});

test('a row with an unparseable timestamp is dropped, not the whole batch', () => {
  const db = tmpDb();
  assert.equal(insertEvents(db, [ev({ ts: NaN }), ev({ ts: BASE })]), 1);
});

test('resumed Antigravity activity refreshes one row without moving it backwards', () => {
  const db = tmpDb();
  const now = Date.now();
  const event = ev({
    event_key: 'antigravity:conversation-1', tool: 'antigravity', model: null,
    ts: now - 2 * DAY, confidence: 'activity_only', input_tokens: null,
    output_tokens: null, cache_write_5m_tokens: null, cache_write_1h_tokens: null,
    cache_read_tokens: null, reasoning_tokens: null, total_tokens: null, cost_usd: null,
  });
  try {
    assert.equal(insertEvents(db, [event]), 1);
    assert.equal(getLiveSessions(db, { now }).length, 0);
    assert.equal(insertEvents(db, [{ ...event, ts: now }]), 1);
    assert.equal(getSummary(db, '24h', false).calls, 1);
    assert.equal(getSummary(db, 'all', false).calls, 1);
    const [session] = getLiveSessions(db, { now });
    assert.equal(session?.last_ts, now);
    assert.equal(insertEvents(db, [{ ...event, ts: now }, event]), 0);
    const stored = db.prepare('SELECT ts, total_tokens, cost_usd FROM usage_events').get() as UsageEvent;
    assert.equal(stored.ts, now);
    assert.equal(stored.total_tokens, null);
    assert.equal(stored.cost_usd, null);
  } finally {
    db.close();
  }
});

test('replayed exact calls retain their original timestamp without token growth', () => {
  const db = tmpDb();
  try {
    for (const tool of ['claude_code', 'codex', 'grok', 'opencode'] as const) {
      const event = ev({ event_key: tool, tool });
      assert.equal(insertEvents(db, [event]), 1);
      assert.equal(insertEvents(db, [{ ...event, ts: BASE + DAY }]), 0);
    }
    assert.equal((db.prepare('SELECT MAX(ts) AS ts FROM usage_events').get() as { ts: number }).ts, BASE);
  } finally {
    db.close();
  }
});

test('tool names merge across updates without regressing usage or duration', () => {
  const db = tmpDb();
  const event = ev({ event_key: 'claude_code:streamed', tools: 'Read', duration_ms: 1000, duration_kind: 'turn_scoped' });
  try {
    assert.equal(insertEvents(db, [event]), 1);
    assert.equal(insertEvents(db, [{ ...event, tools: 'Edit', duration_ms: null, duration_kind: null }]), 1);
    let stored = db.prepare('SELECT * FROM usage_events').get() as UsageEvent;
    assert.equal(stored.tools, 'Read,Edit');
    assert.equal(stored.total_tokens, event.total_tokens);
    assert.equal(stored.cost_usd, event.cost_usd);
    assert.equal(stored.duration_ms, 1000);
    assert.equal(stored.duration_kind, 'turn_scoped');
    assert.equal(insertEvents(db, [{ ...event, tools: 'Read,Edit' }, { ...event, tools: null }, event]), 0);
    assert.equal(insertEvents(db, [{ ...event, tools: 'Bash', total_tokens: 200, output_tokens: 200, cost_usd: 0.002 }]), 1);
    assert.equal(insertEvents(db, [{ ...event, tools: 'Grep', ts: BASE + 1000 }]), 1);
    stored = db.prepare('SELECT * FROM usage_events').get() as UsageEvent;
    assert.equal(stored.tools, 'Read,Edit,Bash,Grep');
    assert.equal(stored.total_tokens, 200);
    assert.equal(stored.output_tokens, 200);
    assert.equal(stored.cost_usd, 0.002);
    assert.equal(stored.ts, BASE);
  } finally {
    db.close();
  }
});

test('breakdown groups by project on request', () => {
  const db = tmpDb();
  insertEvents(db, [ev({ ts: BASE, project: '/a' }), ev({ ts: BASE, project: '/a' }), ev({ ts: BASE, project: '/b' })]);
  const rows = getBreakdown(db, 'all', true, 'project');
  assert.deepEqual(rows.map((r) => [r.model, r.calls]), [['/a', 2], ['/b', 1]]);
});

test('activity_only rows never contribute tokens but still count as calls', () => {
  const db = tmpDb();
  insertEvents(db, [
    ev({ ts: BASE, total_tokens: 500 }),
    ev({ ts: BASE, tool: 'cursor', confidence: 'activity_only', total_tokens: null,
         cost_usd: null, output_tokens: null, cache_read_tokens: null, input_tokens: null }),
  ]);
  const s = getSummary(db, 'all', true);
  assert.equal(s.tokens, 500, 'token total excludes activity_only');
  assert.equal(s.calls, 2, 'call count includes it');
  const cursor = s.byTool.find((t) => t.tool === 'cursor');
  assert.equal(cursor?.tokens, null, 'cursor tokens surface as null, never 0');
});

test('unknown-rate models keep exact tokens but null cost', () => {
  const db = tmpDb();
  insertEvents(db, [
    ev({ ts: BASE, tool: 'codex', model: 'gpt-5.1-codex-max', total_tokens: 900, cost_usd: null }),
  ]);
  const s = getSummary(db, 'all', true);
  assert.equal(s.tokens, 900);
  assert.equal(s.cost, null, 'cost must stay null rather than collapse to 0');
});

test('reprice fills cost for rows stored before their model had a rate', () => {
  const db = tmpDb();
  insertEvents(db, [
    ev({ ts: BASE, model: 'claude-opus-5', input_tokens: 1_000_000, output_tokens: 0, cost_usd: null }),
    ev({ ts: BASE, tool: 'codex', model: 'claude-opus-5', input_tokens: 10, output_tokens: 10,
         total_tokens: 100, cost_usd: null }), // breakdown does not cover the meter: stays null
    ev({ ts: BASE, model: 'still-unknown', cost_usd: null }),
  ]);
  assert.equal(repriceUnpriced(db), 1);
  assert.equal(getSummary(db, 'all', true).cost, 5, 'priced at the input rate');
});

test('rangeStart("all") reaches the epoch', () => {
  assert.equal(rangeStart('all'), 0);
});

test('session detail: context deltas run per agent thread and blame the previous call\'s tools', () => {
  const db = tmpDb();
  insertEvents(db, [
    ev({ ts: BASE, input_tokens: 1_000, cache_read_tokens: 0, tools: 'Read', event_key: 'a' }),
    ev({ ts: BASE + 1_000, input_tokens: 10, cache_read_tokens: 40_000, tools: 'Bash', event_key: 'b' }),
    ev({ ts: BASE + 2_000, input_tokens: 10, cache_read_tokens: 41_000, event_key: 'c' }),
    // A subagent thread: its first call is a fresh context, not a jump on the main thread.
    ev({ ts: BASE + 1_500, input_tokens: 5_000, cache_read_tokens: 0, agent_id: 'sub1', event_key: 'd' }),
  ]);
  const d = getSessionDetail(db, 's1')!;
  assert.equal(d.calls, 4);
  assert.equal(d.peak_context, 41_010);
  assert.deepEqual(d.agents.map((a) => a.agent_id), [null, 'sub1']);
  assert.equal(d.bloat[0]!.delta, 39_010, 'the jump after the Read');
  assert.equal(d.bloat[0]!.after_tools, 'Read');
  const sub = d.calls_list.find((c) => c.agent_id === 'sub1')!;
  assert.equal(sub.delta, null, 'first call on its own thread');
  assert.equal(getSessionDetail(db, 'nope'), null);
});

test('cache re-warm: only writes on the first call after an idle gap longer than the TTL count', () => {
  const db = tmpDb();
  insertEvents(db, [
    ev({ ts: BASE, cache_write_5m_tokens: 50_000, event_key: 'a' }),                 // first call: not a gap
    ev({ ts: BASE + 60_000, cache_write_5m_tokens: 2_000, event_key: 'b' }),         // 1 min later: warm
    ev({ ts: BASE + 60_000 + 10 * 60_000, cache_write_5m_tokens: 48_000, event_key: 'c' }), // 10 min idle: re-warm
    ev({ ts: BASE + 60_000 + 10 * 60_000 + 30_000, cache_write_5m_tokens: 100, event_key: 'd' }),
  ]);
  const r = getCacheRewarm(db, 'all', true);
  assert.equal(r.gaps, 1);
  assert.equal(r.tokens, 48_000);
  assert.ok(Math.abs(r.cost! - (48_000 * 5 * 1.25) / 1e6) < 1e-9, 'Opus 5 write rate');
});

test('what-if prices the same split at each comparison model, and marks the actual one', () => {
  const db = tmpDb();
  insertEvents(db, [ev({ ts: BASE, input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cost_usd: 5 })]);
  const [r] = getWhatIf(db, 'all', true);
  assert.equal(r!.actual, 5);
  assert.equal(r!.alternatives['claude-sonnet-5'], 2);
  assert.equal(r!.alternatives['claude-fable-5-1'], 10);
});

test('live sessions: context, window, pace and cache expiry come from the latest main-thread call', () => {
  const db = tmpDb();
  const now = BASE + 10 * 60_000;
  insertEvents(db, [
    ev({ ts: now - 4 * 60_000, input_tokens: 10, cache_read_tokens: 300_000, total_tokens: 300_010, cache_write_5m_tokens: 0, event_key: 'a' }),
    ev({ ts: now - 60_000, input_tokens: 10, cache_read_tokens: 320_000, total_tokens: 320_010, cache_write_5m_tokens: 0, tools: 'Bash', event_key: 'b' }),
    ev({ ts: now - 30_000, input_tokens: 10, cache_read_tokens: 9_000, agent_id: 'sub', total_tokens: 9_010, event_key: 'c' }),
    ev({ ts: now - 3 * 3_600_000, session_id: 'old', event_key: 'd' }),
  ]);
  const rows = getLiveSessions(db, { includeSeed: true, now });
  assert.equal(rows.length, 1, 'the stale session is outside the window');
  const s = rows[0]!;
  assert.equal(s.context, 320_010, 'latest main-thread call, not the subagent');
  assert.equal(s.context_window, 1_000_000);
  assert.equal(s.agents, 2);
  assert.equal(s.last_tools, 'Bash');
  assert.equal(s.cache_expires_at, now - 60_000 + 300_000, '5-minute TTL from the last call');
  assert.equal(s.tokens_per_min, (300_010 + 320_010 + 9_010) / 5);
  assert.equal(getLiveSessions(db, { sessionId: 'old', includeSeed: true, now }).length, 1, 'by id ignores age');
});

test('anomalies from retired rules are purged when the rule registry changes', () => {
  const db = tmpDb();
  const anom = (over: Partial<Anomaly>): Anomaly => ({
    anomaly_key: `a${Math.random()}`, rule: 'billable_burn_spike' as Anomaly['rule'],
    severity: 'warn', tool: 'claude_code', session_id: 's1', model: 'claude-opus-5',
    window_start: BASE, window_end: BASE + 600_000, title: 't', detail: 'd',
    observed: 10, baseline: 1, threshold: 3, confidence: 'exact', source: 'live',
    detected_at: BASE, ...over,
  });

  insertAnomalies(db, [
    anom({ anomaly_key: 'live' }),
    // Written by an older build whose rule registry has since dropped these.
    anom({ anomaly_key: 'dead1', rule: 'burn_rate_spike' as Anomaly['rule'] }),
    anom({ anomaly_key: 'dead2', rule: 'loop_suspected' as Anomaly['rule'] }),
  ]);
  assert.equal((db.prepare('SELECT count(*) c FROM anomalies').get() as { c: number }).c, 3);

  const removed = purgeRetiredRules(db, ['billable_burn_spike']);

  assert.equal(removed, 2, 'both retired-rule rows are removed');
  const left = db.prepare('SELECT anomaly_key FROM anomalies').all() as { anomaly_key: string }[];
  assert.deepEqual(left.map((r) => r.anomaly_key), ['live']);
});

test('purging retired rules is a no-op when every stored rule is still current', () => {
  const db = tmpDb();
  insertAnomalies(db, [{
    anomaly_key: 'k1', rule: 'error_storm', severity: 'warn', tool: 'claude_code',
    session_id: 's1', model: null, window_start: BASE, window_end: BASE + 1,
    title: 't', detail: 'd', observed: 1, baseline: null, threshold: null,
    confidence: 'exact', source: 'live', detected_at: BASE,
  }]);
  assert.equal(purgeRetiredRules(db, ['error_storm', 'billable_burn_spike']), 0);
  assert.equal((db.prepare('SELECT count(*) c FROM anomalies').get() as { c: number }).c, 1);
});

test('a far-future timestamp cannot explode the timeseries zero-fill', () => {
  const db = tmpDb();
  const now = BASE;
  // A tool with a broken clock (or one corrupt line) writes year 3999. Zero-filling
  // from now to that bucket is ~700k daily iterations — and hourly, ~17M, which is
  // what froze the macOS app for ~55s per refresh.
  insertEvents(db, [
    ev({ ts: now, event_key: 'k-now' }),
    ev({ ts: Date.parse('3999-12-31T23:59:59Z'), event_key: 'k-future' }),
  ]);
  const t0 = Date.now();
  const pts = getTimeseries(db, 'all', false, now);
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 1000, `zero-fill took ${elapsed}ms — it is unbounded`);
  assert.ok(pts.length < 10_000, `produced ${pts.length} buckets`);
  // The out-of-range observation is still reported, just not filled up to.
  assert.ok(pts.some((p) => p.bucket >= Date.parse('3999-01-01T00:00:00Z')), 'future row kept');
  assert.ok(pts.some((p) => p.bucket <= now), 'present row kept');
});

test('enabling WAL tolerates another connection holding the store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-wal-'));
  const file = join(dir, 'race.db');
  const first = new Database(file);
  first.exec(SCHEMA);
  enableWal(first);
  // A second opener arriving while the first holds the file must not throw:
  // journal_mode ignores busy_timeout, and openDb() runs outside the collector's
  // startup guard, so a throw here kills the process before it ever polls.
  const second = new Database(file);
  assert.doesNotThrow(() => enableWal(second));
  const mode = (second.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  assert.equal(mode.toLowerCase(), 'wal');
});

test('a future timestamp cannot invent a cache countdown longer than the TTL', () => {
  const db = tmpDb();
  const now = BASE;
  // `ts` comes from another tool's log. A skewed clock rendered "cache 1037860935:10"
  // — about two thousand years — where the real ceiling is the 1h cache TTL.
  insertEvents(db, [ev({ ts: now + 400 * 365 * DAY, session_id: 'skewed', event_key: 'k-skew',
                         cache_write_1h_tokens: 100, total_tokens: 100 })]);
  const [s] = getLiveSessions(db, { sinceMs: 60 * 60_000, now });
  assert.ok(s, 'session listed');
  if (s.cache_expires_at !== null) {
    const left = s.cache_expires_at - now;
    assert.ok(left <= 3600_000, `countdown is ${Math.round(left / 60000)} minutes`);
  }
});

test('an estimated row round-trips with the method that produced it', () => {
  const db = tmpDb();
  insertEvents(db, [
    ev({ event_key: 'e-exact', total_tokens: 100, confidence: 'exact' }),
    ev({ event_key: 'e-est', total_tokens: 250, confidence: 'estimated',
         estimation_method: 'content_length_heuristic' }),
    ev({ event_key: 'e-act', total_tokens: null, input_tokens: null, output_tokens: null,
         cost_usd: null, confidence: 'activity_only' }),
  ]);
  const rows = db.prepare(
    'SELECT event_key, confidence, estimation_method FROM usage_events ORDER BY event_key',
  ).all() as { event_key: string; confidence: string; estimation_method: string | null }[];

  // ORDER BY event_key: e-act, e-est, e-exact.
  assert.deepEqual(rows.map((r) => [r.confidence, r.estimation_method]), [
    ['activity_only', null],
    ['estimated', 'content_length_heuristic'],
    ['exact', null],          // a method on a non-estimated row would be meaningless
  ]);
});

test('the estimated tier does not leak into exact totals', () => {
  const db = tmpDb();
  insertEvents(db, [
    ev({ event_key: 't-a', total_tokens: 1_000, cost_usd: 1, confidence: 'exact' }),
    ev({ event_key: 't-b', total_tokens: 9_000, cost_usd: 9, confidence: 'estimated',
         estimation_method: 'reply_text_ratio' }),
  ]);
  const byTier = db.prepare(
    'SELECT confidence, SUM(total_tokens) AS tok FROM usage_events GROUP BY confidence',
  ).all() as { confidence: string; tok: number }[];
  const exact = byTier.find((r) => r.confidence === 'exact');
  assert.equal(exact?.tok, 1_000, 'the exact total is unchanged by an estimated row beside it');
});
