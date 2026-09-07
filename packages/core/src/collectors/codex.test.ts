import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../sqlite';
import { SCHEMA } from '../schema';
import type { DB } from '../db';
import { collectCodex } from './codex';

function fixture(root: string, name: string, lines: Record<string, unknown>[]): string {
  const dir = join(root, '.codex', 'sessions', '2026', '01', '01');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-${name}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

function tc(info: Record<string, unknown>) {
  return { type: 'event_msg', timestamp: '2026-01-01T00:00:00.000Z', payload: { type: 'token_count', info } };
}

function run(name: string, lines: Record<string, Record<string, unknown>[]>) {
  const root = mkdtempSync(join(tmpdir(), 'vole-codex-'));
  process.env.VOLE_HOME_OVERRIDE = root;
  try {
    for (const [n, l] of Object.entries(lines)) fixture(root, n, l);
    const db: DB = new Database(join(root, 't.db'));
    db.exec(SCHEMA);
    return { result: collectCodex(db), db, root };
  } finally {
    delete process.env.VOLE_HOME_OVERRIDE;
  }
}

const META = { type: 'session_meta', payload: { id: 'sess-1' } };
const MODEL = { type: 'turn_context', payload: { model: 'gpt-5.5' } };

test('zero breakdown: the meter delta is kept exact, components stay NULL', () => {
  const { result: r } = run('zero', {
    a: [META, MODEL, tc({
      total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 73256 },
      last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 73256 },
    })],
  });
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
  const { result: r } = run('healthy', {
    a: [META, MODEL, tc({
      total_token_usage: { input_tokens: 17038, cached_input_tokens: 5504, output_tokens: 452, reasoning_output_tokens: 361, total_tokens: 17490 },
      last_token_usage: { input_tokens: 17038, cached_input_tokens: 5504, output_tokens: 452, reasoning_output_tokens: 361, total_tokens: 17490 },
    })],
  });
  const e = r.events[0]!;
  assert.equal(e.total_tokens, 17490);
  assert.equal(e.input_tokens, 17038 - 5504, 'cached input is separated from fresh input');
  assert.equal(e.cache_read_tokens, 5504);
  assert.equal(e.output_tokens, 452);
  assert.equal(e.reasoning_tokens, 361);
});

test('duplicate emission advances the meter by zero and is skipped', () => {
  const info = {
    total_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1050 },
    last_token_usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1050 },
  };
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

test('partial breakdown: meter total kept, cost NULL (split does not cover the meter)', () => {
  const { result: r } = run('partial', {
    a: [META, { type: 'turn_context', payload: { model: 'claude-opus-5' } }, tc({
      total_token_usage: { input_tokens: 6047, cached_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0, total_tokens: 6075 },
      last_token_usage: { input_tokens: 6047, cached_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0, total_tokens: 6075 },
    })],
  });
  const e = r.events[0]!;
  assert.equal(e.total_tokens, 6075);
  assert.equal(e.input_tokens, 6047, 'the reported split is real and is kept');
  assert.equal(e.cost_usd, null, '25 unattributable tokens make the cost unknown, not approximate');
});

test('tool calls since the previous meter event are attributed to it, with the tool-reported window', () => {
  const call = (name: string) => ({ type: 'response_item', payload: { type: 'function_call', name } });
  const { result: r } = run('tools', {
    a: [META, MODEL, call('exec_command'), call('apply_patch'), tc({
      total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 },
      last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 },
      model_context_window: 258400,
    })],
  });
  assert.equal(r.events[0]!.tools, 'exec_command,apply_patch');
  assert.equal(r.events[0]!.context_window, 258400);
});

test('B2: rollout files sharing a session id never collide on event_key', () => {
  // A sub-agent rollout replays the parent's session_meta verbatim, so both files
  // carry id sess-1. The keys must still be distinct or one file's rows silently
  // vanish (INSERT OR IGNORE) and the session tree under-counts.
  const info = (total: number) => ({
    total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total },
    last_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total },
  });
  const { result: r } = run('shared', {
    parent: [META, MODEL, tc(info(100))],
    'sub-agent': [META, MODEL, tc(info(200))],
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

test('B13: unchanged rollout files are skipped by the (size, mtime) cursor', () => {
  const info = (total: number) => ({
    total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total },
    last_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total },
  });
  // The override must stay live for all three passes — this test drives the
  // collector directly instead of through run().
  const root = mkdtempSync(join(tmpdir(), 'vole-codex-cursor-'));
  process.env.VOLE_HOME_OVERRIDE = root;
  try {
    const file = fixture(root, 'a', [META, MODEL, tc(info(100))]);
    const db: DB = new Database(join(root, 't.db'));
    db.exec(SCHEMA);

    const first = collectCodex(db);
    assert.equal(first.events.length, 1);
    assert.equal(first.filesScanned, 1, 'first pass reads the file');

    // Second pass, same store: the cursor knows (size, mtime) and skips the parse.
    const second = collectCodex(db);
    assert.equal(second.filesScanned, 0, 'unchanged files are not re-read');
    assert.equal(second.events.length, 0, 'and emit nothing to re-dedupe');

    // Appending changes mtime/size → the file is read again and the new event
    // lands under its own stable key; the old one is untouched.
    appendFileSync(file, JSON.stringify(tc(info(250))) + '\n');
    const future = new Date(Date.now() + 2000); // same-ms writes can collide
    utimesSync(file, future, future);

    const third = collectCodex(db);
    assert.equal(third.filesScanned, 1, 'an appended file is read again');
    assert.deepEqual(
      third.events.map((e) => e.total_tokens).sort((a, b) => (a ?? 0) - (b ?? 0)),
      [100, 150],
      're-read recomputes the same first delta (stable key) and the appended meter delta',
    );
  } finally {
    delete process.env.VOLE_HOME_OVERRIDE;
  }
});
