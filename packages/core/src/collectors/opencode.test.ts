import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../sqlite';
import { collectOpencode } from './opencode';
import { makeStore } from './test-store';

/** The three OpenCode tables the collector reads, with only the columns it uses. */
function fixture(home: string) {
  const dir = join(home, '.local', 'share', 'opencode');
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'opencode.db'));
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_updated INTEGER);
    INSERT INTO session VALUES ('root', NULL, 'build'), ('child', 'root', 'explore');
  `);
  const msg = (id: string, session: string, extra: Record<string, unknown> = {}) =>
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(id, session, 1000, JSON.stringify({
      role: 'assistant', cost: 0.01, modelID: 'claude-opus-5', providerID: 'anthropic',
      tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 50, write: 5 } },
      time: { created: 1000, completed: 2000 }, path: { cwd: '/w' }, finish: 'stop', ...extra,
    }));
  msg('m-main', 'root');
  msg('m-child', 'child');
  msg('m-fail', 'root', { tokens: { input: 0, output: 0 }, finish: undefined, error: { name: 'APIError' } });
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p1', 'm-main', 'root', JSON.stringify({ type: 'tool', tool: 'bash' }), 100);
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p2', 'm-main', 'root', JSON.stringify({ type: 'tool', tool: 'read' }), 100);
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p3', 'm-main', 'root', JSON.stringify({ type: 'text' }), 100);
  db.close();
  return { dbPath: join(dir, 'opencode.db'), msg };
}

test('opencode: tool parts, subagent sessions rolled into the parent, API errors flagged', () => {
  const s = makeStore('oc');
  try {
    fixture(s.home);
    const r = collectOpencode(s.db);
    const by = Object.fromEntries(r.events.map((e) => [e.event_key, e]));
    assert.equal(by['opencode:m-main']!.tools, 'bash,read');
    assert.equal(by['opencode:m-main']!.agent_id, null);
    assert.equal(by['opencode:m-main']!.context_window, 1_000_000, 'anthropic provider resolves the window');
    assert.equal(by['opencode:m-child']!.session_id, 'root', 'child session spend belongs to the parent');
    assert.equal(by['opencode:m-child']!.agent_id, 'explore:child');
    assert.equal(by['opencode:m-fail']!.is_error, 1);
    assert.equal(by['opencode:m-fail']!.stop_reason, 'error');
  } finally {
    s.done();
  }
});

test('opencode: the declared cursors bound the re-read — new rows only, updated parts re-read', () => {
  const s = makeStore('oc2');
  const f = fixture(s.home);
  try {
    // First pass reads everything and advances the watermarks on commit.
    const first = collectOpencode(s.db);
    assert.equal(first.events.length, 3);
    first.commit!();

    // Second pass, nothing new: bounded queries return nothing.
    const second = collectOpencode(s.db);
    assert.equal(second.events.length, 0, 'no message rowid past the cursor');
    assert.equal(second.toolCalls!.length, 0, 'no part rowid/time_updated past the cursor');

    // A new message lands: exactly it is read (and its parts, joined by id).
    const db = new Database(f.dbPath);
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m-new', 'root', 2000, JSON.stringify({
      role: 'assistant', cost: 0.02, modelID: 'claude-opus-5', providerID: 'anthropic',
      tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 2000, completed: 2500 }, path: { cwd: '/w' }, finish: 'stop',
    }));
    // A part written AFTER its message was already consumed — name attribution
    // must still find it via the message_id join, not the part cursor.
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p9', 'm-main', 'root', JSON.stringify({ type: 'tool', tool: 'grep' }), 100);
    db.close();

    const third = collectOpencode(s.db);
    assert.deepEqual(third.events.map((e) => e.event_key), ['opencode:m-new'], 'only the new message row');
    assert.equal(third.events[0]!.tools, null, 'm-new has no parts');
    third.commit!(); // store the new watermarks, as the CLI does

    // An updated part (time_updated bumps) is re-read for the ledger even at
    // an old rowid, and a stale message is not re-emitted.
    const db2 = new Database(f.dbPath);
    db2.prepare('UPDATE part SET time_updated = 999, data = ? WHERE id = ?')
      .run(JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', metadata: { exit: 0 }, time: { start: 100, end: 140 } } }), 'p1');
    db2.close();
    const fourth = collectOpencode(s.db);
    assert.equal(fourth.events.length, 0);
    const p1 = fourth.toolCalls!.find((c) => c.tool_call_key === 'opencode:p1');
    assert.ok(p1, 'the updated part is re-read through time_updated');
    assert.equal(p1!.status, 'success');
    assert.equal(p1!.duration_ms, 40, 'the part state carries a measured span');

    // observed_at is stamped only on commit, after the rows are stored.
    fourth.commit!();
  } finally {
    s.done();
  }
});
