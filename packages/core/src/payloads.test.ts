import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, resetDbCache } from './db';
import { Database } from './sqlite';
import {
  base64DecodedLength, classifyOrigin, collectClaudePayloads, collectOpencodePayloads,
} from './payloads';

/**
 * The opaque-payload ledger: bytes counted, never decoded; on-disk and
 * at-wire bytes apart; origin classified from the tool_use_id join.
 */

const NOW = Date.parse('2026-09-07T12:00:00Z');
const B64 = Buffer.from('hello world').toString('base64'); // 11 bytes
const BIG_B64 = Buffer.from('a'.repeat(300)).toString('base64');

let home: string;

function freshDb() {
  resetDbCache();
  return openDb(join(mkdtempSync(join(tmpdir(), 'vole-pl-')), 'vole.db'));
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'vole-pl-home-'));
  process.env.VOLE_HOME_OVERRIDE = home;
});

after(() => {
  delete process.env.VOLE_HOME_OVERRIDE;
  resetDbCache();
});

test('base64 length arithmetic: exact decoded bytes, padding aware', () => {
  assert.equal(base64DecodedLength(B64), 11);
  assert.equal(base64DecodedLength(Buffer.from('abcd').toString('base64')), 4); // no padding needed
  assert.equal(base64DecodedLength(BIG_B64), 300);
  assert.equal(base64DecodedLength('QUJD'), 3);
});

test('origin classification: screenshot vs repo asset vs outside vs unresolved', () => {
  const repo = mkdtempSync(join(tmpdir(), 'vole-repo-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  writeFileSync(join(repo, 'asset.png'), 'png');
  execFileSync('git', ['-C', repo, 'add', 'asset.png']);

  assert.equal(classifyOrigin(join(repo, 'asset.png'), [repo]), 'repo_asset');
  assert.equal(classifyOrigin('/var/folders/ab/T/Screen Shot 2026-01-01.png', [repo]), 'screen_capture');
  assert.equal(classifyOrigin('/other/dir/img.png', [repo]), 'outside_work_roots');
  assert.equal(classifyOrigin(null, [repo]), 'unresolved');
  // Under a root but not in the index: no class fits better than unresolved.
  writeFileSync(join(repo, 'untracked.png'), 'png');
  assert.equal(classifyOrigin(join(repo, 'untracked.png'), [repo]), 'unresolved');
});

test('claude transcripts: all four parse sites, bytes kept apart, idempotent', () => {
  const repo = mkdtempSync(join(tmpdir(), 'vorepo-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  writeFileSync(join(repo, 'asset.png'), 'png');
  execFileSync('git', ['-C', repo, 'add', 'asset.png']);

  const sessDir = join(home, '.claude', 'projects', 'p-slug');
  mkdirSync(sessDir, { recursive: true });
  const lines = [
    // The Read that puts a file path in the tool_use map.
    { type: 'assistant', sessionId: 'sess-1', message: { id: 'msg-1', content: [
      { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: join(repo, 'asset.png') } },
    ] } },
    { type: 'assistant', sessionId: 'sess-1', message: { id: 'msg-2', content: [
      { type: 'tool_use', id: 'tu-2', name: 'Read', input: { file_path: '/var/folders/ab/T/Screen Shot.png' } },
    ] } },
    // Image nested in tool_result.content[] — origin resolved via the tool_use join.
    { type: 'user', sessionId: 'sess-1', message: { id: 'msg-3', content: [
      { type: 'tool_result', tool_use_id: 'tu-1', content: [
        { type: 'image', source: { media_type: 'image/png', data: B64 } },
      ] },
    ] } },
    { type: 'user', sessionId: 'sess-1', message: { id: 'msg-4', content: [
      { type: 'tool_result', tool_use_id: 'tu-2', content: [
        { type: 'image', source: { media_type: 'image/png', data: B64 } },
      ] },
    ] } },
    // An image directly in a human turn.
    { type: 'user', sessionId: 'sess-1', message: { id: 'msg-5', content: [
      { type: 'image', source: { media_type: 'image/jpeg', data: B64 } },
    ] } },
    // toolUseResult.file: an image the agent read off disk itself.
    { type: 'user', sessionId: 'sess-1', message: { id: 'msg-6', content: [
      { type: 'tool_result', tool_use_id: 'tu-1' },
    ] }, toolUseResult: { file: { base64: BIG_B64, originalSize: 300, type: 'image/png' } } },
    // toolUseResult.persistedOutputPath: Bash output too large for context.
    { type: 'user', sessionId: 'sess-1', message: { id: 'msg-7', content: [] },
      toolUseResult: { persistedOutputPath: '/tmp/x.txt', persistedOutputSize: 4096 } },
  ];
  writeFileSync(join(sessDir, 'sess-1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const db = freshDb();
  const n = collectClaudePayloads(db, [repo], NOW);
  assert.equal(n, 5, 'all parse sites: 2 tool_result images, 1 human-turn image, 1 file read, 1 spill');

  const byKey = (kind: string) => db.prepare('SELECT * FROM payload_sightings WHERE kind = ?').all(kind) as Record<string, unknown>[];
  const human = byKey('image_human_turn');
  assert.equal(human.length, 1);
  assert.equal(human[0]!.bytes_received, 11);
  assert.equal(human[0]!.bytes_on_disk, null, 'a pasted image has no on-disk size: NULL, never 0');
  assert.equal(human[0]!.scannable, 0);

  const tr = byKey('image_tool_result');
  assert.equal(tr.length, 2);
  const fromRepo = tr.find((r) => r.context_class === 'repo_asset');
  const fromScreen = tr.find((r) => r.context_class === 'screen_capture');
  assert.ok(fromRepo, 'tool_use_id join resolves the Read origin');
  assert.ok(fromScreen, 'screenshot naming pattern classifies the origin');
  assert.equal(fromRepo!.bytes_on_disk, 3, "the statSync size, exact ('png' is 3 bytes)");

  const fileImg = byKey('read_file_image');
  assert.equal(fileImg.length, 1);
  assert.equal(fileImg[0]!.bytes_on_disk, 300);
  assert.equal(fileImg[0]!.bytes_received, 300);

  const spill = byKey('persisted_output');
  assert.equal(spill.length, 1);
  assert.equal(spill[0]!.bytes_on_disk, 4096);
  assert.equal(spill[0]!.scannable, 1, 'spilled tool output is text: scannable');
  assert.equal(spill[0]!.context_class, null);

  // Idempotent: streaming rewrites of the same message id are the same key.
  writeFileSync(join(sessDir, 'sess-1.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n' + JSON.stringify(lines[4]) + '\n');
  collectClaudePayloads(db, [repo], NOW + 1000);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM payload_sightings').get() as { n: number }).n, 5);
});

test('opencode attachments: filename verbatim, origin classified', () => {
  const repo = mkdtempSync(join(tmpdir(), 'vorepo2-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  writeFileSync(join(repo, 'shot.png'), 'png');
  execFileSync('git', ['-C', repo, 'add', 'shot.png']);

  const dbPath = join(home, '.local', 'share', 'opencode', 'opencode.db');
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const src = new Database(dbPath);
  src.exec('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, data TEXT)');
  src.prepare('INSERT INTO part (id, session_id, data) VALUES (?, ?, ?)').run(
    'prt-1', 'op-sess',
    JSON.stringify({ type: 'file', file: { mime: 'image/png', filename: join(repo, 'shot.png'), data: B64 } }));
  src.close();

  const db = freshDb();
  const n = collectOpencodePayloads(db, [repo], NOW);
  assert.equal(n, 1);
  const row = db.prepare('SELECT * FROM payload_sightings WHERE sighting_key = ?').get('opencode:prt-1') as Record<string, unknown>;
  assert.equal(row.kind, 'file_attachment');
  assert.equal(row.media_type, 'image/png');
  assert.equal(row.bytes_on_disk, 3);
  assert.equal(row.bytes_received, 11);
  assert.equal(row.context_class, 'repo_asset');
  assert.equal(row.scannable, 0);
});
