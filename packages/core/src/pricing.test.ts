import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCost, rateFor, sanitiseOverride, unpricedReason } from './pricing';

test('dated snapshot ids price as their alias', () => {
  assert.equal(rateFor('claude-haiku-4-5-20251001'), rateFor('claude-haiku-4-5'));
  assert.equal(unpricedReason('claude-haiku-4-5-20251001'), null);
  assert.equal(rateFor('claude-haiku-4-5-2025'), undefined, 'only an 8-digit suffix is a snapshot');
});

test('a per-model cache_read rate overrides the global multiplier', () => {
  // Fable 5.1: $10 input, cache reads a flat $0.25/MTok rather than 0.1x = $1.00.
  assert.equal(computeCost('claude-fable-5-1', { cache_read_tokens: 1_000_000 }), 0.25);
  // Opus 5 keeps the multiplier: $5 x 0.1.
  assert.equal(computeCost('claude-opus-5', { cache_read_tokens: 1_000_000 }), 0.5);
});

test('unknown models cost null, never 0', () => {
  assert.equal(computeCost('gpt-5.1-codex-max', { input_tokens: 10 }), null);
  assert.equal(computeCost(null, { input_tokens: 10 }), null);
});

test('an override with impossible rates is ignored, not trusted', () => {
  // ~/.vole/pricing.json is hand-edited, and a bad rate is silent: a negative one
  // yields a negative cost that *reduces* reported spend; a non-numeric one
  // propagates NaN through every aggregate. Neither may reach the store.
  const bad = sanitiseOverride({
    models: {
      'm-negative': { input: -5, output: -25, effective_from: '2020-01-01' },
      'm-string': { input: '5', output: '25', effective_from: '2020-01-01' },
      'm-nan': { input: NaN, output: 1, effective_from: '2020-01-01' },
      'm-infinite': { input: Infinity, output: 1, effective_from: '2020-01-01' },
      'm-missing': { output: 25, effective_from: '2020-01-01' },
      'm-null': null,
      'm-badcacheread': { input: 5, output: 25, cache_read: -1, effective_from: '2020-01-01' },
    },
    cache_multipliers: { read: -0.1, write5m: 'x', write1h: 2 },
  });
  assert.deepEqual(Object.keys(bad.models ?? {}), [], 'every impossible rate dropped');
  assert.deepEqual(bad.cache_multipliers, { write1h: 2 }, 'only the valid multiplier survives');
});

test('a well-formed override is still honoured in full', () => {
  const good = sanitiseOverride({
    models: { 'm-ok': { input: 3, output: 15, cache_read: 0.3, effective_from: '2026-01-01' } },
    cache_multipliers: { read: 0.1, write5m: 1.25, write1h: 2 },
    context_windows: { 'm-ok': 200_000, 'm-bad': -5 },
  });
  assert.equal(good.models?.['m-ok']?.input, 3);
  assert.equal(good.models?.['m-ok']?.cache_read, 0.3);
  assert.equal(good.cache_multipliers?.read, 0.1);
  assert.equal(good.context_windows?.['m-ok'], 200_000);
  assert.equal(good.context_windows?.['m-bad'], undefined, 'a negative window is not a window');
});
