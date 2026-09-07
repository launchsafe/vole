import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectReroutedModels, decodeHexAlias } from './rerouted-model';
import { surfaceMatches, isSanctioned, loadSurfacePolicy, type SurfacePolicy } from '../policy';
import type { UsageEvent } from '../types';

const T0 = Date.parse('2026-08-01T00:00:00Z');

function ev(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    event_key: `k${Math.random()}`, tool: 'claude_code', model: 'claude-sonnet-5',
    session_id: 's1', project: null, git_branch: null, ts: T0,
    input_tokens: 10, output_tokens: 100, cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0,
    total_tokens: 110, cost_usd: 0.001, confidence: 'exact', is_error: 0,
    stop_reason: 'end_turn', source: 'live', raw_ref: null, tools: null,
    agent_id: null, context_window: null, duration_ms: null, duration_kind: null, ...over,
  };
}

test('rerouted: first-party models never fire', () => {
  const events = [ev({ model: 'claude-sonnet-5' }), ev({ tool: 'codex', model: 'gpt-5.5' })];
  assert.equal(detectReroutedModels(events, T0).length, 0);
});

test('rerouted: a claude_code row answered by qwen fires with the session counted', () => {
  const events = [
    ...Array.from({ length: 3 }, () => ev({ model: 'qwen3.8-27b-fp8', ts: T0 + 1000 })),
    ev({ model: 'claude-sonnet-5' }), // first-party: not counted
  ];
  const found = detectReroutedModels(events, T0);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.rule, 'rerouted_model');
  assert.equal(found[0]!.observed, 3, 'only the rerouted calls are the figure');
  assert.match(found[0]!.detail, /not a first-party Anthropic model id/);
});

test('rerouted: the CCR hex alias is decoded into the detail line', () => {
  // Real shape from the live store: the hex run decodes to "qwen/qwen3.8-27b-fp8".
  const model = 'claude-ccr-h7177656e2f7177656e332e382d3237622d667038';
  const found = detectReroutedModels([ev({ model })], T0);
  assert.equal(found.length, 1);
  assert.match(found[0]!.detail, /decodes to "qwen\/qwen3\.8-27b-fp8"/);
});

test('rerouted: a NULL model is an honest unknown, never an all-clear and never a finding', () => {
  assert.equal(detectReroutedModels([ev({ model: null })], T0).length, 0);
});

test('rerouted: opencode is excluded — its provider prefixes are honest labels', () => {
  const events = [ev({ tool: 'opencode', model: 'github-copilot/claude-opus-4.6' })];
  assert.equal(detectReroutedModels(events, T0).length, 0);
});

test('decodeHexAlias: only printable-ASCII hex runs decode', () => {
  assert.equal(decodeHexAlias('claude-ccr-h7177656e2f7177656e332e382d3237622d667038'), 'qwen/qwen3.8-27b-fp8');
  assert.equal(decodeHexAlias('claude-sonnet-5'), null, 'short hex-ish runs are not aliases');
});

// ── the sanctioned-surface policy ────────────────────────────────────────────

test('policy: glob matching is anchored and * only', () => {
  assert.ok(surfaceMatches('app:com.anthropic.*', 'app:com.anthropic.operon'));
  assert.ok(surfaceMatches('*', 'anything'));
  assert.ok(surfaceMatches('cli:claude', 'cli:claude'));
  assert.ok(!surfaceMatches('app:com.anthropic.*', 'app:com.openai.chatgpt'));
  assert.ok(!surfaceMatches('cli:claude', 'cli:claude-code')); // no implicit prefix
  assert.ok(surfaceMatches('app:*', 'app:x'));
});

test('policy: no policy means sanctioned is UNKNOWN, not false', () => {
  assert.equal(isSanctioned(null, 'cli:claude'), null);
  const policy: SurfacePolicy = { allowed: ['cli:claude', 'app:com.anthropic.*'], source: 'test' };
  assert.equal(isSanctioned(policy, 'cli:claude'), true);
  assert.equal(isSanctioned(policy, 'app:com.anthropic.operon'), true);
  assert.equal(isSanctioned(policy, 'cli:litellm'), false);
});

test('policy: loadSurfacePolicy returns null when nothing is declared', () => {
  // The test env has no policy files (VOLE_HOME_OVERRIDE fixtures never write one).
  assert.equal(loadSurfacePolicy(), null);
});
