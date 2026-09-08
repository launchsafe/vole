import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from './sqlite';
import { makeStore, seedEvent } from './collectors/test-store';
import { runBackfill } from './backfill';

/** A fake ~/.codex/state_5.sqlite with the threads registry the step joins on. */
function stateDb(codexHome: string, rows: { id: string; rollout_path: string; git_branch: string | null }[]) {
  mkdirSync(codexHome, { recursive: true });
  const db = new Database(join(codexHome, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, git_branch TEXT, first_user_message TEXT)');
  for (const r of rows) db.prepare('INSERT INTO threads VALUES (?, ?, ?, NULL)').run(r.id, r.rollout_path, r.git_branch);
  db.close();
}

test('backfill: fills git_branch from the thread registry, bounded, resumable, unbackfillable counted', () => {
  const s = makeStore('backfill');
  try {
    const codexHome = join(s.home, '.codex');
    const rollout = join(s.home, 'rollout-a.jsonl');
    writeFileSync(rollout, '{}');
    stateDb(codexHome, [
      { id: 't1', rollout_path: rollout, git_branch: 'main' },
      { id: 't2', rollout_path: join(s.home, 'gone.jsonl'), git_branch: 'feature' }, // evidence exists, row may use it
    ]);
    // three NULL-branch codex rows; the third's rollout is in no registry row
    seedEvent(s.db, { event_key: 'e1', raw_ref: `${rollout}#0`, ts: 1000 });
    seedEvent(s.db, { event_key: 'e2', raw_ref: `${join(s.home, 'gone.jsonl')}#3`, ts: 2000 });
    seedEvent(s.db, { event_key: 'e3', raw_ref: `${join(s.home, 'unknown.jsonl')}#1`, ts: 3000 });

    const [r1] = runBackfill(s.db, 2, codexHome);
    assert.equal(r1!.name, 'codex-git-branch');
    assert.equal(r1!.rowsExamined, 2, 'the window is bounded by rows_per_pass');
    assert.equal(r1!.rowsChanged, 2, 'both rows in the registry gained their branch');
    assert.equal(r1!.done, false, 'a full window means more may remain');

    const [r2] = runBackfill(s.db, 2, codexHome);
    assert.equal(r2!.rowsExamined, 1, 'the cursor resumed past the first window');
    assert.equal(r2!.rowsChanged, 0, 'the third row has no registry evidence');
    assert.equal(r2!.unbackfillable, 1, 'and it is counted, not zeroed');

    const branches = s.db
      .prepare('SELECT event_key, git_branch FROM usage_events ORDER BY ts')
      .all() as { event_key: string; git_branch: string | null }[];
    assert.equal(branches[0]!.git_branch, 'main');
    assert.equal(branches[1]!.git_branch, 'feature');
    assert.equal(branches[2]!.git_branch, null, 'no evidence, no value — NULL is the only unknown');

    // A third pass with nothing pending advances nothing and reports done.
    const [r3] = runBackfill(s.db, 2, codexHome);
    assert.equal(r3!.rowsExamined, 0);
    assert.equal(r3!.done, true);
  } finally {
    s.done();
  }
});
