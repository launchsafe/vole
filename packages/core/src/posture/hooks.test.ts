import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vole-hooks-'));
  process.env.VOLE_DB = join(tmp, 'vole.db');
});

let dbMod: typeof import('../db');
const dbFor = async (name: string) => {
  dbMod ??= await import('../db');
  dbMod.resetDbCache();
  return dbMod.openDb(join(tmp, name));
};
const closeDb = () => dbMod!.resetDbCache();

test('hook_success.command is the display label, not the command — it is never hashed', async () => {
  const { hookRunsFromLine } = await import('./hooks');
  const runs = hookRunsFromLine({
    type: 'attachment',
    attachment: {
      type: 'hook_success', hookName: 'SessionStart:startup',
      command: 'Loading ponytail mode...', exitCode: 0, durationMs: 108,
    },
  });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.command_sha, null);
  assert.equal(runs[0]!.hook_event, 'SessionStart');
});

test('stop_hook_summary carries the real command: hash and first-seen discipline', async () => {
  const { hookRunsFromLine, recordHookRuns } = await import('./hooks');
  const { openDb } = await import('../db');
  const db = await dbFor('a.db');
  const now = Date.parse('2026-09-07T00:00:00Z');
  const file = join(tmp, 's1.jsonl');
  const ev = { session: 's1', file, ts: now, line: {} as Record<string, unknown> };
  void ev;
  const fromCommand = (cmd: string) => ({
    ...ev,
    line: { type: 'system', subtype: 'stop_hook_summary', hookInfos: [{ command: cmd, hookEvent: 'Stop' }] },
  });
  const h = (cmd: string) => hookRunsFromLine(fromCommand(cmd).line);
  const sh = (cmd: string) => createHash('sha256').update(cmd).digest('hex');
  // One file flush: both commands hashed.
  assert.equal(recordHookRuns(db, file, [...h('/bin/notify original.sh'), ...h('/bin/notify REPLACED.sh')], now), 2);
  // The same file re-read unchanged: a no-op on the counter, one row per hash.
  assert.equal(recordHookRuns(db, file, h('/bin/notify original.sh'), now + 1), 1);
  const rows = db.prepare('SELECT command_hash, first_seen, last_seen FROM hook_ledger ORDER BY first_seen').all() as { command_hash: string; first_seen: number; last_seen: number }[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.command_hash, sh('/bin/notify original.sh'));
  assert.equal(rows[0]!.first_seen, now);
  assert.equal(rows[1]!.command_hash, sh('/bin/notify REPLACED.sh'));
  const executions = db.prepare("SELECT counter FROM surface_activity WHERE counter_kind = 'executions'").get() as { counter: number };
  assert.equal(executions.counter, 2); // per-file absolute with MAX: the 2-run flush set it, the 1-run re-read did not shrink it
  closeDb();
});
