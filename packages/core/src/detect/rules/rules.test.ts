import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Anomaly, UsageEvent } from '../../types';
import { diffWatchedKeys, watchedKeyFacts } from './permission-keys';
import { coveredFraction, isPagedBulkRead, lineRangeKey } from './read-coverage';
import { scanInterruptMarkers } from './interrupts';
import { applyPostureWeight, autonomyChains, longestChain, normalizeAutonomy, rankOf } from './posture-weight';
import { isPublishClass, pairCrossScope, pairDeniedThenAchieved, pairDenialThenReshape, type PairCall } from './call-pairing';
import { detectLedgerRepeatLoops } from '../loop';
import { detectErrorStorms } from '../error-storm';

const T0 = Date.parse('2026-08-01T00:00:00Z');

// ── permission keys ──────────────────────────────────────────────────────────

test('watched keys: grant transitions are the only criticals, values never stored', () => {
  const before = watchedKeyFacts(
    JSON.stringify({ hasTrustDialogAccepted: false, permissions: { allow: [] } }),
    false,
  );
  const after = watchedKeyFacts(
    JSON.stringify({ hasTrustDialogAccepted: true, permissions: { allow: ['Bash', 'Read'] }, hooks: { Stop: [{}] } }),
    false,
  );
  const changes = diffWatchedKeys(before, after);
  assert.equal(changes.length, 3);
  assert.ok(changes.every((c) => c.grant), 'all three transitions grant authority');
  assert.ok(changes.some((c) => c.key === 'hasTrustDialogAccepted' && c.from === 'false' && c.to === 'true'));
  assert.ok(changes.some((c) => c.key === 'permissions.allow' && c.from === '0 entries' && c.to === '2 entries'));
  // value classes only — no entry text survives
  assert.ok(!JSON.stringify(changes).includes('Bash'));
});

test('watched keys: TOML (grok yolo, codex approval_policy)', () => {
  const facts = watchedKeyFacts('[ui]\nyolo = true\npermission_mode = "auto"\n', true);
  assert.ok(facts.some((f) => f.key === 'ui.yolo' && f.value_class === 'true' && f.grant));
  assert.ok(facts.some((f) => f.key === 'permission_mode' && f.grant));
});

// ── read coverage ────────────────────────────────────────────────────────────

test('read coverage: distinct line ranges, re-reads do not inflate', () => {
  const windows = [
    { file_path: '/a.ts', start_line: 1, num_lines: 50, total_lines: 100, truncated_by_token_cap: true },
    { file_path: '/a.ts', start_line: 1, num_lines: 50, total_lines: 100, truncated_by_token_cap: true },
    { file_path: '/a.ts', start_line: 51, num_lines: 50, total_lines: 100, truncated_by_token_cap: true },
  ];
  const cov = coveredFraction(windows);
  assert.equal(cov.total, 100);
  assert.equal(cov.covered, 100);
  assert.equal(cov.fraction, 1);
  assert.equal(lineRangeKey(windows[0]!), '/a.ts#1-50');
  assert.equal(isPagedBulkRead(windows), true);
  // no totalLines anywhere: coverage unknown, never zero
  assert.equal(coveredFraction([{ file_path: '/b.ts', start_line: null, num_lines: 5, total_lines: null, truncated_by_token_cap: null }]).fraction, null);
});

// ── interrupts ───────────────────────────────────────────────────────────────

test('interrupts: the text marker resolves session, ts and the interrupted call', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'vole-int-')), 'proj-slug');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'sess-abc.jsonl'),
    [
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T00:00:01Z', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash' }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-08-01T00:00:02Z', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-08-01T00:00:03Z', message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'Read' }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-08-01T00:00:04Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2' }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-08-01T00:00:05Z', message: { content: [{ type: 'text', text: 'no marker here' }] } }),
    ].join('\n'),
  );
  const parent = join(dir, '..');
  const rows = scanInterruptMarkers(parent, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.session_id, 'sess-abc');
  assert.equal(rows[0]?.tool_call_key, 'claude_code:tu_1', 'the marker binds to the preceding UNBOUND tool_use');
  assert.equal(rows[0]?.ts, Date.parse('2026-08-01T00:00:02Z'));
});

// ── posture weight + chains ──────────────────────────────────────────────────

test('autonomy chains: human entries split the chain; no origin records one chain', () => {
  const withHumans = [
    { ts: T0, origin_kind: 'human' },
    { ts: T0 + 1000, origin_kind: null },
    { ts: T0 + 60_000 * 30, origin_kind: 'human' },
    { ts: T0 + 60_000 * 31, origin_kind: null },
  ];
  const chains = autonomyChains(withHumans);
  assert.equal(chains.length, 2);
  assert.ok(chains.every((c) => c.origin_recorded));
  const longest = longestChain(chains)!;
  assert.equal(longest.calls, 1);

  const noOrigin = [{ ts: T0, origin_kind: null }, { ts: T0 + 5000, origin_kind: null }];
  const one = autonomyChains(noOrigin);
  assert.equal(one.length, 1);
  assert.equal(one[0]?.origin_recorded, false, 'absence of a recorded human, not a proven absence');

  assert.equal(rankOf(normalizeAutonomy('bypassPermissions')), 3);
  assert.equal(rankOf(normalizeAutonomy('default')), 0);
  assert.equal(rankOf(normalizeAutonomy(null)), null);
});

test('posture weighting: one step up under full_auto, marked when unknown', () => {
  const base: Anomaly = {
    anomaly_key: 'k', rule: 'billable_burn_spike', severity: 'warn', tool: 'claude_code', session_id: 's',
    model: null, window_start: 0, window_end: 100, title: 't', detail: 'd', observed: 1,
    baseline: null, threshold: null, confidence: 'exact', source: 'live', detected_at: 0,
  };
  const up = applyPostureWeight(base, { known: true, fullAutoOverlapMs: 100, windowMs: 100 });
  assert.equal(up.severity, 'critical');
  assert.match(up.detail, /bypassPermissions for 100% of this window/);

  const untouched = applyPostureWeight(base, { known: true, fullAutoOverlapMs: 0, windowMs: 100 });
  assert.equal(untouched.severity, 'warn');
  assert.equal(untouched.detail, 'd');

  const unknown = applyPostureWeight(base, { known: false, fullAutoOverlapMs: 0, windowMs: 100 });
  assert.equal(unknown.severity, 'warn', 'a NULL interval never silently downgrades');
  assert.match(unknown.detail, /Posture unknown for this window/);

  const capped = applyPostureWeight({ ...base, severity: 'critical' }, { known: true, fullAutoOverlapMs: 100, windowMs: 100 });
  assert.equal(capped.severity, 'critical');
});

// ── call pairing ─────────────────────────────────────────────────────────────

function pc(id: number, over: Partial<PairCall>): PairCall {
  return { id, tool_call_key: `k${id}`, tool: 'claude_code', name: 'Read', shape: null, args_digest: `d${id}`, status: 'success', ts: T0 + id * 1000, ...over };
}

test('denied_then_achieved: identical re-issue and cross-tool class pairing', () => {
  const calls = [
    pc(1, { name: 'Read', args_digest: 'same', status: 'denied' }),
    pc(2, { name: 'Read', args_digest: 'same', status: 'success' }),
    pc(3, { name: 'Read', args_digest: 'other', status: 'denied' }),
    pc(4, { name: 'Bash', shape: 'cat', args_digest: 'x', status: 'success' }),
  ];
  const pairs = pairDeniedThenAchieved(calls);
  assert.equal(pairs.length, 2);
  assert.ok(pairs.some((p) => p.kind === 'identical'));
  assert.ok(pairs.some((p) => p.kind === 'cross_tool_class' && p.denied.name === 'Read' && p.achieved.name === 'Bash' && p.target_class === 'read intent'));
  // outside K ordinals (positions in the session's call list): no pairing
  const far: PairCall[] = [pc(1, { status: 'denied' })];
  for (let i = 0; i < 12; i++) far.push(pc(i + 2, { name: 'Other', args_digest: `f${i}` }));
  far.push(pc(20, { name: 'Bash', shape: 'cat', status: 'success' }));
  assert.equal(pairDeniedThenAchieved(far).length, 0);
});

test('denial_then_reshape: same tool, different args', () => {
  const calls = [
    pc(1, { name: 'Edit', args_digest: 'a', status: 'denied' }),
    pc(2, { name: 'Edit', args_digest: 'b', status: 'success' }),
  ];
  assert.equal(pairDenialThenReshape(calls).length, 1);
});

test('cross-scope: read class then publish class fires; same resolved scope does not', () => {
  const calls = [
    pc(1, { name: 'mcp__github__get_file_contents', shape: null }),
    pc(2, { name: 'mcp__github__create_pull_request', shape: null }),
  ];
  assert.equal(pairCrossScope(calls).length, 1);
  assert.ok(isPublishClass({ name: 'mcp__github__push_files', shape: null }));
  assert.ok(isPublishClass({ name: 'Bash', shape: 'git push' }));
  const sameScope = new Map([['k1', 'acme/billing'], ['k2', 'acme/billing']]);
  assert.equal(pairCrossScope(calls, 30 * 60_000, sameScope).length, 0);
});

// ── loop signatures ──────────────────────────────────────────────────────────

test('loop signatures: identical repeats and A-B-A-B cycles', () => {
  const identical = [1, 2, 3, 4, 5].map((i) => pc(i, { name: 'Bash', args_digest: 'stuck' }));
  const anomalies = detectLedgerRepeatLoops(identical, T0 + 10_000);
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0]?.rule, 'repeat_call_loop');
  assert.match(anomalies[0]?.anomaly_key ?? '', /ident/);
  assert.equal(anomalies[0]?.observed, 5);

  const abab = ['a', 'b', 'a', 'b', 'a'].map((d, i) => pc(i + 1, { args_digest: d }));
  const cycles = detectLedgerRepeatLoops(abab, T0 + 10_000);
  assert.equal(cycles.length, 1);
  assert.match(cycles[0]?.anomaly_key ?? '', /abab/);
  assert.ok((cycles[0]?.observed ?? 0) >= 4);

  // four calls, no cycle
  assert.equal(detectLedgerRepeatLoops([pc(1, { args_digest: 'a' }), pc(2, { args_digest: 'b' })], T0).length, 0);
});

// ── error storm narrowed ─────────────────────────────────────────────────────

function ev(over: Partial<UsageEvent>): UsageEvent {
  return {
    event_key: `k${Math.random()}`, tool: 'grok', model: 'm', session_id: 's1', project: null, git_branch: null,
    ts: T0, input_tokens: 1, output_tokens: 1, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0,
    cache_read_tokens: 0, reasoning_tokens: 0, total_tokens: 2, cost_usd: null, confidence: 'exact',
    is_error: 0, stop_reason: 'end_turn', source: 'live', raw_ref: null, tools: null, agent_id: null,
    context_window: null, duration_ms: null, duration_kind: null, ...over,
  };
}

test('error_storm: quota split out, activity_only never counted', () => {
  const quota = Array.from({ length: 10 }, () => ev({ is_error: 1, stop_reason: '403 spending limit' }));
  assert.equal(detectErrorStorms(quota, T0).length, 0, 'quota exhaustion is not a failing tool');

  const api = Array.from({ length: 6 }, (_, i) => ev({ is_error: 1, stop_reason: 'api_error', ts: T0 + i * 1000 }));
  const storms = detectErrorStorms([...api, ev({ is_error: 0 }), ev({ is_error: 1, stop_reason: 'rate limit' })], T0);
  assert.equal(storms.length, 1);
  assert.match(storms[0]?.detail ?? '', /quota-shaped failure/);

  // activity_only rows cannot testify that anything failed
  const quiet = Array.from({ length: 10 }, (_, i) => ev({ is_error: 1, confidence: 'activity_only', ts: T0 + i * 1000 }));
  assert.equal(detectErrorStorms(quiet, T0).length, 0);
});
