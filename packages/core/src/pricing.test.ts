import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCost, rateFor, unpricedReason } from './pricing';

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
