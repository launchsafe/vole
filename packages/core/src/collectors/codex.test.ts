import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache } from '../db';
import { collectCodex } from './codex';

/** A migrated store in a fresh temp dir, pointed at by VOLE_DB / VOLE_HOME_OVERRIDE. */
function makeStore(prefix: string) {
  const home = mkdtempSync(join(tmpdir(), `vole-${prefix}-`));
  const dbFile = join(home, 'vole.db');
  process.env.VOLE_HOME_OVERRIDE = home;
  process.env.VOLE_DB = dbFile;
  return {
    db: openDb(dbFile),
    home,
    done() {
      resetDbCache();
      delete process.env.VOLE_HOME_OVERRIDE;
      delete process.env.VOLE_DB;
    },
  };
}

function fixture(root: string, name: string, lines: Record<string, unknown>[]): string {
  const dir = join(root, '.codex', 'sessions', '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${name}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
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

function run(_name: string, lines: Record<string, Record<string, unknown> | Record<string, unknown>[]>) {
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
    // The cursor lands in commit(), which the CLI calls only after insertEvents
    // succeeds — so a failed store cannot mark a rollout as scanned. Drive it the
    // way collect.ts does.
    first.commit?.();

    // Second pass, same store: the cursor knows (size, mtime) and skips the parse.
    const second = collectCodex(s.db);
    assert.equal(second.filesScanned, 0, 'unchanged files are not re-read');
    assert.equal(second.events.length, 0, 'and emit nothing to re-dedupe');
    second.commit?.();

    // An uncommitted pass must NOT advance the cursor: this is the data-loss
    // guard. Read the file again without committing, then confirm the next pass
    // still re-reads it.
    appendFileSync(file, JSON.stringify(tc(usage(180))) + '\n');
    const bump = new Date(Date.now() + 1000);
    utimesSync(file, bump, bump);
    const uncommitted = collectCodex(s.db);
    assert.equal(uncommitted.filesScanned, 1, 'a changed file is read');
    // deliberately no commit() — simulates insertEvents throwing
    const retry = collectCodex(s.db);
    assert.equal(retry.filesScanned, 1, 'an uncommitted read is retried, never skipped');
    retry.commit?.();

    // Appending changes mtime/size → the file is read again and the new event
    // lands under its own stable key; the old one is untouched.
    appendFileSync(file, JSON.stringify(tc(usage(250))) + '\n');
    const future = new Date(Date.now() + 2000); // same-ms writes can collide
    utimesSync(file, future, future);

    const third = collectCodex(s.db);
    assert.equal(third.filesScanned, 1, 'an appended file is read again');
    assert.deepEqual(
      third.events.map((e) => e.total_tokens).sort((a, b) => (a ?? 0) - (b ?? 0)),
      [70, 80, 100],
      // the meter is cumulative: 100, then 180-100=80, then 250-180=70
      're-read recomputes the same deltas (stable keys) plus the appended meter deltas',
    );
  } finally {
    s.done();
  }
});


test('rate limits ride out on the result for the rate-limit rule', () => {
  const s = makeStore('codex-rl');
  try {
    fixture(s.home, 'a', [META, MODEL, tc(usage(100), {
      primary: { used_percent: 41, window_minutes: 300 },
    })]);
    const r = collectCodex(s.db);
    assert.equal(r.rateLimits![0]!.used_percent, 41);
    assert.equal(r.rateLimits![0]!.window_minutes, 300);
  } finally {
    s.done();
  }
});
