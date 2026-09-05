import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBurnRate } from './burn-rate';
import { detectLoops } from './loop';
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
    cost_usd: 0.001,
    confidence: 'exact',
    is_error: 0,
    stop_reason: 'end_turn',
    source: 'live',
    raw_ref: null,
    tools: null,
    agent_id: null,
    context_window: null,
    ...over,
  };
}

const MIN = 60_000;

test('burn rate: quiet baseline produces no anomaly', () => {
  const events: UsageEvent[] = [];
  for (let w = 0; w < 6; w++) {
    events.push(ev({ ts: T0 + w * 10 * MIN, total_tokens: 30_000 }));
  }
  assert.equal(detectBurnRate(events, T0).length, 0);
});

test('burn rate: a window far above the model\'s own median fires', () => {
  const events: UsageEvent[] = [];
  for (let w = 0; w < 6; w++) events.push(ev({ ts: T0 + w * 10 * MIN, total_tokens: 30_000 }));
  events.push(ev({ ts: T0 + 7 * 10 * MIN, total_tokens: 500_000 }));

  const found = detectBurnRate(events, T0);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.rule, 'burn_rate_spike');
  assert.equal(found[0]?.severity, 'critical');
  assert.match(found[0]!.detail, /tokens in 10 min/);
});

test('burn rate: activity_only rows are excluded from token maths', () => {
  const events: UsageEvent[] = [];
  for (let w = 0; w < 6; w++) events.push(ev({ ts: T0 + w * 10 * MIN, total_tokens: 30_000 }));
  // A big Cursor row must not be able to create or distort a spike: it has no tokens.
  events.push(ev({ ts: T0 + 7 * 10 * MIN, tool: 'cursor', confidence: 'activity_only', total_tokens: null }));
  assert.equal(detectBurnRate(events, T0).length, 0);
});

test('loop: high call volume WITH real output is not flagged', () => {
  const events: UsageEvent[] = [];
  for (let i = 0; i < 10; i++) events.push(ev({ ts: T0 + i * 30_000, output_tokens: 100 }));
  // A genuinely productive burst: many calls, but substantial output each time.
  for (let i = 0; i < 45; i++) {
    events.push(ev({ ts: T0 + 10 * MIN + i * 5_000, output_tokens: 5_000, cache_read_tokens: 50_000 }));
  }
  assert.equal(detectLoops(events, T0).length, 0);
});

test('loop: high call volume with flat output and climbing cache reads fires', () => {
  const events: UsageEvent[] = [];
  for (let i = 0; i < 10; i++) events.push(ev({ ts: T0 + i * 30_000, output_tokens: 100 }));
  for (let i = 0; i < 45; i++) {
    events.push(ev({ ts: T0 + 10 * MIN + i * 5_000, output_tokens: 40, cache_read_tokens: 90_000 }));
  }
  const found = detectLoops(events, T0);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.rule, 'loop_suspected');
  assert.match(found[0]!.title, /runaway loop/);
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

test('anomaly keys are stable, so re-running cannot duplicate incidents', () => {
  const events: UsageEvent[] = [];
  for (let w = 0; w < 6; w++) events.push(ev({ ts: T0 + w * 10 * MIN, total_tokens: 30_000 }));
  events.push(ev({ ts: T0 + 7 * 10 * MIN, total_tokens: 500_000 }));

  const a = detectBurnRate(events, T0);
  const b = detectBurnRate(events, T0 + 999_999); // different "now"
  assert.deepEqual(a.map((x) => x.anomaly_key), b.map((x) => x.anomaly_key));
});

test('loop: exactly 3x the baseline does not fire (threshold is strictly greater)', () => {
  const events: UsageEvent[] = [];
  for (let i = 0; i < 10; i++) events.push(ev({ ts: T0 + i * 30_000, output_tokens: 100 }));
  for (let i = 0; i < 30; i++) {
    events.push(ev({ ts: T0 + 10 * MIN + i * 5_000, output_tokens: 40, cache_read_tokens: 90_000 }));
  }
  assert.equal(detectLoops(events, T0).length, 0);
});

test('leave-one-out: a lone spike cannot hide inside its own baseline', () => {
  // Only two windows exist. A plain median would be dragged halfway to the spike.
  const events: UsageEvent[] = [
    ev({ ts: T0, total_tokens: 25_000 }),
    ev({ ts: T0 + 10 * MIN, total_tokens: 25_000 }),
    ev({ ts: T0 + 20 * MIN, total_tokens: 900_000 }),
  ];
  const found = detectBurnRate(events, T0);
  assert.equal(found.length, 1);
  assert.ok(found[0]!.observed > found[0]!.threshold!);
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
