import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBillableBurn } from './burn-rate';
import { detectRepeatLoops } from './loop';
import { detectErrorStorms } from './error-storm';
import { detectRateLimitPressure } from './rate-limit';
import { detectContextPressure } from './context-pressure';
import type { UsageEvent } from '../types';

const T0 = Date.parse('2026-08-01T00:00:00Z');

function ev(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    event_key: `k${Math.random()}`,
    tool: 'claude_code',
    model: 'claude-opus-5',
    session_id: 's1',
    project: null,
    git_branch: null,
    ts: T0,
    input_tokens: 10,
    output_tokens: 100,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 110,
    // Proportional to tokens, so the cost-scored path behaves like real data.
    cost_usd: 110 * 3e-6,
    confidence: 'exact',
    is_error: 0,
    stop_reason: 'end_turn',
    source: 'live',
    raw_ref: null,
    tools: null,
    agent_id: null,
    context_window: null,
      duration_ms: null, duration_kind: null,
    ...over,
  };
}

const MIN = 60_000;

test('billable burn: quiet baseline produces no anomaly', () => {
  const events: UsageEvent[] = [];
  for (let w = 0; w < 6; w++) {
    events.push(ev({ ts: T0 + w * 10 * MIN, total_tokens: 30_000, cost_usd: 30_000 * 3e-6 }));
  }
  assert.equal(detectBillableBurn(events, T0).length, 0);
});

test('billable burn: a window far above the session\'s own median fires', () => {
  const events: UsageEvent[] = [];
  for (let w = 0; w < 6; w++) events.push(ev({ ts: T0 + w * 10 * MIN, total_tokens: 30_000, cost_usd: 30_000 * 3e-6 }));
  events.push(ev({ ts: T0 + 7 * 10 * MIN, total_tokens: 500_000, cost_usd: 500_000 * 3e-6 }));

  const found = detectBillableBurn(events, T0);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.rule, 'billable_burn_spike');
  assert.equal(found[0]?.severity, 'critical');
  assert.match(found[0]!.detail, /in 10 min/);
  assert.match(found[0]!.detail, /Raw 500,000 tokens/, 'the raw total is never hidden');
});

test('B6: a pure cache-read spike does not fire — the context got large, no money was spent', () => {
  const events: UsageEvent[] = [];
  for (let w = 0; w < 6; w++) {
    events.push(ev({ ts: T0 + w * 10 * MIN, total_tokens: 30_000, cache_read_tokens: 0, cost_usd: 30_000 * 3e-6 }));
  }
  // Same raw shape as the firing test, but 95% of the spike is cache reads priced
  // at 0.1x — the old total-token rule called this a critical burn spike.
  events.push(ev({
    ts: T0 + 7 * 10 * MIN, total_tokens: 500_000, cache_read_tokens: 490_000,
    cost_usd: 10_000 * 3e-6 + 490_000 * 0.3e-6,
  }));
  assert.equal(detectBillableBurn(events, T0).length, 0);
});

test('B6: unpriced windows score on uncached tokens, not totals', () => {
  const events: UsageEvent[] = [];
  for (let w = 0; w < 6; w++) {
    events.push(ev({ ts: T0 + w * 10 * MIN, total_tokens: 30_000, cost_usd: null }));
  }
  // 500k raw tokens but 95% cache reads: uncached is 25k+450k... spike leg is 25k.
  events.push(ev({ ts: T0 + 7 * 10 * MIN, total_tokens: 500_000, cache_read_tokens: 490_000, cost_usd: null }));
  assert.equal(detectBillableBurn(events, T0).length, 0, 'uncached 10k is below a 30k-token baseline x3');

  events.push(ev({ ts: T0 + 8 * 10 * MIN, total_tokens: 500_000, cache_read_tokens: 0, cost_usd: null }));
  const found = detectBillableBurn(events, T0);
  assert.equal(found.length, 1, 'a genuinely uncached spike still fires');
  assert.match(found[0]!.detail, /uncached tokens/);
});

test('B6: sub-threshold windows never dilute the baseline', () => {
  // [30k, 800, 800, 30k, 30k, 120k]: the stray 800-token windows must not be
  // baseline candidates — otherwise the median of the quiet windows halves and a
  // moderate spike is pushed from warn to critical.
  const events: UsageEvent[] = [
    ev({ ts: T0, total_tokens: 30_000, cost_usd: 30_000 * 3e-6 }),
    ev({ ts: T0 + 10 * MIN, total_tokens: 800, cost_usd: 800 * 3e-6 }),
    ev({ ts: T0 + 20 * MIN, total_tokens: 800, cost_usd: 800 * 3e-6 }),
    ev({ ts: T0 + 30 * MIN, total_tokens: 30_000, cost_usd: 30_000 * 3e-6 }),
    ev({ ts: T0 + 40 * MIN, total_tokens: 30_000, cost_usd: 30_000 * 3e-6 }),
    ev({ ts: T0 + 50 * MIN, total_tokens: 120_000, cost_usd: 120_000 * 3e-6 }),
  ];
  const found = detectBillableBurn(events, T0);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.baseline, 30_000 * 3e-6, 'baseline is the median of surviving windows only');
});

test('B6: sessions are baselined separately — concurrent subagents are not charged to one', () => {
  const events: UsageEvent[] = [];
  // Session s1: quiet then a real spike. Session s2: quiet throughout.
  for (let w = 0; w < 4; w++) events.push(ev({ ts: T0 + w * 10 * MIN, total_tokens: 30_000, cost_usd: 30_000 * 3e-6 }));
  for (let w = 0; w < 4; w++) events.push(ev({ ts: T0 + w * 10 * MIN, session_id: 's2', total_tokens: 30_000, cost_usd: 30_000 * 3e-6 }));
  events.push(ev({ ts: T0 + 5 * 10 * MIN, total_tokens: 200_000, cost_usd: 200_000 * 3e-6 }));

  const found = detectBillableBurn(events, T0);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.session_id, 's1', 'the spike is attributed to the session that spent it');
});

test('billable burn: activity_only rows are excluded from token maths', () => {
  const events: UsageEvent[] = [];
  for (let w = 0; w < 6; w++) events.push(ev({ ts: T0 + w * 10 * MIN, total_tokens: 30_000 }));
  // A big Cursor row must not be able to create or distort a spike: it has no tokens.
  events.push(ev({ ts: T0 + 7 * 10 * MIN, tool: 'cursor', confidence: 'activity_only', total_tokens: null }));
  assert.equal(detectBillableBurn(events, T0).length, 0);
});

test('anomaly keys are stable, so re-running cannot duplicate incidents', () => {
  const events: UsageEvent[] = [];
  for (let w = 0; w < 6; w++) events.push(ev({ ts: T0 + w * 10 * MIN, total_tokens: 30_000, cost_usd: 30_000 * 3e-6 }));
  events.push(ev({ ts: T0 + 7 * 10 * MIN, total_tokens: 500_000, cost_usd: 500_000 * 3e-6 }));

  const a = detectBillableBurn(events, T0);
  const b = detectBillableBurn(events, T0 + 999_999); // different "now"
  assert.deepEqual(a.map((x) => x.anomaly_key), b.map((x) => x.anomaly_key));
});

test('leave-one-out: a lone spike cannot hide inside its own baseline', () => {
  // Only two usable windows exist. A plain median would be dragged halfway to the spike.
  const events: UsageEvent[] = [
    ev({ ts: T0, total_tokens: 25_000, cost_usd: 25_000 * 3e-6 }),
    ev({ ts: T0 + 10 * MIN, total_tokens: 25_000, cost_usd: 25_000 * 3e-6 }),
    ev({ ts: T0 + 20 * MIN, total_tokens: 25_000, cost_usd: 25_000 * 3e-6 }),
    ev({ ts: T0 + 30 * MIN, total_tokens: 900_000, cost_usd: 900_000 * 3e-6 }),
  ];
  const found = detectBillableBurn(events, T0);
  assert.equal(found.length, 1);
  assert.ok(found[0]!.observed > found[0]!.threshold!);
});

test('loop: high call volume WITH real output is not flagged', () => {
  const events: UsageEvent[] = [];
  for (let i = 0; i < 10; i++) events.push(ev({ ts: T0 + i * 30_000, output_tokens: 100 }));
  // A genuinely productive burst: many calls, but substantial output each time.
  for (let i = 0; i < 45; i++) {
    events.push(ev({ ts: T0 + 10 * MIN + i * 5_000, output_tokens: 5_000, cache_read_tokens: 50_000 }));
  }
  assert.equal(detectRepeatLoops(events, T0).length, 0);
});

test('loop: high call volume with flat output fires on the absolute rate', () => {
  const events: UsageEvent[] = [];
  for (let i = 0; i < 10; i++) events.push(ev({ ts: T0 + i * 30_000, output_tokens: 100 }));
  for (let i = 0; i < 45; i++) {
    events.push(ev({ ts: T0 + 10 * MIN + i * 5_000, output_tokens: 40, cache_read_tokens: 90_000 }));
  }
  const found = detectRepeatLoops(events, T0);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.rule, 'repeat_call_loop');
  assert.match(found[0]!.title, /[Rr]unaway loop/);
  assert.equal(found[0]!.baseline, null, 'the rule is absolute — there is no baseline');
  assert.equal(found[0]!.threshold, 45);
});

test('B7: a constant-rate loop from the first turn fires — the session is its own baseline no longer', () => {
  // The CI shape: 12 buckets x 50 calls, flat output, from turn one. The old
  // leave-one-out median rule produced zero anomalies on exactly this fixture.
  const events: UsageEvent[] = [];
  for (let w = 0; w < 12; w++) {
    for (let i = 0; i < 50; i++) {
      events.push(ev({ ts: T0 + w * 5 * MIN + i * 2_000, output_tokens: 40, cache_read_tokens: 90_000 }));
    }
  }
  const found = detectRepeatLoops(events, T0);
  assert.equal(found.length, 12, 'every spinning window is an incident');
  assert.equal(found[0]?.rule, 'repeat_call_loop');
});

test('B7: parallel subagents sharing a session id are scoped by agent, not summed', () => {
  // Ten read-only subagents, 5 calls each in the same window — 50 session calls
  // in total. The old rule read this as one spinning agent.
  const events: UsageEvent[] = [];
  for (let a = 0; a < 10; a++) {
    for (let i = 0; i < 5; i++) {
      events.push(ev({ ts: T0 + i * 30_000, output_tokens: 40, agent_id: `agent-${a}` }));
    }
  }
  assert.equal(detectRepeatLoops(events, T0).length, 0);
});

test('B7: the cache-read signal is gone — flat zero-cache loops still fire', () => {
  const events: UsageEvent[] = [];
  for (let i = 0; i < 50; i++) {
    events.push(ev({ ts: T0 + i * 3_000, output_tokens: 40, cache_read_tokens: 0 }));
  }
  assert.equal(detectRepeatLoops(events, T0).length, 1);
});

test('loop: below the absolute rate does not fire', () => {
  const events: UsageEvent[] = [];
  for (let i = 0; i < 10; i++) events.push(ev({ ts: T0 + i * 30_000, output_tokens: 100 }));
  for (let i = 0; i < 30; i++) {
    events.push(ev({ ts: T0 + 10 * MIN + i * 5_000, output_tokens: 40, cache_read_tokens: 90_000 }));
  }
  assert.equal(detectRepeatLoops(events, T0).length, 0);
});

test('error storm: many calls with few errors stays quiet', () => {
  const events: UsageEvent[] = [];
  for (let i = 0; i < 200; i++) events.push(ev({ ts: T0 + i * 1_000 }));
  for (let i = 0; i < 5; i++) events.push(ev({ ts: T0 + i * 1_000, is_error: 1 }));
  assert.equal(detectErrorStorms(events, T0).length, 0);
});

test('error storm: sustained failure ratio fires', () => {
  const events: UsageEvent[] = [];
  for (let i = 0; i < 10; i++) events.push(ev({ ts: T0 + i * 1_000 }));
  for (let i = 0; i < 10; i++) events.push(ev({ ts: T0 + i * 1_000, is_error: 1 }));
  const found = detectErrorStorms(events, T0);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.severity, 'critical');
});

test('rate limit: only fires above threshold, and dedupes within a window', () => {
  const obs = [
    { tool: 'codex' as const, session_id: 's1', ts: T0, used_percent: 40, window_minutes: 300 },
    { tool: 'codex' as const, session_id: 's1', ts: T0 + 1000, used_percent: 85, window_minutes: 300 },
    { tool: 'codex' as const, session_id: 's1', ts: T0 + 2000, used_percent: 88, window_minutes: 300 },
  ];
  const found = detectRateLimitPressure(obs, T0);
  assert.equal(found.length, 1, 'repeated readings in one window collapse to one incident');
  assert.equal(found[0]?.confidence, 'exact');
});

test('context pressure: fires once per session-hour above 80% of a known window, never for an unknown one', () => {
  // Haiku 4.5 has a 200K window; 170K of context is 85%.
  const events: UsageEvent[] = [
    ev({ model: 'claude-haiku-4-5', ts: T0, input_tokens: 1_000, cache_read_tokens: 100_000 }),
    ev({ model: 'claude-haiku-4-5', ts: T0 + MIN, input_tokens: 1_000, cache_read_tokens: 169_000 }),
    ev({ model: 'claude-haiku-4-5', ts: T0 + 2 * MIN, input_tokens: 1_000, cache_read_tokens: 175_000 }),
    ev({ model: 'unknown-local-model', ts: T0 + 3 * MIN, input_tokens: 5_000_000, session_id: 's2' }),
  ];
  const found = detectContextPressure(events, T0);
  assert.equal(found.length, 1, 'one incident for the hour, none for the model with no window');
  assert.equal(found[0]?.rule, 'context_pressure');
  assert.equal(found[0]?.severity, 'warn');
  assert.ok(Math.abs(found[0]!.observed - 176_000 / 200_000) < 1e-9, 'reports the largest call in the hour');
});

test('context pressure: a tool-reported window (Codex) wins over the published one', () => {
  const events = [ev({ model: 'gpt-5.5', tool: 'codex', context_window: 100_000, input_tokens: 96_000, ts: T0 })];
  const found = detectContextPressure(events, T0);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.severity, 'critical');
});
