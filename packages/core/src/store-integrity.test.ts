/**
 * Pins the five live-store integrity fixes:
 *  1. upsertSurface monotonicity (a regressing `now` never drags last_seen
 *     below first_seen);
 *  2. bounded scan_state.notes and ai_surfaces.extra (the content boundary's
 *     512-char / no-newline shape rule);
 *  3. the tool_use reconciliation by call id — replay duplication across
 *     forked session files, the lagging race, and the genuine-gap failure;
 *  4. migration 28: the dead export_seq table is dropped, the outbox is the
 *     change cursor;
 *  5. bundle redaction of home-dir paths and usernames at composition time,
 *     with the re-identification scan left strict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './sqlite';
import { SCHEMA } from './schema';
import { openDb, resetDbCache, recordScan, schemaInfo, boundNote } from './db';
import { upsertSurface } from './scanners/ai-surfaces';
import { reconcileClaudeToolCalls } from './toolcalls/reconcile';
import { localIdentifiers, reIdentificationScan, redactIdentifiers } from './cli/support';

function store(): Database {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'vole-si-')), 't.db'));
  db.exec(SCHEMA);
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_call_key TEXT NOT NULL UNIQUE, tool TEXT NOT NULL, name TEXT, shape TEXT,
      args_digest TEXT, session_id TEXT, agent_id TEXT, ts INTEGER NOT NULL,
      status TEXT, status_source TEXT, raw_ref TEXT,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL)`);
  return db;
}

// ── 1. ai_surfaces monotonicity ──────────────────────────────────────────────

test('upsertSurface: a regressing clock never moves last_seen below first_seen', () => {
  const db = store();
  db.exec(`CREATE TABLE IF NOT EXISTS ai_surfaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT, surface_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
    name TEXT NOT NULL, path TEXT, evidence TEXT NOT NULL, version TEXT, extra TEXT,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, sanctioned INTEGER,
    vendor TEXT, identifier TEXT, state TEXT, scanner TEXT, confidence TEXT,
    evidence_kind TEXT, discovery TEXT, account_class TEXT, class_evidence TEXT)`);
  const s = { surface_key: 'k', kind: 'cli' as const, name: 'x', path: null, evidence: 'e' };
  upsertSurface(db, s, 2000);
  // A later pass stamped from an old file mtime: the write must not regress.
  upsertSurface(db, s, 1000);
  const row = db.prepare('SELECT first_seen, last_seen FROM ai_surfaces WHERE surface_key = ?').get('k') as {
    first_seen: number; last_seen: number;
  };
  assert.equal(row.first_seen, 2000);
  assert.equal(row.last_seen, 2000); // MAX, not the regressed 1000
  upsertSurface(db, s, 3000);
  assert.equal((db.prepare('SELECT last_seen FROM ai_surfaces WHERE surface_key = ?').get('k') as { last_seen: number }).last_seen, 3000);
});

// ── 2. bounded notes and extra ────────────────────────────────────────────────

test('boundNote: long or multiline notes stay short, single-line and deterministic', () => {
  const short = '21 AI surfaces · 1 gateway(s)';
  assert.equal(boundNote(short), short);
  assert.equal(boundNote(null), null);
  const long = 'a'.repeat(1011);
  const bounded = boundNote(long)!
  assert.ok(bounded.length <= 512, `bounded length ${bounded.length}`);
  assert.ok(!bounded.includes('\n'));
  assert.equal(bounded, boundNote(long)); // deterministic — epochs still compare
  const multi = boundNote('line one\nline two')!;
  assert.ok(!multi.includes('\n'));
  assert.notEqual(multi, 'line one\nline two');
});

test('recordScan: an oversized note is stored bounded, never content-shaped', () => {
  const db = store();
  db.exec('CREATE TABLE IF NOT EXISTS scan_state (scanner TEXT PRIMARY KEY, cadence_ms INTEGER NOT NULL, last_started_at INTEGER, last_duration_ms INTEGER, ok INTEGER, notes TEXT)');
  recordScan(db, 'detection-rules', 0, 1, 1, true, 'rule_a,rule_b,'.repeat(60));
  const row = db.prepare("SELECT notes FROM scan_state WHERE scanner = 'detection-rules'").get() as { notes: string | null };
  assert.ok(row.notes!.length <= 512 && !row.notes!.includes('\n'));
});

test('upsertSurface: an oversized extra degrades to a digest stub, never verbatim', () => {
  const db = store();
  db.exec(`CREATE TABLE IF NOT EXISTS ai_surfaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT, surface_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
    name TEXT NOT NULL, path TEXT, evidence TEXT NOT NULL, version TEXT, extra TEXT,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, sanctioned INTEGER,
    vendor TEXT, identifier TEXT, state TEXT, scanner TEXT, confidence TEXT,
    evidence_kind TEXT, discovery TEXT, account_class TEXT, class_evidence TEXT)`);
  const bigExtra = JSON.stringify({ granted_permissions: { permissions: Array.from({ length: 60 }, (_, i) => `permission_number_${i}`) } });
  upsertSurface(db, { surface_key: 'k', kind: 'extension' as const, name: 'x', path: null, evidence: 'e', extra: bigExtra }, 1);
  const stored = db.prepare('SELECT extra FROM ai_surfaces WHERE surface_key = ?').get('k') as { extra: string | null };
  assert.ok(stored.extra!.length <= 512, `extra length ${stored.extra!.length}`);
  const stub = JSON.parse(stored.extra!) as { truncated: boolean; sha256: string };
  assert.equal(stub.truncated, true);
  assert.equal(stub.sha256.length, 16);
});

// ── 3. the tool_use reconciliation by call id ────────────────────────────────

function transcriptLine(id: string, name = 'Bash'): string {
  return JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', sessionId: 's', message: { id: `msg_${id}`, content: [{ type: 'tool_use', id, name, input: {} }] } });
}

test('reconcile: replay duplication is not a gap; lagging heals; real gaps and bogus rows fail', () => {
  const db = store();
  const dir = mkdtempSync(join(tmpdir(), 'vole-rec-'));
  const OLD = 1_000_000_000_000;
  const RUN = 2_000_000_000_000;
  const NEW = 3_000_000_000_000;

  // Original session: calls A, B. A forked file replays A (the double-count
  // hazard: same toolu id, two files).
  const f1 = join(dir, 'session.jsonl');
  writeFileSync(f1, `${transcriptLine('toolu_A')}\n${transcriptLine('toolu_B')}\n`);
  utimesSync(f1, new Date(OLD), new Date(OLD));
  const f2 = join(dir, 'fork.jsonl');
  writeFileSync(f2, `${transcriptLine('toolu_A')}\n`);
  utimesSync(f2, new Date(OLD), new Date(OLD));
  // Written after the last run: lagging, the next pass ingests it.
  const f3 = join(dir, 'live.jsonl');
  writeFileSync(f3, `${transcriptLine('toolu_L')}\n`);
  utimesSync(f3, new Date(NEW), new Date(NEW));
  // A real gap: predates the run, never ingested.
  const f4 = join(dir, 'gap.jsonl');
  writeFileSync(f4, `${transcriptLine('toolu_G')}\n`);
  utimesSync(f4, new Date(OLD), new Date(OLD));

  const ins = db.prepare(
    'INSERT INTO tool_calls (tool_call_key, tool, name, ts, raw_ref, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  ins.run('claude_code:toolu_A', 'claude_code', 'Bash', OLD, f1, OLD, OLD);
  ins.run('claude_code:toolu_B', 'claude_code', 'Bash', OLD, f1, OLD, OLD);
  // Bogus: the file exists but holds no such call.
  ins.run('claude_code:toolu_X', 'claude_code', 'Bash', OLD, f1, OLD, OLD);
  // Pruned: the source file is gone — reported, never failed.
  ins.run('claude_code:toolu_P', 'claude_code', 'Bash', OLD, join(dir, 'gone.jsonl'), OLD, OLD);
  db.prepare('INSERT INTO collector_runs (tool, started_at, duration_ms, files, parsed, inserted, source_state, ok) VALUES (?, ?, 0, 1, 0, 0, ?, 1)')
    .run('claude_code', RUN, 'ok');

  const r = reconcileClaudeToolCalls(db, dir);
  assert.equal(r.distinctCalls, 4); // A, B, L, G
  assert.equal(r.replayedOccurrences, 1); // A's replay
  assert.equal(r.lagging, 1); // L: written after the run
  assert.equal(r.missing, 1); // G: predates the run, no row
  assert.equal(r.bogus, 1); // X
  assert.equal(r.pruned, 1); // P
  assert.equal(r.ok, false);

  // Heal the gap and the bogus row: only replay/pruned/lagging remain — ok.
  ins.run('claude_code:toolu_G', 'claude_code', 'Bash', OLD, f4, OLD, OLD);
  db.prepare('DELETE FROM tool_calls WHERE tool_call_key = ?').run('claude_code:toolu_X');
  const healed = reconcileClaudeToolCalls(db, dir);
  assert.equal(healed.missing, 0);
  assert.equal(healed.bogus, 0);
  assert.equal(healed.ok, true);
});

// ── 4. migration 28: export_seq dropped, the outbox is the cursor ────────────

test('migration 28: a fresh store has no export_seq and reports schema 28', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-mig28-'));
  const file = join(dir, 'vole.db');
  const db = openDb(file);
  const info = schemaInfo(db);
  assert.equal(info.userVersion, 28);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'export_seq'").get() as { n: number }).n,
    0,
  );
  // The outbox table — the real change cursor — exists.
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'export_outbox'").get() as { n: number }).n,
    1,
  );
  resetDbCache();
});

test('migration 28: a schema-27 store migrates and drops the dead table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-mig27-'));
  const file = join(dir, 'vole.db');
  const db = new Database(file);
  db.exec(SCHEMA);
  db.exec(`CREATE TABLE export_seq (
    id INTEGER PRIMARY KEY AUTOINCREMENT, exported_at INTEGER NOT NULL,
    last_anomaly_id INTEGER NOT NULL DEFAULT 0, last_event_ts INTEGER NOT NULL DEFAULT 0)`);
  db.exec('PRAGMA user_version = 27');
  db.close();
  const migrated = openDb(file);
  assert.equal(
    (migrated.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'export_seq'").get() as { n: number }).n,
    0,
  );
  assert.ok(existsSync(file));
  resetDbCache();
});

// ── 5. bundle redaction ───────────────────────────────────────────────────────

test('redactIdentifiers: home paths and usernames never ride, and the scan passes after', () => {
  const ids = localIdentifiers();
  assert.ok(ids.length > 0, 'the scan has at least the OS username to work with');
  const home = process.env.HOME ?? '';
  const payload = {
    anomaly_key: `stuck_tool_call:unbound:codex:${home}/.codex/sessions/x.jsonl:100`,
    shape: `SP=${home}/-Users-${ids[0]}-Developer/scratchpad`,
    nested: [{ v: `${ids[0]} typed this` }],
    n: 5,
    keep: null,
  };
  const redacted = redactIdentifiers(payload, ids) as typeof payload;
  const hits = reIdentificationScan(redacted, ids);
  assert.deepEqual(hits, []);
  assert.ok(!JSON.stringify(redacted).includes(home));
  // Deterministic: the same source redacts to the same value (sync dedupe keys).
  assert.deepEqual(redacted, redactIdentifiers(payload, ids) as typeof payload);
  // Unredacted, the same payload fails the scan — the gate stays strict.
  assert.ok(reIdentificationScan(payload, ids).length > 0);
});
