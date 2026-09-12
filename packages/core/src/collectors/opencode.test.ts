import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../sqlite';
import { openDb, resetDbCache } from '../db';
import { collectOpencode } from './opencode';

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

    // An updated part (time_updated bumps) does not re-emit its stale message.
    const db2 = new Database(f.dbPath);
    db2.prepare('UPDATE part SET time_updated = 999, data = ? WHERE id = ?')
      .run(JSON.stringify({ type: 'tool', tool: 'bash' }), 'p1');
    db2.close();
    const fourth = collectOpencode(s.db);
    assert.equal(fourth.events.length, 0);
    fourth.commit!();
  } finally {
    s.done();
  }
});

test('opencode: an in-flight turn is not passed by the cursor, and completes into real tokens', () => {
  const s = makeStore('oc-inflight');
  try {
    const dir = join(s.home, '.local', 'share', 'opencode');
    mkdirSync(dir, { recursive: true });
    const ocPath = join(dir, 'opencode.db');
    const oc = new Database(ocPath);
    oc.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_updated INTEGER);
      INSERT INTO session VALUES ('root', NULL, 'build');
    `);
    const write = (id: string, data: Record<string, unknown>) =>
      oc.prepare('INSERT OR REPLACE INTO message VALUES (?, ?, ?, ?)')
        .run(id, 'root', 1000, JSON.stringify({ role: 'assistant', modelID: 'claude-opus-5', providerID: 'anthropic', path: { cwd: '/w' }, ...data }));

    // Turn 1 is mid-flight exactly as OpenCode writes it: row present, zeros, no completion.
    write('m-live', { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1000 } });
    const p1 = collectOpencode(s.db);
    p1.commit?.();
    const cursorAfterInflight = Number(
      (s.db.prepare('SELECT last_offset AS o FROM collector_state WHERE source_path = ?')
        .get(`${ocPath}#message`) as { o: number }).o,
    );
    assert.equal(cursorAfterInflight, 0, 'the cursor must not pass an unfinished message');

    // A later, settled message must not drag the cursor past the unfinished one.
    write('m-done', { cost: 0.02, tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1100, completed: 1200 }, finish: 'stop' });
    const p2 = collectOpencode(s.db);
    p2.commit?.();
    assert.equal(
      Number((s.db.prepare('SELECT last_offset AS o FROM collector_state WHERE source_path = ?')
        .get(`${ocPath}#message`) as { o: number }).o),
      0,
      'a settled row behind an unfinished one still cannot advance the watermark',
    );

    // The turn completes in place, at the same rowid — the values Vole must pick up.
    write('m-live', { cost: 0.05, tokens: { input: 500, output: 50, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1000, completed: 1500 }, finish: 'stop' });
    oc.close();

    const p3 = collectOpencode(s.db);
    const healed = p3.events.find((e) => e.event_key === 'opencode:m-live');
    assert.ok(healed, 'the completed turn is read');
    assert.equal(healed!.total_tokens, 550, 'its real tokens are recovered, not frozen at 0');
    assert.equal(healed!.cost_usd, 0.05, 'and its real cost');
    p3.commit?.();
    assert.ok(
      Number((s.db.prepare('SELECT last_offset AS o FROM collector_state WHERE source_path = ?')
        .get(`${ocPath}#message`) as { o: number }).o) > 0,
      'once everything is settled the watermark advances again',
    );
  } finally {
    s.done();
  }
});
