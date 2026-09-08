import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, resetDbCache, type DB } from '../db';
import { Database } from '../sqlite';
import {
  scanCodexThreadHistory, scanCopilotSessionStore, scanCursorTracking,
  scanAntigravityBrain, scanDevinAcpMessages, codexItemDirection,
} from './structured-sinks';
import { describeSinks, enumerateSinks, scanSink } from './sinks';
import { scanPermissionAllowlists, gitTrackedState } from './allowlist';

/**
 * Deep tier-4 coverage: structured readers, the sink registry's honest states,
 * and the allowlist escalation. All fixtures live under VOLE_HOME_OVERRIDE;
 * the fingerprint is injected so the Keychain is never touched.
 */

const AWS_KEY = 'AKIAZ9X8W7V6T5S4R3Q2';
const fakeFp = (v: string) => `fp-test:${v}`;
const NOW = Date.parse('2026-09-07T12:00:00Z');

let home: string;

function freshDb(): DB {
  resetDbCache();
  return openDb(join(mkdtempSync(join(tmpdir(), 'vole-ss-')), 'vole.db'));
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'vole-home-'));
  process.env.VOLE_HOME_OVERRIDE = home;
});

after(() => {
  delete process.env.VOLE_HOME_OVERRIDE;
  resetDbCache();
});

function openWritable(path: string): Database {
  mkdirSync(join(path, '..'), { recursive: true });
  return new Database(path);
}

test('codex thread_history: ordinal watermark, direction for free, idempotent re-scan', () => {
  const store = openWritable(join(home, '.codex', 'thread_history_1.sqlite'));
  store.exec(`CREATE TABLE thread_items (
    thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER,
    created_at_ms INTEGER, item_json TEXT, item_type TEXT, updated_at_ordinal INTEGER)`);
  const ins = store.prepare(
    'INSERT INTO thread_items (thread_id, item_id, item_json, item_type, updated_at_ordinal, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('t1', 'i1', JSON.stringify({ text: `run with ${AWS_KEY} please` }), 'userMessage', 1, NOW - 5000);
  ins.run('t1', 'i2', JSON.stringify({ text: 'plain reply' }), 'agentMessage', 2, NOW - 4000);
  ins.run('t2', 'i3', JSON.stringify({ text: `also ${AWS_KEY}` }), 'agentMessage', 1, NOW - 3000);
  store.close();

  const db = freshDb();
  const first = scanCodexThreadHistory(db, NOW, fakeFp);
  assert.equal(first.storePresent, true);
  assert.equal(first.rowsScanned, 3);

  const rows = db.prepare(
    'SELECT sink_key, direction, fingerprint, occurrences FROM secret_sightings ORDER BY sink_key, direction',
  ).all() as { sink_key: string; direction: string; fingerprint: string; occurrences: number }[];
  assert.equal(rows.length, 2, 'one sighting per (fingerprint, sink)');
  const user = rows.find((r) => r.sink_key === 'codex-thread-history:t1' && r.direction === 'human_pasted');
  const agent = rows.find((r) => r.sink_key === 'codex-thread-history:t2');
  assert.ok(user, 'userMessage rows carry direction with zero inference');
  assert.equal(agent!.direction, 'agent_typed');
  assert.equal(user!.fingerprint, fakeFp(AWS_KEY));

  // The watermark: a second pass reads nothing new and inflates nothing.
  const second = scanCodexThreadHistory(db, NOW + 1000, fakeFp);
  assert.equal(second.rowsScanned, 0);
  assert.equal(second.newSightings, 0);
  const after = db.prepare(
    'SELECT sink_key, occurrences FROM secret_sightings WHERE sink_key = ?',
  ).get('codex-thread-history:t1') as { occurrences: number };
  assert.equal(after.occurrences, 1, 'occurrences count transcript copies, not passes');

  const cursor = db.prepare(
    'SELECT cursor_int, cursor_kind FROM dlp_scan_state WHERE sink_key = ?',
  ).get('codex-thread-history:t1') as { cursor_int: number; cursor_kind: string };
  assert.equal(cursor.cursor_int, 2);
  assert.equal(cursor.cursor_kind, 'updated_at_ordinal');

  // Growing the thread: only the new ordinal is read.
  const store2 = openWritable(join(home, '.codex', 'thread_history_1.sqlite'));
  store2.prepare('INSERT INTO thread_items (thread_id, item_id, item_json, item_type, updated_at_ordinal, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .run('t1', 'i4', JSON.stringify({ text: 'later' }), 'userMessage', 5, NOW);
  store2.close();
  const third = scanCodexThreadHistory(db, NOW + 2000, fakeFp);
  assert.equal(third.rowsScanned, 1);
});

test('codexItemDirection: unknown types stay at_rest, never a guess', () => {
  assert.equal(codexItemDirection('userMessage'), 'human_pasted');
  assert.equal(codexItemDirection('webSearch'), 'agent_typed');
  assert.equal(codexItemDirection('somethingNew'), 'at_rest');
  assert.equal(codexItemDirection(null), 'at_rest');
});

test('codex thread_history absent store: recorded, not silently skipped', () => {
  const db = freshDb();
  const other = join(home, '.codex'); // no sqlite file there yet for this db's pass
  rmSync(join(other, 'thread_history_1.sqlite'), { force: true });
  const out = scanCodexThreadHistory(db, NOW, fakeFp);
  assert.equal(out.storePresent, false);
  const row = db.prepare('SELECT cursor_kind FROM dlp_scan_state WHERE sink_key = ?')
    .get('codex-thread-history') as { cursor_kind: string };
  assert.equal(row.cursor_kind, 'store_absent');
});

test('copilot session store: work_roots join, vendor_table tool_calls, directed sightings', () => {
  const cwd = join(home, 'work', 'repo-a');
  mkdirSync(cwd, { recursive: true });
  const storePath = join(home, 'Library', 'Application Support', 'Code', 'User',
    'globalStorage', 'github.copilot-chat', 'session-store.db');
  const store = openWritable(storePath);
  store.exec(`CREATE TABLE sessions (id TEXT, cwd TEXT, repository TEXT, host_type TEXT, branch TEXT, agent_name TEXT, created_at INTEGER, updated_at INTEGER)`);
  store.exec(`CREATE TABLE session_files (session_id TEXT, file_path TEXT, tool_name TEXT, turn_index INTEGER, first_seen_at INTEGER)`);
  store.exec(`CREATE TABLE turns (id TEXT, prompt TEXT, response TEXT)`);
  store.prepare('INSERT INTO sessions (id, cwd, repository) VALUES (?, ?, ?)').run('s1', cwd, 'https://github.com/acme/repo-a.git');
  store.prepare('INSERT INTO session_files (session_id, file_path, tool_name, turn_index, first_seen_at) VALUES (?, ?, ?, ?, ?)')
    .run('s1', 'src/app.ts', 'Edit', 0, 1754000000);
  store.prepare('INSERT INTO turns (prompt, response) VALUES (?, ?)')
    .run(`deploy with ${AWS_KEY}`, 'done');
  store.close();

  const db = freshDb();
  const out = scanCopilotSessionStore(db, NOW, fakeFp);
  assert.equal(out.storePresent, true);

  const root = db.prepare('SELECT root_path, origin_slug FROM work_roots WHERE root_path = ?')
    .get(cwd) as { root_path: string; origin_slug: string };
  assert.ok(root, 'sessions land in work_roots — the agent recorded its own repository');
  assert.equal(root.origin_slug, 'https://github.com/acme/repo-a.git');

  const call = db.prepare("SELECT tool, name, status_source FROM tool_calls WHERE tool_call_key LIKE 'copilot-session-files:%'")
    .get() as { tool: string; name: string; status_source: string };
  assert.ok(call, 'session_files is a free file-to-tool ledger');
  assert.equal(call.status_source, 'vendor_table');
  assert.equal(call.name, 'Edit');

  const sight = db.prepare("SELECT direction FROM secret_sightings WHERE sink_key = 'copilot-session-store'")
    .get() as { direction: string };
  assert.ok(sight, 'turns prompt column is scanned');
  assert.equal(sight.direction, 'human_pasted');

  // Idempotent: a second pass does not duplicate the ledger rows.
  scanCopilotSessionStore(db, NOW + 1000, fakeFp);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE tool_call_key LIKE 'copilot-session-files:%'")
    .get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM work_roots').get() as { n: number }).n, 1);
});

test('cursor tracking: content scanned, no model attribution, hashes counted', () => {
  const storePath = join(home, '.cursor', 'ai-tracking', 'ai-code-tracking.db');
  const store = openWritable(storePath);
  store.exec('CREATE TABLE tracked_file_content (id INTEGER PRIMARY KEY, fileName TEXT, content TEXT)');
  store.exec('CREATE TABLE ai_code_hashes (fileName TEXT, fileExtension TEXT, hash TEXT)');
  store.prepare('INSERT INTO tracked_file_content (fileName, content) VALUES (?, ?)')
    .run('src/creds.ts', `export const KEY = "${AWS_KEY}";`);
  store.prepare('INSERT INTO ai_code_hashes (fileName, fileExtension, hash) VALUES (?, ?, ?)')
    .run('src/app.ts', 'ts', 'abc123');
  store.close();

  const db = freshDb();
  const out = scanCursorTracking(db, NOW, fakeFp);
  assert.equal(out.storePresent, true);
  const sight = db.prepare("SELECT direction, provider FROM secret_sightings WHERE sink_key = 'cursor-tracking'")
    .get() as { direction: string; provider: unknown };
  assert.ok(sight, 'tracked_file_content is scanned');
  assert.equal(sight.direction, 'at_rest');
  assert.equal(sight.provider, null, 'no model attribution: provider stays NULL, never inferred');
  assert.ok(out.notes.some((n) => n.includes('ai_code_hashes')));
});

test('antigravity brain md and devin acp sqlite are scanned as no-attribution sinks', () => {
  const brain = join(home, '.gemini', 'antigravity-ide', 'brain', 'b1');
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, 'plan.md'), `plan: rotate ${AWS_KEY} today`);

  const devinDir = join(home, 'Library', 'Application Support', 'Devin', 'User', 'acp-messages');
  mkdirSync(devinDir, { recursive: true });
  const devin = openWritable(join(devinDir, 'thread-1.db'));
  devin.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT)');
  devin.prepare('INSERT INTO messages (body) VALUES (?)').run(`the key is ${AWS_KEY} ok`);
  devin.close();

  const db = freshDb();
  const ag = scanAntigravityBrain(db, NOW, fakeFp);
  assert.ok(ag.rowsScanned >= 1);
  const dv = scanDevinAcpMessages(db, NOW, fakeFp);
  assert.ok(dv.rowsScanned >= 1);
  assert.ok(db.prepare("SELECT 1 FROM secret_sightings WHERE sink_key LIKE 'antigravity-brain:%'").get());
  assert.ok(db.prepare("SELECT 1 FROM secret_sightings WHERE sink_key = 'devin-acp-messages'").get());
});

test('sink registry: prompt-logging flags, store-empty states, structured skips', () => {
  // gemini installed with NO settings.json: the documented default applies, stated not guessed.
  mkdirSync(join(home, '.gemini'), { recursive: true });
  const gooseLogs = join(home, '.local', 'state', 'goose', 'logs');
  mkdirSync(gooseLogs, { recursive: true });
  writeFileSync(join(gooseLogs, 'llm_request.2026-09-06.jsonl'), '{"prompt":"hi"}\n');

  const metas = describeSinks(NOW);
  const gemini = metas.find((m) => m.key === 'gemini-prompt-log-config');
  assert.ok(gemini, 'the gemini config sink is in the registry even when absent');
  assert.equal(gemini!.state, 'absent');
  assert.equal(gemini!.promptLoggingFlag, 'default_true_documented');

  const goose = metas.find((m) => m.key === 'goose-llm-request-logs');
  assert.equal(goose!.state, 'present');
  assert.equal(goose!.promptLoggingFlag, 'true');

  // An explicit opt-out is read, never assumed.
  writeFileSync(join(home, '.gemini', 'settings.json'), JSON.stringify({ telemetry: { logPrompts: false } }));
  assert.equal(describeSinks(NOW).find((m) => m.key === 'gemini-prompt-log-config')!.promptLoggingFlag, 'false');

  const cursor = metas.find((m) => m.key === 'cursor-tracking');
  assert.equal(cursor!.modelAttribution, 'none');
  assert.equal(cursor!.structured, true);

  // Age histogram + world-readable metadata on a tool-results spill sink.
  const spillDir = join(home, '.claude', 'projects', 'p-slug', 'sess-1', 'tool-results');
  mkdirSync(spillDir, { recursive: true });
  const f = join(spillDir, 'out.txt');
  writeFileSync(f, 'x');
  const old = NOW - 40 * 24 * 3600_000;
  utimesSync(f, new Date(old), new Date(old));
  const spill = describeSinks(NOW).find((m) => m.key.startsWith('claude-tool-results:'));
  assert.ok(spill, 'tool-results spill dirs are first-class sinks');
  assert.equal(spill!.fileCount, 1);
  assert.deepEqual(spill!.ageHistogram.find((b) => b.bucket === 'd30_90'), { bucket: 'd30_90', files: 1, bytes: 1 });
  assert.equal(typeof spill!.mode, 'string');

  // The raw byte scan skips structured sinks — no double counting.
  const structuredSink = enumerateSinks().find((s) => s.structured);
  assert.ok(structuredSink);
  const res = scanSink(structuredSink!, 1024);
  assert.equal(res.sightings.length, 0);
  assert.equal(res.bytesScanned, 0);
});

test('allowlist: a git-tracked inline command escalates to critical', () => {
  const repo = mkdtempSync(join(tmpdir(), 'vole-alw-'));
  const claudeDir = join(repo, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
    permissions: { allow: [`Bash(curl -H "Authorization: Bearer ${AWS_KEY}" https://x.example)`] },
  }));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'add', '.claude/settings.json']);

  assert.equal(gitTrackedState(join(claudeDir, 'settings.json')), 'tracked');
  const db = freshDb();
  process.env.VOLE_HOME_OVERRIDE = repo; // the allowlist targets read claudeConfigDir under home
  try {
    const res = scanPermissionAllowlists(db, [], NOW, fakeFp);
    assert.equal(res.rulesScanned, 1);
    assert.ok(res.newSightings >= 1, 'the inline command body is scanned');
    assert.equal(res.escalated, 1);
    const anom = db.prepare("SELECT rule, severity, detail FROM anomalies WHERE anomaly_key = ?")
      .get(`secret_at_rest:allowlist:${fakeFp(AWS_KEY)}`) as { rule: string; severity: string; detail: string } | undefined;
    assert.equal(anom!.rule, 'secret_at_rest');
    assert.equal(anom!.severity, 'critical');
    assert.ok(!anom!.detail.includes(AWS_KEY), 'the value is never in the incident text');
  } finally {
    process.env.VOLE_HOME_OVERRIDE = home;
    rmSync(repo, { recursive: true, force: true });
  }
});

test('allowlist: untracked and no-repo files never escalate', () => {
  const repo = mkdtempSync(join(tmpdir(), 'vole-alw2-'));
  mkdirSync(join(repo, '.claude'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: [`Bash(echo ${AWS_KEY})`] },
  }));
  const db = freshDb();
  process.env.VOLE_HOME_OVERRIDE = repo;
  try {
    const res = scanPermissionAllowlists(db, [], NOW, fakeFp);
    assert.equal(res.escalated, 0, 'no git repo: tracked_state NULL, never safe, never critical');
    assert.ok(res.newSightings >= 1, 'the sighting still lands');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM anomalies').get() as { n: number }).n, 0);
  } finally {
    process.env.VOLE_HOME_OVERRIDE = home;
    rmSync(repo, { recursive: true, force: true });
  }
});

test('allowlist: claude.json allowedTools and codex config.toml bodies are scanned', () => {
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    projects: { '/w/x': { allowedTools: [`Bash(echo ${AWS_KEY})`] } },
  }));
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), `command = "run ${AWS_KEY}"\n`);
  const db = freshDb();
  const res = scanPermissionAllowlists(db, [], NOW, fakeFp);
  const keys = (db.prepare('SELECT DISTINCT sink_key FROM secret_sightings WHERE sink_key LIKE ?')
    .all('allowlist:%') as { sink_key: string }[]).map((r) => r.sink_key);
  assert.ok(keys.some((k) => k.endsWith('.claude.json')), `claude.json scanned: ${keys}`);
  assert.ok(keys.some((k) => k.endsWith('config.toml')), `codex config scanned: ${keys}`);
  assert.equal(res.escalated, 0, 'neither file is in a git repo');
});
