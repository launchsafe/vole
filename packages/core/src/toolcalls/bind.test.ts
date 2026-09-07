import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../sqlite';
import { SCHEMA } from '../schema';
import { openDb, resetDbCache } from '../db';
import { insertToolCalls, skeletonize, argsDigest, type ToolCallRow } from './bind';

function store() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'vole-tc-')), 't.db'));
  db.exec(SCHEMA);
  db.exec(`CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tool_call_key TEXT NOT NULL UNIQUE,
    tool TEXT NOT NULL, name TEXT NOT NULL, shape TEXT, args_digest TEXT,
    session_id TEXT, agent_id TEXT, ts INTEGER NOT NULL, status TEXT,
    status_source TEXT, duration_ms INTEGER, duration_kind TEXT, authority TEXT,
    raw_ref TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL)`);
  return db;
}

function call(over: Partial<ToolCallRow>): ToolCallRow {
  return {
    tool_call_key: 'k1', tool: 'claude_code', name: 'Bash', ts: 1000,
    ...over,
  };
}

test('two-phase bind: the call inserts, the result widens only NULLs', () => {
  const db = store();
  // Phase 1: the invocation — no outcome yet.
  assert.equal(insertToolCalls(db, [call({ tool_call_key: 'c1', shape: 'git push' })]), 1);
  // Phase 2: the result arrives (possibly from a later pass).
  assert.equal(
    insertToolCalls(db, [call({ tool_call_key: 'c1', name: '', status: 'success', status_source: 'result_flag' })]),
    1,
    'the widening counts as a change',
  );
  const row = db.prepare('SELECT name, status, status_source FROM tool_calls WHERE tool_call_key = ?').get('c1') as {
    name: string; status: string; status_source: string;
  };
  assert.equal(row.status, 'success');
  assert.equal(row.status_source, 'result_flag');
  assert.equal(row.name, 'Bash', 'phase-2 must not blank the phase-1 name');

  // Phase 2 replay: a no-op.
  assert.equal(
    insertToolCalls(db, [call({ tool_call_key: 'c1', name: '', status: 'error', status_source: 'result_flag' })]),
    0,
    'a stored status is never overwritten — error must not replace success',
  );
  const row2 = db.prepare('SELECT status FROM tool_calls WHERE tool_call_key = ?').get('c1') as { status: string };
  assert.equal(row2.status, 'success', 'NULL-only widening: stored facts are final');
});

test('two-phase bind: re-emitting phase 1 after phase 2 changes nothing', () => {
  const db = store();
  insertToolCalls(db, [call({ tool_call_key: 'c2', status: 'error', status_source: 'exit_code' })]);
  assert.equal(insertToolCalls(db, [call({ tool_call_key: 'c2', status: null, status_source: null })]), 0);
  const row = db.prepare('SELECT status FROM tool_calls WHERE tool_call_key = ?').get('c2') as { status: string };
  assert.equal(row.status, 'error', 'a NULL never widens a stored value');
});

test('skeletonize: structure survives, content collapses', () => {
  assert.equal(skeletonize('Bash', 'rm -rf /Users/shiva/secret-project'), 'rm -rf');
  assert.equal(skeletonize('Bash', 'rm -rf /different/path/entirely'), 'rm -rf', 'same shape, different paths');
  assert.equal(skeletonize('Bash', 'git push origin main'), 'git push');
  assert.equal(skeletonize('Bash', 'ssh -p 2222 prod.example.com'), 'ssh -p');
  assert.equal(skeletonize('Bash', 'curl -X POST https://api.example.com/v1/x'), 'curl -X');
  assert.equal(skeletonize('Bash', 'ls -la'), 'ls', 'unknown binaries collapse to the program name');
  assert.equal(skeletonize('Read', { file_path: '/x' }), 'Read', 'non-shell tools are their own shape');
});

test('argsDigest: identical calls collide, different calls do not', () => {
  assert.equal(argsDigest({ a: 1, b: 2 }), argsDigest({ b: 2, a: 1 }), 'key order does not matter');
  assert.notEqual(argsDigest({ a: 1 }), argsDigest({ a: 2 }));
  assert.notEqual(argsDigest('rm -rf /x'), argsDigest('rm -rf /y'));
});
