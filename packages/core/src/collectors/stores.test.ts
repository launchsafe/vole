import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../sqlite';
import { collectGoose, collectAmp, collectContinue } from './stores';
import { makeStore } from './test-store';

test('goose: the ~/.local/share sessions.db token ledger, read by probed schema', () => {
  const s = makeStore('goose');
  try {
    const dir = join(s.home, '.local', 'share', 'goose', 'sessions');
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, 'sessions.db'));
    db.exec('CREATE TABLE message (id INTEGER PRIMARY KEY, session_id TEXT, data TEXT)');
    db.prepare('INSERT INTO message VALUES (1, ?, ?)').run(
      'g-sess-1',
      JSON.stringify({ role: 'assistant', model: 'claude-sonnet-4', usage: { inputTokens: 80, outputTokens: 20 } }),
    );
    db.prepare('INSERT INTO message VALUES (2, ?, ?)').run(
      'g-sess-1',
      JSON.stringify({ role: 'assistant', model: 'claude-sonnet-4', usage: { inputTokens: 40, outputTokens: 5, cacheReadInputTokens: 10 } }),
    );
    db.close();
    const r = collectGoose(s.db);
    assert.equal(r.events.length, 2);
    const [e0, e1] = r.events;
    assert.equal(e0!.confidence, 'exact');
    assert.equal(e0!.session_id, 'g-sess-1');
    assert.equal(e0!.input_tokens, 80);
    assert.equal(e0!.output_tokens, 20);
    assert.equal(e0!.cost_usd, null, 'BYOK: no plan rate applies');
    assert.equal(e1!.cache_read_tokens, 10);
    assert.ok(r.notes.some((n) => n.includes('unverified format')), 'the unverified shape is named, never guessed');
  } finally {
    s.done();
  }
});

test('amp: thread files with usage become exact rows; figure-less threads stay activity', () => {
  const s = makeStore('amp');
  try {
    const dir = join(s.home, '.local', 'share', 'amp', 'threads', 't1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'thread.json'), JSON.stringify({
      messages: [
        { sessionId: 'amp-1', model: 'claude-opus-5', timestamp: '2026-01-01T00:00:00.000Z', usage: { inputTokens: 15, outputTokens: 5 } },
      ],
    }));
    writeFileSync(join(dir, 'bare.json'), JSON.stringify({ messages: [{ sessionId: 'amp-2', model: 'claude-opus-5' }] }));
    const r = collectAmp(s.db);
    assert.equal(r.events.length, 2);
    const measured = r.events.find((e) => e.confidence === 'exact')!;
    assert.equal(measured.input_tokens, 15);
    assert.equal(measured.session_id, 'amp-1');
    const activity = r.events.find((e) => e.confidence === 'activity_only')!;
    assert.equal(activity.total_tokens, null, 'no figures found is NULL, never 0');
  } finally {
    s.done();
  }
});

test('continue: dev_data tokensGenerated events become exact rows', () => {
  const s = makeStore('continue');
  try {
    const dir = join(s.home, '.continue', 'dev_data');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.jsonl'), [
      JSON.stringify({ type: 'tokensGenerated', sessionId: 'c-1', timestamp: '2026-01-01T00:00:00.000Z', usage: { inputTokens: 300, outputTokens: 60 } }),
      JSON.stringify({ type: 'chatInteraction', sessionId: 'c-1' }),
      JSON.stringify({ type: 'toolUsage', sessionId: 'c-1', toolName: 'edit' }),
    ].join('\n') + '\n');
    const r = collectContinue(s.db);
    assert.equal(r.events.length, 1);
    const e = r.events[0]!;
    assert.equal(e.event_key, `continue:${join(dir, 'a.jsonl').replace(s.home, '~')}:0`);
    assert.equal(e.input_tokens, 300);
    assert.equal(e.output_tokens, 60);
    assert.equal(e.confidence, 'exact');
  } finally {
    s.done();
  }
});
