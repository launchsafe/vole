import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectGemini } from './gemini';
import { makeStore } from './test-store';

test('gemini: per-turn chats rows with verbatim tokens, plus the logPrompts posture row', () => {
  const s = makeStore('gemini');
  try {
    const chats = join(s.home, '.gemini', 'tmp', 'projhash1', 'chats');
    mkdirSync(chats, { recursive: true });
    writeFileSync(join(chats, 'chat-42.json'), JSON.stringify({
      turns: [
        { model: 'gemini-2.5-pro', timestamp: '2026-01-01T00:00:01.000Z', usage: { inputTokens: 120, outputTokens: 30 }, functionCalls: [{ name: 'read_file' }] },
        { model: 'gemini-2.5-pro', timestamp: '2026-01-01T00:00:02.000Z', usage: { inputTokens: 200, outputTokens: 45 } },
        { model: 'gemini-2.5-pro' }, // no figures: nothing measured, no row
      ],
    }));
    mkdirSync(join(s.home, '.gemini'), { recursive: true });
    writeFileSync(join(s.home, '.gemini', 'settings.json'), JSON.stringify({
      telemetry: { logPrompts: true, outfile: '/tmp/gemini-prompts.log' },
    }));
    const r = collectGemini(s.db);
    assert.equal(r.events.length, 2, 'one exact row per measured turn, nothing for the unmeasured one');
    const [t0, t1] = r.events;
    assert.equal(t0!.event_key, 'gemini_cli:projhash1:chat-42:0');
    assert.equal(t0!.input_tokens, 120);
    assert.equal(t0!.output_tokens, 30);
    assert.equal(t0!.total_tokens, 150);
    assert.equal(t0!.tools, 'read_file');
    assert.equal(t0!.confidence, 'exact');
    assert.equal(t1!.event_key, 'gemini_cli:projhash1:chat-42:1');

    const levers = s.db
      .prepare("SELECT lever, observed_value FROM posture_levers WHERE agent = 'gemini'")
      .all() as { lever: string; observed_value: string }[];
    const byLever = Object.fromEntries(levers.map((l) => [l.lever, l.observed_value]));
    assert.equal(byLever['telemetry.logPrompts'], 'true', 'the prompts-logged-to-disk fact, with the settings file as evidence');
    assert.equal(byLever['telemetry.outfile'], '/tmp/gemini-prompts.log');
  } finally {
    s.done();
  }
});

test('gemini: the stats meter stays the fallback when the chats aged out', () => {
  const s = makeStore('gemini2');
  try {
    const tmp = join(s.home, '.gemini', 'tmp', 'sesshash2');
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'stats.json'), JSON.stringify({ total_token_count: 4242, models: { 'gemini-2.5-flash': {} } }));
    const r = collectGemini(s.db);
    assert.equal(r.events.length, 1);
    const e = r.events[0]!;
    assert.equal(e.event_key, 'gemini:sesshash2');
    assert.equal(e.total_tokens, 4242);
    assert.equal(e.model, 'gemini-2.5-flash');
  } finally {
    s.done();
  }
});
