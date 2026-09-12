import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../sqlite';
import { SCHEMA } from '../schema';
import { bubbleTs, collectCursor } from './cursor';

/** A conversation envelope, as loaded from `composerData:<id>`. */
function composer(over: Partial<Parameters<typeof bubbleTs>[0]> = {}) {
  const order = new Map<string, number>();
  return {
    createdAt: 1_000_000,
    lastUpdatedAt: 1_000_000 + 10 * 60_000, // a ten-minute conversation
    model: null,
    order,
    size: 5,
    ...over,
  };
}

test('bubbles spread evenly across the conversation, not onto one instant', () => {
  const c = composer();
  const ts = [0, 1, 2, 3, 4].map((i) => bubbleTs(c, i, 0));

  assert.equal(ts[0], c.createdAt, 'the first message sits at the start');
  assert.equal(ts[4], c.lastUpdatedAt, 'the last sits at the end');
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b), 'strictly ordered');
  // The whole point: stamping every bubble at createdAt would drop a conversation's
  // worth of calls onto one millisecond and fabricate a burn-rate spike.
  assert.equal(new Set(ts).size, 5, 'no two messages share a timestamp');
  const gaps = ts.slice(1).map((t, i) => t - ts[i]!);
  assert.equal(new Set(gaps).size, 1, 'evenly spaced');
});

test('a single-message conversation sits at its start, with no division by zero', () => {
  const ts = bubbleTs(composer({ size: 1 }), 0, 7);
  assert.equal(ts, 1_000_000);
  assert.ok(Number.isFinite(ts));
});

test('an ordinal past the end is clamped rather than extrapolated past lastUpdatedAt', () => {
  const c = composer();
  assert.equal(bubbleTs(c, 99, 0), c.lastUpdatedAt, 'never lands after the conversation ended');
});

test('a conversation with no end falls back to its start', () => {
  assert.equal(bubbleTs(composer({ lastUpdatedAt: null }), 3, 0), 1_000_000);
});

test('an end at or before the start yields the start, never a negative step', () => {
  const c = composer({ lastUpdatedAt: 999_000 });
  const ts = [0, 1, 2].map((i) => bubbleTs(c, i, 0));
  assert.deepEqual(ts, [1_000_000, 1_000_000, 1_000_000]);
});

test('a conversation with no time at all uses the caller-supplied fallback', () => {
  // A bubble whose composerData row is gone still represents real spend; it is kept
  // at the store's mtime and reported, rather than dropped or given a fake time.
  assert.equal(bubbleTs(composer({ createdAt: null, lastUpdatedAt: null }), 0, 4_242), 4_242);
});

test('interpolation is deterministic, which is what lets verify re-derive it', () => {
  const c = composer();
  assert.equal(bubbleTs(c, 2, 0), bubbleTs(c, 2, 0));
  assert.equal(bubbleTs(c, 2, 0), 1_300_000);
});

/** A throwaway store shaped like Cursor's own `cursorDiskKV`. */
function cursorStore(rows: [string, unknown][]): string {
  const file = join(mkdtempSync(join(tmpdir(), 'vole-cursor-')), 'state.vscdb');
  const db = new Database(file);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)');
  const ins = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  for (const [k, v] of rows) ins.run(k, JSON.stringify(v));
  db.close();
  return file;
}

test('the collector tiers each turn by whether Cursor recorded a real count', () => {
  const CID = 'c-1';
  const file = cursorStore([
    [`composerData:${CID}`, {
      createdAt: 1_000_000,
      lastUpdatedAt: 1_600_000,
      fullConversationHeadersOnly: [
        { bubbleId: 'measured' }, { bubbleId: 'recent' }, { bubbleId: 'stub' },
      ],
    }],
    // Recorded a count — the pre-April-2026 shape.
    [`bubbleId:${CID}:measured`, { type: 2, text: 'answer', tokenCount: { inputTokens: 900, outputTokens: 100 } }],
    // A real turn Cursor no longer counts: the field is present, written as zero.
    [`bubbleId:${CID}:recent`, { type: 2, text: 'answer', tokenCount: { inputTokens: 0, outputTokens: 0 } }],
    // Neither tokens nor text: a placeholder, not evidence a call happened.
    [`bubbleId:${CID}:stub`, { type: 2, text: '', tokenCount: { inputTokens: 0, outputTokens: 0 } }],
    // A user turn is not a model call.
    [`bubbleId:${CID}:human`, { type: 1, text: 'question' }],
  ]);

  const store = new Database(join(mkdtempSync(join(tmpdir(), 'vole-db-')), 'v.db'));
  store.exec(SCHEMA);
  const prev = process.env.VOLE_CURSOR_STATE_DB;
  process.env.VOLE_CURSOR_STATE_DB = file;
  try {
    const out = collectCursor(store);
    const byKey = new Map(out.events.map((e) => [e.event_key.split(':').pop(), e]));

    assert.equal(out.events.length, 2, 'the stub and the human turn are not calls');

    const measured = byKey.get('measured');
    assert.equal(measured?.confidence, 'exact');
    assert.equal(measured?.total_tokens, 1000);

    const recent = byKey.get('recent');
    assert.equal(recent?.confidence, 'activity_only', 'a written zero is not a measurement');
    assert.equal(recent?.total_tokens, null, 'and it must never be given an inferred count');
    assert.equal(recent?.cost_usd, null);
  } finally {
    if (prev === undefined) delete process.env.VOLE_CURSOR_STATE_DB;
    else process.env.VOLE_CURSOR_STATE_DB = prev;
  }
});
