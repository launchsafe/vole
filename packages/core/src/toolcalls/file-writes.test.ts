import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache, type DB } from '../db';
import { insertToolCalls, type ToolCallRow } from './bind';
import {
  fileWritesForCall, insertFileWrites, emitFileWrites, structuredWriteTargets,
} from './file-writes';
import { PATH_CLASSES } from './patterns';

/** A fully-migrated store in a temp dir — the schema the ledger writes against. */
function store(): DB {
  const dir = mkdtempSync(join(tmpdir(), 'vole-fw-'));
  resetDbCache();
  return openDb(join(dir, 't.db'));
}

function call(over: Partial<ToolCallRow>): ToolCallRow {
  return { tool_call_key: 'k1', tool: 'claude_code', name: 'Bash', ts: 1000, ...over };
}

// ── the real arg shapes observed in the wild ──────────────────────────────

test('structured targets: file_path (claude_code), filePath (opencode), notebook_path, path', () => {
  assert.deepEqual(
    structuredWriteTargets('Edit', { file_path: '/repo/a.ts' }),
    ['/repo/a.ts'],
  );
  assert.deepEqual(
    structuredWriteTargets('edit', { filePath: '/repo/b.ts', oldString: 'x', newString: 'y' }),
    ['/repo/b.ts'],
    'opencode names the file filePath, not file_path',
  );
  assert.deepEqual(
    structuredWriteTargets('NotebookEdit', { notebook_path: '/repo/n.ipynb' }),
    ['/repo/n.ipynb'],
  );
  assert.deepEqual(
    structuredWriteTargets('write', { path: '/repo/c.ts', content: 'x' }),
    ['/repo/c.ts'],
  );
  // No recognisable key: no target, but the call is still a write (see below).
  assert.deepEqual(structuredWriteTargets('Edit', { diff: '...' }), []);
});

test('apply_patch: targets come out of the patch body headers', () => {
  const patch =
    '*** Begin Patch\n*** Update File: /repo/src/a.ts\n@@\n-x\n+y\n*** Add File: /repo/new.ts\n+z\n*** Delete File: /repo/gone.ts\n*** End Patch';
  assert.deepEqual(structuredWriteTargets('apply_patch', { patchText: patch }), [
    '/repo/src/a.ts',
    '/repo/new.ts',
    '/repo/gone.ts',
  ]);
  // codex sends the patch body as a bare input string
  assert.equal(structuredWriteTargets('apply_patch', patch).length, 3);
});

test('fileWritesForCall: a structured call with no readable target still counts', () => {
  const rows = fileWritesForCall('Edit', { diff: '...' }, { tool_call_key: 'tc9' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.path, null, 'target not recorded — NULL, never dropped');
  assert.equal(rows[0]!.write_class, 'structured');
});

test('bash variants: bash/exec/run_terminal_command command strings parse', () => {
  for (const name of ['bash', 'exec', 'run_terminal_command', 'shell', 'exec_command']) {
    const rows = fileWritesForCall(name, { cmd: 'echo hi >> /tmp/append.log' }, { tool_call_key: 'tc' });
    assert.equal(rows.length, 1, `${name} is a shell tool`);
    assert.equal(rows[0]!.path, '/tmp/append.log');
  }
  // A non-write tool named like nothing: no rows, no guesses.
  assert.equal(fileWritesForCall('Read', { file_path: '/x' }, { tool_call_key: 'tc' }).length, 0);
});

test('cwd from the call context resolves relative targets', () => {
  const rows = fileWritesForCall('bash', { command: 'sed -i "" s/a/b/ src/x.ts' }, {
    tool_call_key: 'tc', session_id: 's', ts: 1, cwd: '/repo',
  });
  assert.equal(rows[0]!.path, '/repo/src/x.ts');
});

// ── the from-store backfill ──────────────────────────────────────────────

test('emitFileWrites: coarse rows for historical calls, path NULL, idempotent', () => {
  const db = store();
  insertToolCalls(db, [
    call({ tool_call_key: 'e1', name: 'Edit', shape: 'Edit', session_id: 's1', ts: 10 }),
    call({ tool_call_key: 'w1', name: 'write', shape: 'write', session_id: 's1', ts: 20 }),
    call({ tool_call_key: 'b1', name: 'bash', shape: 'tee', session_id: 's1', ts: 30 }),
    call({ tool_call_key: 'b2', name: 'Bash', shape: 'cp -r', session_id: 's1', ts: 40 }),
    call({ tool_call_key: 'b3', name: 'Bash', shape: 'sed', session_id: 's1', ts: 50 }), // -i not provable
    call({ tool_call_key: 'r1', name: 'Read', shape: 'Read', session_id: 's1', ts: 60 }),
  ]);
  const n = emitFileWrites(db);
  assert.equal(n, 4, 'structured + tee + cp; sed-without--i and Read prove nothing');
  const rows = db.prepare('SELECT write_key, path, write_class FROM file_writes ORDER BY write_key').all() as {
    write_key: string; path: string | null; write_class: string;
  }[];
  assert.deepEqual(rows.map((r) => r.write_key), ['b1#0', 'b2#0', 'e1#0', 'w1#0']);
  assert.ok(rows.every((r) => r.path === null), 'the store never kept the args — NULL, never guessed');
  assert.deepEqual(rows.map((r) => r.write_class).sort(), ['bash_redirect', 'copy', 'structured', 'structured']);
  assert.equal(emitFileWrites(db), 0, 'presence-gated: a second pass emits nothing');
});

test('emitFileWrites: a call with a rich bind-time row is not re-emitted, and a rich row widens a coarse one', () => {
  const db = store();
  insertToolCalls(db, [call({ tool_call_key: 'e2', name: 'Edit', shape: 'Edit', session_id: 's2', ts: 10 })]);
  // Bind-time rich row first: emitFileWrites must skip the call entirely.
  insertFileWrites(db, fileWritesForCall('Edit', { file_path: '/repo/.env' }, {
    tool_call_key: 'e2', session_id: 's2', ts: 10, cwd: '/repo',
  }));
  assert.equal(emitFileWrites(db), 0);

  // The other order: coarse first, rich later — same #0 key, NULL-only growth.
  insertToolCalls(db, [call({ tool_call_key: 'e3', name: 'Edit', shape: 'Edit', session_id: 's2', ts: 20 })]);
  assert.equal(emitFileWrites(db), 1);
  const changed = insertFileWrites(db, fileWritesForCall('Edit', { file_path: '/repo/x.ts' }, {
    tool_call_key: 'e3', session_id: 's2', ts: 20, cwd: '/repo',
  }));
  assert.equal(changed, 1, 'the rich row widens the coarse row');
  const row = db.prepare('SELECT path, path_class FROM file_writes WHERE write_key = ?').get('e3#0') as {
    path: string | null; path_class: string | null;
  };
  assert.equal(row.path, '/repo/x.ts');
  assert.equal(row.path_class, null, 'no pack class for a plain source path');
  const count = db.prepare('SELECT COUNT(*) AS n FROM file_writes WHERE tool_call_key = ?').get('e3') as { n: number };
  assert.equal(count.n, 1, 'coarse and rich share one key — no double count');
});

test('emitFileWrites: the versioned path-class pack is registered as a side effect', () => {
  const db = store();
  emitFileWrites(db);
  const rows = db.prepare('SELECT pattern_id, pack_version FROM path_classes').all() as {
    pattern_id: string; pack_version: number;
  }[];
  assert.equal(rows.length, PATH_CLASSES.length);
  assert.ok(rows.every((r) => r.pack_version >= 1));
});

test('content_rev discipline holds for real paths under insertFileWrites', () => {
  const db = store();
  const mk = (key: string, p: string) => fileWritesForCall('Write', { file_path: p }, {
    tool_call_key: key, session_id: 's3', ts: 1,
  })[0]!;
  insertFileWrites(db, [mk('k1', '/repo/a.ts'), mk('k2', '/repo/a.ts')]);
  const revs = db.prepare('SELECT content_rev FROM file_writes ORDER BY write_key').all() as { content_rev: number }[];
  assert.deepEqual(revs.map((r) => r.content_rev), [1, 2]);
});
