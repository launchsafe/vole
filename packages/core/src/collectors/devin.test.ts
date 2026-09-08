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

// Real ACP shapes, captured from a live Devin acp-messages db (2026-08):
// kind='tool_call' rows carry content as a single OBJECT; agent_message rows
// carry an array of chunks. The old collector iterated content and died with
// "object is not iterable" on the first tool_call row.
test('devin: object-form tool_call content does not crash; array agent_message still collapses', () => {
  const s = makeStore('devin-object-content');
  try {
    devinDb(s.home, 'sess-uuid-2', [
      {
        kind: 'tool_call',
        payload: {
          kind: 'tool_call',
          content: {
            toolCallId: 'chatcmpl-tool-86cebb8203914769',
            title: 'Searched for chat text box input',
            kind: 'search',
            _meta: { 'cognition.ai/inferenceToolName': 'find_code_context', 'cognition.ai/timestamp': '2026-08-22T04:33:24.206590+00:00' },
          },
        },
      },
      {
        kind: 'agent_message',
        payload: {
          turnId: 'be125ca9-abad-4cbe-9934-6108d79c7e07',
          content: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' }, _meta: { 'cognition.ai/timestamp': '2026-08-22T04:33:21.433580+00:00' } }],
        },
      },
      {
        kind: 'agent_message',
        payload: {
          turnId: 'be125ca9-abad-4cbe-9934-6108d79c7e07',
          content: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' there' }, _meta: { 'cognition.ai/timestamp': '2026-08-22T04:33:22.000000+00:00' } }],
        },
      },
    ]);
    const r = collectDevin(s.db);
    assert.equal(r.events.length, 1, 'streamed chunks collapse to one turn row');
    assert.equal(r.events[0]!.event_key, 'devin:sess-uuid-2:be125ca9-abad-4cbe-9934-6108d79c7e07');
    assert.equal(r.events[0]!.ts, Date.parse('2026-08-22T04:33:21.433580+00:00'));

    assert.equal(r.toolCalls!.length, 1);
    const c = r.toolCalls![0]!;
    assert.equal(c.tool_call_key, 'devin:sess-uuid-2:chatcmpl-tool-86cebb8203914769', 'object-form content.toolCallId is read');
    assert.equal(c.ts, Date.parse('2026-08-22T04:33:24.206590+00:00'), 'object-form _meta timestamp is read, not file mtime');
  } finally {
    s.done();
  }
});

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
