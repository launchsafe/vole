import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../sqlite';
import type { DB } from '../db';
import { collectOpencode } from './opencode';

/** The three OpenCode tables the collector reads, with only the columns it uses. */
function fixture(home: string) {
  const dir = join(home, '.local', 'share', 'opencode');
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'opencode.db'));
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, agent TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
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
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p1', 'm-main', 'root', JSON.stringify({ type: 'tool', tool: 'bash' }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p2', 'm-main', 'root', JSON.stringify({ type: 'tool', tool: 'read' }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p3', 'm-main', 'root', JSON.stringify({ type: 'text' }));
  db.close();
}

test('opencode: tool parts, subagent sessions rolled into the parent, API errors flagged', () => {
  const home = mkdtempSync(join(tmpdir(), 'vole-oc-'));
  fixture(home);
  process.env.VOLE_HOME_OVERRIDE = home;
  try {
    const r = collectOpencode(null as unknown as DB);
    const by = Object.fromEntries(r.events.map((e) => [e.event_key, e]));
    assert.equal(by['opencode:m-main']!.tools, 'bash,read');
    assert.equal(by['opencode:m-main']!.agent_id, null);
    assert.equal(by['opencode:m-main']!.context_window, 1_000_000, 'anthropic provider resolves the window');
    assert.equal(by['opencode:m-child']!.session_id, 'root', 'child session spend belongs to the parent');
    assert.equal(by['opencode:m-child']!.agent_id, 'explore:child');
    assert.equal(by['opencode:m-fail']!.is_error, 1);
    assert.equal(by['opencode:m-fail']!.stop_reason, 'error');
  } finally {
    delete process.env.VOLE_HOME_OVERRIDE;
  }
});
