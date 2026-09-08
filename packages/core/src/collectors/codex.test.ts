import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../sqlite';
import { insertEvents } from '../db';
import { insertToolCalls } from '../toolcalls/bind';
import { collectCodex, codexClaimViolations } from './codex';
import { makeStore, type Store } from './test-store';

function fixture(root: string, name: string, lines: Record<string, unknown>[]): string {
  const dir = join(root, '.codex', 'sessions', '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${name}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

/** A fake ~/.codex/state_5.sqlite: threads + thread_spawn_edges. */
function stateDb(root: string, threads: { id: string; rollout_path: string; git_branch: string | null }[], edges: { parent: string; child: string; depth: number | null }[]) {
  const db = new Database(join(root, '.codex', 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, git_branch TEXT, first_user_message TEXT);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, depth INTEGER)`);
  for (const t of threads) db.prepare('INSERT INTO threads VALUES (?, ?, ?, NULL)').run(t.id, t.rollout_path, t.git_branch);
  for (const e of edges) db.prepare('INSERT INTO thread_spawn_edges VALUES (?, ?, ?)').run(e.parent, e.child, e.depth);
  db.close();
}

function tc(info: Record<string, unknown>, rate?: Record<string, unknown>) {
  return {
    type: 'event_msg', timestamp: '2026-01-01T00:00:00.000Z',
    payload: { type: 'token_count', info, ...(rate ? { rate_limits: rate } : {}) },
  };
}

const META = { type: 'session_meta', payload: { id: 'sess-1' } };
const MODEL = { type: 'turn_context', payload: { model: 'gpt-5.5' } };

const usage = (total: number) => ({
  total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total },
  last_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total },
});

function run(name: string, lines: Record<string, Record<string, unknown> | Record<string, unknown>[]>): { result: ReturnType<typeof collectCodex>; db: Store['db']; home: string; done: () => void } {
  const s = makeStore('codex');
  try {
    for (const [n, l] of Object.entries(lines)) fixture(s.home, n, Array.isArray(l) ? l : [l]);
    const result = collectCodex(s.db);
    return { result, db: s.db, home: s.home, done: s.done };
  } catch (err) {
    s.done();
    throw err;
  }
}

test('zero breakdown: the meter delta is kept exact, components stay NULL', () => {
  const zeroUsage = {
    total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 73256 },
    last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 73256 },
  };
  const { result: r } = run('zero', { a: [META, MODEL, tc(zeroUsage)] });
  assert.equal(r.events.length, 1);
  const e = r.events[0]!;
  assert.equal(e.total_tokens, 73256, 'meter delta must not be dropped');
  assert.equal(e.input_tokens, null, 'unattributed tokens are unknown, not zero');
  assert.equal(e.output_tokens, null);
  assert.equal(e.cache_read_tokens, null);
  assert.equal(e.reasoning_tokens, null);
  assert.equal(e.cost_usd, null, 'no split, no cost');
});

test('healthy breakdown: components stored as reported, total equals meter delta', () => {
  const { result: r } = run('healthy', { a: [META, MODEL, tc({
    total_token_usage: { input_tokens: 17038, cached_input_tokens: 5504, output_tokens: 452, reasoning_output_tokens: 361, total_tokens: 17490 },
    last_token_usage: { input_tokens: 17038, cached_input_tokens: 5504, output_tokens: 452, reasoning_output_tokens: 361, total_tokens: 17490 },
  })] });
  const e = r.events[0]!;
  assert.equal(e.total_tokens, 17490);
  assert.equal(e.input_tokens, 17038 - 5504, 'cached input is separated from fresh input');
  assert.equal(e.cache_read_tokens, 5504);
  assert.equal(e.output_tokens, 452);
  assert.equal(e.reasoning_tokens, 361);
});

test('duplicate emission advances the meter by zero and is skipped', () => {
  const info = usage(1050);
  const { result: r } = run('dup', { a: [META, MODEL, tc(info), tc(info)] });
  assert.equal(r.events.length, 1, 'the second identical event must not be counted again');
  assert.equal(r.events[0]!.total_tokens, 1050);
});

test('multi-turn file: each row is its own meter segment, summing to the session total', () => {
  const { result: r } = run('multi', {
    a: [
      META, MODEL,
      tc({
        total_token_usage: { input_tokens: 17436, cached_input_tokens: 4480, output_tokens: 261, reasoning_output_tokens: 184, total_tokens: 17697 },
        last_token_usage: { input_tokens: 17436, cached_input_tokens: 4480, output_tokens: 261, reasoning_output_tokens: 184, total_tokens: 17697 },
      }),
      tc({
        total_token_usage: { input_tokens: 36477, cached_input_tokens: 21760, output_tokens: 274, reasoning_output_tokens: 184, total_tokens: 36751 },
        last_token_usage: { input_tokens: 19041, cached_input_tokens: 17280, output_tokens: 13, reasoning_output_tokens: 0, total_tokens: 19054 },
      }),
    ],
  });
  assert.deepEqual(
    r.events.map((e) => e.total_tokens),
    [17697, 19054],
    'per-event deltas, never cumulative re-sums',
  );
  assert.equal(r.events[1]!.input_tokens, 1761);
  assert.equal(r.events[1]!.cache_read_tokens, 17280);
});

test('tool calls since the previous meter event are attributed to it, with the tool-reported window', () => {
  const call = (name: string) => ({ type: 'response_item', payload: { type: 'function_call', name } });
  const { result: r } = run('tools', {
    a: [META, MODEL, call('exec_command'), call('apply_patch'), tc({ ...usage(110), model_context_window: 258400 })],
  });
  assert.equal(r.events[0]!.tools, 'exec_command,apply_patch');
  assert.equal(r.events[0]!.context_window, 258400);
});

test('B2: rollout files sharing a session id never collide on event_key', () => {
  // A sub-agent rollout replays the parent's session_meta verbatim, so both files
  // carry id sess-1. The keys must still be distinct or one file's rows silently
  // vanish (INSERT OR IGNORE) and the session tree under-counts.
  const { result: r } = run('shared', {
    parent: [META, MODEL, tc(usage(100))],
    'sub-agent': [META, MODEL, tc(usage(200))],
  });
  assert.equal(r.events.length, 2, 'both files must contribute rows');
  const keys = new Set(r.events.map((e) => e.event_key));
  assert.equal(keys.size, 2, 'event_keys must be unique per rollout file');
  assert.deepEqual(
    r.events.map((e) => e.total_tokens).sort((a, b) => (a ?? 0) - (b ?? 0)),
    [100, 200],
    'no row may be lost to a key collision',
  );
  for (const e of r.events) {
    assert.equal(e.session_id, 'sess-1', 'session attribution is preserved');
    assert.ok(e.event_key.includes('rollout-'), 'the key names the source file');
  }
});

test('B13: unchanged rollout files are skipped by the byte-offset cursor', () => {
  // The override must stay live for all three passes — this test drives the
  // collector directly instead of through run().
  const s = makeStore('codex-cursor');
  try {
    const file = fixture(s.home, 'a', [META, MODEL, tc(usage(100))]);
    const first = collectCodex(s.db);
    assert.equal(first.events.length, 1);
    assert.equal(first.filesScanned, 1, 'first pass reads the file');

    // Second pass, same store: the cursor knows (size, mtime) and skips the parse.
    const second = collectCodex(s.db);
    assert.equal(second.filesScanned, 0, 'unchanged files are not re-read');
    assert.equal(second.events.length, 0, 'and emit nothing to re-dedupe');

    // Appending changes mtime/size → the file is read again and the new event
    // lands under its own stable key; the old one is untouched.
    appendFileSync(file, JSON.stringify(tc(usage(250))) + '\n');
    const future = new Date(Date.now() + 2000); // same-ms writes can collide
    utimesSync(file, future, future);

    const third = collectCodex(s.db);
    assert.equal(third.filesScanned, 1, 'an appended file is read again');
    assert.deepEqual(
      third.events.map((e) => e.total_tokens).sort((a, b) => (a ?? 0) - (b ?? 0)),
      [100, 150],
      're-read recomputes the same first delta (stable key) and the appended meter delta',
    );
  } finally {
    s.done();
  }
});

// ── v2: state_5.sqlite join, plan, native keys, claims, links ──────────────

test('v2: git_branch comes from the thread registry, spawn edges land in agent_edges', () => {
  const s = makeStore('codex-state');
  try {
    const file = fixture(s.home, 'a', [META, MODEL, tc(usage(100))]);
    stateDb(s.home, [
      { id: 'sess-1', rollout_path: file, git_branch: 'main' },
      { id: 'child-1', rollout_path: join(s.home, 'other.jsonl'), git_branch: null },
    ], [
      { parent: 'sess-1', child: 'child-1', depth: 1 },
    ]);
    const r = collectCodex(s.db);
    assert.equal(r.events[0]!.git_branch, 'main', 'the branch is read from the vendor DB, not guessed');
    const edges = s.db
      .prepare('SELECT edge_key, session_id, agent_id, parent_agent_id, spawn_depth FROM agent_edges')
      .all() as { edge_key: string; session_id: string; agent_id: string; parent_agent_id: string; spawn_depth: number | null }[];
    assert.equal(edges.length, 1);
    assert.equal(edges[0]!.session_id, 'sess-1', 'the child folds into the parent session tree');
    assert.equal(edges[0]!.agent_id, 'child-1');
    assert.equal(edges[0]!.spawn_depth, 1);
    // idempotent: a second pass re-upserts the same edge, no duplicate
    collectCodex(s.db);
    const again = s.db.prepare('SELECT COUNT(*) AS n FROM agent_edges').get() as { n: number };
    assert.equal(again.n, 1);
  } finally {
    s.done();
  }
});

test('v2: plan_type proves the session plan with session_proved evidence, plus the quota row', () => {
  const s = makeStore('codex-plan');
  try {
    fixture(s.home, 'a', [META, MODEL, tc(usage(100), {
      primary: { used_percent: 41, window_minutes: 300, plan_type: 'team', limit_id: 'codex_plus', individual_limit: 120000, spend_control_reached: false },
    })]);
    const r = collectCodex(s.db);
    assert.equal(r.rateLimits![0]!.used_percent, 41);
    const si = s.db
      .prepare('SELECT plan, tool, binding_evidence FROM session_identity WHERE session_id = ?')
      .get('sess-1') as { plan: string; tool: string; binding_evidence: string };
    assert.equal(si.plan, 'team');
    assert.equal(si.binding_evidence, 'session_proved');
    assert.equal(si.tool, 'codex');
    const q = s.db
      .prepare('SELECT kind, used_percent, limit_value FROM quota_observations')
      .all() as { kind: string; used_percent: number; limit_value: number | null }[];
    assert.equal(q.length, 1);
    assert.equal(q[0]!.kind, 'codex_plus');
    assert.equal(q[0]!.limit_value, 120000);
  } finally {
    s.done();
  }
});

test('v2: tool calls are keyed by the vendor call_id; claims from turn_context reach the result', () => {
  const s = makeStore('codex-keys');
  try {
    fixture(s.home, 'a', [
      META,
      { type: 'turn_context', timestamp: '2026-01-01T00:00:00.000Z', payload: { model: 'gpt-5.5', approval_policy: 'never', sandbox_policy: { type: 'workspace-write' }, workspace_roots: ['/Users/x/repo'] } },
      { type: 'response_item', timestamp: '2026-01-01T00:00:01.000Z', payload: { type: 'function_call', name: 'shell', call_id: 'call_abc', arguments: { cmd: 'ls', workdir: '/etc' } } },
      tc(usage(100)),
    ]);
    const r = collectCodex(s.db);
    assert.equal(r.toolCalls!.length, 1);
    assert.equal(r.toolCalls![0]!.tool_call_key, 'codex:call_abc', 'the source-native call_id is the key');
    assert.equal(r.codexClaims!.length, 1);
    const claim = r.codexClaims![0]!;
    assert.equal(claim.sandbox_type, 'workspace-write');
    assert.deepEqual(claim.workspace_roots, ['/Users/x/repo']);
    assert.equal(claim.approval_policy, 'never');
  } finally {
    s.done();
  }
});

test('v2: codexClaimViolations falsifies a sandbox claim; conforming calls pass', () => {
  const claim = {
    session_id: 's', ts: 1000, sandbox_type: 'workspace-write', network_access: null,
    workspace_roots: ['/Users/x/repo'], approval_policy: 'never',
  };
  const calls = [
    { tool_call_key: 'codex:k1', session_id: 's', name: 'shell', ts: 2000, path: '/Users/x/repo/src/a.ts' },
    { tool_call_key: 'codex:k2', session_id: 's', name: 'shell', ts: 3000, path: '/etc/passwd' },
  ];
  const out = codexClaimViolations([claim], calls);
  assert.equal(out.length, 1, 'the outside-root call is a violation');
  assert.equal(out[0]!.kind, 'sandbox');
  assert.equal(out[0]!.call_key, 'codex:k2');
  assert.equal(out[0]!.declared_policy, 'workspace-write');
});

test('v2: token_usage_record ids land in event_links; observed_at stamps on commit', () => {
  const s = makeStore('codex-links');
  try {
    fixture(s.home, 'a', [
      META, MODEL,
      { type: 'event_msg', timestamp: '2026-01-01T00:00:00.000Z', payload: { type: 'token_usage_record', response_id: 'resp_1', turn_id: 'turn_1', root_turn_id: 'turn_1', thread_id: 'th_1', ord: 7 } },
      tc(usage(100)),
    ]);
    const r = collectCodex(s.db);
    insertEvents(s.db, r.events);
    r.commit!();
    const links = s.db
      .prepare('SELECT link_kind, link_id FROM event_links')
      .all() as { link_kind: string; link_id: string }[];
    const byKind = Object.fromEntries(links.map((l) => [l.link_kind, l.link_id]));
    assert.equal(byKind['response_id'], 'resp_1');
    assert.equal(byKind['turn_id'], 'turn_1');
    assert.equal(byKind['root_turn_id'], 'turn_1');
    assert.equal(byKind['thread_id'], 'th_1');
    assert.equal(byKind['ordinal'], '7');
    // the second clock: observed_at stamped on every row this pass
    const obs = s.db
      .prepare('SELECT COUNT(*) AS n FROM usage_events WHERE observed_at IS NOT NULL')
      .get() as { n: number };
    assert.equal(obs.n, r.events.length);
  } finally {
    s.done();
  }
});

test('v2: turn posture widens the stored tool_calls row via commit', () => {
  const s = makeStore('codex-posture');
  try {
    fixture(s.home, 'a', [
      META,
      { type: 'turn_context', timestamp: '2026-01-01T00:00:00.000Z', payload: { model: 'gpt-5.5', approval_policy: 'on-request', sandbox_policy: { type: 'read-only' }, workspace_roots: ['/w'] } },
      { type: 'response_item', timestamp: '2026-01-01T00:00:01.000Z', payload: { type: 'function_call', name: 'shell', call_id: 'call_xyz' } },
      tc(usage(100)),
    ]);
    const r = collectCodex(s.db);
    insertEvents(s.db, r.events);
    insertToolCalls(s.db, r.toolCalls!);
    r.commit!();
    const row = s.db
      .prepare('SELECT permission_mode, autonomy_rank FROM tool_calls WHERE tool_call_key = ?')
      .get('codex:call_xyz') as { permission_mode: string | null; autonomy_rank: string | null };
    assert.equal(row!.permission_mode, 'on-request');
    assert.equal(row!.autonomy_rank, 'read-only');
  } finally {
    s.done();
  }
});
