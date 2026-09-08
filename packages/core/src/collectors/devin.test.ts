import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../sqlite';
import { collectDevin } from './devin';
import { makeStore } from './test-store';

/** A fake Devin acp-messages db: (position, kind, payload) rows. */
function devinDb(home: string, uuid: string, rows: { kind: string; payload: Record<string, unknown> }[]) {
  const dir = join(home, 'Library', 'Application Support', 'Devin', 'User', 'acp-messages');
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, `${uuid}.db`));
  db.exec('CREATE TABLE messages (position INTEGER PRIMARY KEY, kind TEXT, payload TEXT)');
  for (const [i, r] of rows.entries()) {
    db.prepare('INSERT INTO messages VALUES (?, ?, ?)').run(i, r.kind, JSON.stringify(r.payload));
  }
  db.close();
}

test('devin: tool calls keyed by the vendor content.toolCallId; turns stay activity_only', () => {
  const s = makeStore('devin');
  try {
    devinDb(s.home, 'sess-uuid-1', [
      { kind: 'user_message', payload: { turnId: 't1', content: [] } },
      { kind: 'agent_message', payload: { turnId: 't1', content: [{ _meta: { 'cognition.ai/timestamp': '2026-01-01T00:00:01.000Z' } }] } },
      { kind: 'tool_call', payload: { turnId: 't1', content: [{ toolCallId: 'tc_789' }] } },
      { kind: 'agent_message', payload: { turnId: 't1', content: [{ _meta: { 'cognition.ai/timestamp': '2026-01-01T00:00:02.000Z' } }] } },
    ]);
    const r = collectDevin(s.db);
    assert.equal(r.events.length, 1, 'turns collapse to one activity row');
    assert.equal(r.events[0]!.event_key, 'devin:sess-uuid-1:t1');
    assert.equal(r.events[0]!.confidence, 'activity_only');
    assert.equal(r.events[0]!.total_tokens, null, 'Devin records no token data locally');

    assert.equal(r.toolCalls!.length, 1, 'the tool_call row finally exists');
    const c = r.toolCalls![0]!;
    assert.equal(c.tool_call_key, 'devin:sess-uuid-1:tc_789', 'the verified source-native key');
    assert.equal(c.tool, 'devin');
    assert.equal(c.raw_ref, `${join(s.home, 'Library', 'Application Support', 'Devin', 'User', 'acp-messages', 'sess-uuid-1.db')}#pos/2`);
  } finally {
    s.done();
  }
});
