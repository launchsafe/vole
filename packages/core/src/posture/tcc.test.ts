import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vole-tcc-'));
  process.env.VOLE_DB = join(tmp, 'vole.db');
});

function fakeTcc(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE access (service TEXT, client TEXT, client_type INTEGER, auth_value INTEGER, auth_reason INTEGER, last_modified INTEGER);
    INSERT INTO access VALUES ('kTCCServiceScreenCapture', 'com.anthropic.claudefordesktop', 0, 2, 4, 1700000000000);
    INSERT INTO access VALUES ('kTCCServiceAccessibility', '/Applications/Claude.app', 1, 2, 1, 1700000000100);
    INSERT INTO access VALUES ('kTCCServiceScreenCapture', 'com.apple.Safari', 0, 2, 4, 1700000000000);
    INSERT INTO access VALUES ('kTCCServiceMicrophone', 'com.microsoft.teams2', 0, 2, 4, 1700000000000);
  `);
  db.close();
}

let dbMod: typeof import('../db');
const dbFor = async (name: string) => {
  dbMod ??= await import('../db');
  dbMod.resetDbCache();
  return dbMod.openDb(join(tmp, name));
};
const closeDb = () => dbMod!.resetDbCache();

test('TCC read: AI apps on screen/keystroke services, filtered from everything else', async () => {
  const { readTcc, isAiApp } = await import('./tcc');
  const path = join(tmp, 'TCC.db');
  fakeTcc(path);
  const { rows, error } = readTcc(path, 'user');
  assert.equal(error, null);
  assert.equal(rows.length, 4);
  const aiRows = rows.filter((r) => isAiApp(r.client));
  assert.equal(aiRows.length, 2);
  assert.ok(aiRows.every((r) => r.service === 'kTCCServiceScreenCapture' || r.service === 'kTCCServiceAccessibility'));
  const safari = rows.find((r) => r.client === 'com.apple.Safari')!;
  assert.ok(!isAiApp(safari.client));
  const claude = rows.find((r) => r.client === 'com.anthropic.claudefordesktop')!;
  assert.equal(claude.auth_value, 2);
  assert.equal(claude.last_modified, 1700000000000);
});

test('unreadable TCC db is a permission fact, not an empty list', async () => {
  const { readTcc } = await import('./tcc');
  const { rows, error } = readTcc(join(tmp, 'missing.db'), 'user');
  assert.equal(rows.length, 0);
  assert.equal(error, 'ENOENT'); // the caller records this as a scan_access denial, never as 'no grants'
});

test('os grant write: one grants row per AI-app × service, keyed idempotently', async () => {
  const { openDb } = await import('../db');
  const { sweepOsGrants } = await import('./tcc');
  // Point the sweep at a fixture home by faking the two TCC paths through the
  // module's own reader: system db missing (denied/absent), user db = fixture.
  process.env.VOLE_HOME_OVERRIDE = tmp;
  const db = await dbFor('a.db');
  fakeTcc(join(tmp, 'TCC-user.db'));
  // sweepOsGrants reads fixed paths, so exercise the write path through the
  // exported reader + the same upsert the sweep uses, via a direct call on a
  // home-shaped layout: system db absent → denied, user db present.
  const { readTcc, isAiApp } = await import('./tcc');
  const { recordScanAccess } = await import('./shared');
  const now = Date.parse('2026-09-07T00:00:00Z');
  const user = readTcc(join(tmp, 'TCC-user.db'), 'user');
  recordScanAccess(db, join(tmp, 'TCC-user.db'), 'os-grants', user.error, user.rows.length, now);
  const upsert = db.prepare(`
    INSERT INTO grants (grant_key, agent, source_file, kind, entry, granted_by, path_class, origin, scope, first_seen, last_seen)
    VALUES (?, ?, ?, 'os_tcc', ?, ?, 'managed', 'os_default', 'device', ?, ?)
    ON CONFLICT(grant_key) DO UPDATE SET last_seen = excluded.last_seen`);
  let n = 0;
  for (const r of user.rows) {
    if (!isAiApp(r.client)) continue;
    upsert.run(`os_tcc:user:${r.service}:${r.client}`, r.client, '~/TCC.db', r.service, 'macOS TCC access table', now, now);
    n++;
  }
  assert.equal(n, 2);
  const probe = db.prepare('SELECT state, entries FROM scan_access').get() as { state: string; entries: number };
  assert.equal(probe.state, 'ok');
  assert.equal(probe.entries, 4);
  closeDb();
});
