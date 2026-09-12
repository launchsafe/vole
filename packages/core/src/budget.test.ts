import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './sqlite';
import { SCHEMA } from './schema';
import { insertEvents } from './db';
import {
  loadBudget, saveBudget, budgetPath, spendSince, countedSpend, startOfLocalDay,
  evaluateBudget, breachMessage, DEFAULT_BUDGET, type BudgetConfig, type TierSpend,
} from './budget';
import type { UsageEvent } from './types';

const spend = (over: Partial<TierSpend> = {}): TierSpend =>
  ({ exact: 0, estimated: 0, unmeasuredCalls: 0, calls: 0, ...over });
const none = spend();

const cfg = (over: Partial<BudgetConfig> = {}): BudgetConfig => ({
  daily: { soft: null, hard: null },
  session: { soft: null, hard: null },
  includeEstimated: true,
  ...over,
});

// ── tier policy ──────────────────────────────────────────────────────────────

test('estimated cost counts toward a cap by default', () => {
  // A cap that ignored unmeasured spend would under-report exactly when it matters,
  // and a guard that lets you past your own ceiling is worse than no guard.
  const s = spend({ exact: 6, estimated: 4 });
  assert.equal(countedSpend(s, true), 10);
  assert.equal(countedSpend(s, false), 6, 'and can be excluded on request');
});

test('activity_only calls are disclosed, never counted as zero spend', () => {
  const s = spend({ exact: 5, unmeasuredCalls: 40 });
  assert.equal(countedSpend(s, true), 5);
  const msg = breachMessage({ level: 'hard', scope: 'daily', spend: 5, cap: 4 }, s, cfg());
  assert.match(msg, /40 further call\(s\) have no recorded cost/);
});

// ── cap evaluation ───────────────────────────────────────────────────────────

test('under every cap is ok', () => {
  const v = evaluateBudget(cfg({ daily: { soft: 10, hard: 20 } }), none, spend({ exact: 4 }));
  assert.equal(v.level, 'ok');
});

test('a soft cap warns without blocking', () => {
  const v = evaluateBudget(cfg({ daily: { soft: 10, hard: 20 } }), none, spend({ exact: 12 }));
  assert.equal(v.level, 'soft');
  assert.equal(v.scope, 'daily');
  assert.equal(v.cap, 10);
});

test('a hard cap outranks a soft one, whichever scope trips first', () => {
  const v = evaluateBudget(
    cfg({ daily: { soft: 1, hard: 100 }, session: { soft: null, hard: 5 } }),
    spend({ exact: 6 }),  // session over its hard cap
    spend({ exact: 6 }),  // day over its soft cap
  );
  assert.equal(v.level, 'hard');
  assert.equal(v.scope, 'session');
});

test('a cap fires exactly at the threshold, not only past it', () => {
  const v = evaluateBudget(cfg({ daily: { soft: null, hard: 10 } }), none, spend({ exact: 10 }));
  assert.equal(v.level, 'hard');
});

test('excluding estimated cost can keep a session under its cap', () => {
  const s = spend({ exact: 4, estimated: 5 });
  assert.equal(evaluateBudget(cfg({ session: { soft: null, hard: 8 } }), s, none).level, 'hard');
  assert.equal(
    evaluateBudget(cfg({ session: { soft: null, hard: 8 }, includeEstimated: false }), s, none).level,
    'ok',
  );
});

test('no caps configured can never produce a breach', () => {
  assert.equal(evaluateBudget(cfg(), spend({ exact: 1e6 }), spend({ exact: 1e6 })).level, 'ok');
});

// ── config ───────────────────────────────────────────────────────────────────

function withConfig<T>(file: string, fn: () => T): T {
  const prev = process.env.VOLE_BUDGET;
  process.env.VOLE_BUDGET = file;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.VOLE_BUDGET;
    else process.env.VOLE_BUDGET = prev;
  }
}

test('a missing or malformed config means no caps, never a crash and never a guess', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-b-'));
  withConfig(join(dir, 'absent.json'), () => {
    assert.deepEqual(loadBudget(), DEFAULT_BUDGET);
  });
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json');
  withConfig(bad, () => {
    assert.deepEqual(loadBudget(), DEFAULT_BUDGET);
  });
});

test('an impossible cap is discarded rather than enforced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-b2-'));
  const file = join(dir, 'b.json');
  // A negative or non-numeric ceiling is not a ceiling; enforcing one would block
  // every call forever.
  writeFileSync(file, JSON.stringify({ daily: { soft: -5, hard: 'lots' }, session: { hard: 0 } }));
  withConfig(file, () => {
    const c = loadBudget();
    assert.equal(c.daily.soft, null);
    assert.equal(c.daily.hard, null);
    assert.equal(c.session.hard, null);
  });
});

test('config round-trips through save and load', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'vole-b3-')), 'b.json');
  withConfig(file, () => {
    saveBudget(cfg({ daily: { soft: 10, hard: 25 }, includeEstimated: false }));
    const back = loadBudget();
    assert.equal(back.daily.hard, 25);
    assert.equal(back.includeEstimated, false);
    assert.equal(budgetPath(), file);
  });
});

// ── spend, against a store ───────────────────────────────────────────────────

test('spendSince splits by tier and scopes to a session', () => {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'vole-b4-')), 'v.db'));
  db.exec(SCHEMA);
  const now = Date.now();
  const ev = (over: Partial<UsageEvent>): UsageEvent => ({
    event_key: `k${Math.random()}`, tool: 'claude_code', model: 'claude-opus-5',
    session_id: 's1', project: null, git_branch: null, ts: now, input_tokens: 0,
    output_tokens: 10, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0,
    cache_read_tokens: 0, reasoning_tokens: 0, total_tokens: 10, cost_usd: 1,
    confidence: 'exact', is_error: 0, stop_reason: null, source: 'live', raw_ref: null,
    tools: null, agent_id: null, context_window: null, duration_ms: null,
    duration_kind: null, ...over,
  });
  insertEvents(db, [
    ev({ event_key: 'a', cost_usd: 3 }),
    ev({ event_key: 'b', cost_usd: 2, confidence: 'estimated', estimation_method: 'reply_text_ratio' }),
    ev({ event_key: 'c', cost_usd: null, total_tokens: null, confidence: 'activity_only' }),
    ev({ event_key: 'd', cost_usd: 99, session_id: 'other' }),
  ]);

  const s1 = spendSince(db, 0, 's1');
  assert.equal(s1.exact, 3);
  assert.equal(s1.estimated, 2);
  assert.equal(s1.unmeasuredCalls, 1, 'the uncosted call is counted, not summed');
  assert.equal(countedSpend(s1, true), 5, "the other session's spend is not included");

  assert.equal(spendSince(db, 0).exact, 102, 'unscoped covers every session');
});

test('the day window starts at local midnight', () => {
  const now = Date.parse('2026-05-01T15:30:00Z');
  const start = startOfLocalDay(now);
  const d = new Date(start);
  assert.equal(d.getHours(), 0);
  assert.equal(d.getMinutes(), 0);
  assert.ok(start <= now);
});
