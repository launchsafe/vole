import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './sqlite';
import { SCHEMA } from './schema';
import { insertEvents, insertAnomalies, openDb, openDbReadOnly, resetDbCache, schemaInfo, MIGRATIONS } from './db';
import type { Anomaly, UsageEvent } from './types';

function ev(over: Partial<UsageEvent>): UsageEvent {
  return {
    event_key: 'k1', tool: 'claude_code', model: 'claude-opus-5', session_id: 's',
    project: null, git_branch: null, ts: Date.parse('2026-01-01T00:00:00Z'),
    input_tokens: 5, output_tokens: 10, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0,
    cache_read_tokens: 0, reasoning_tokens: 0, total_tokens: 15, cost_usd: null,
    confidence: 'exact', is_error: 0, stop_reason: null, source: 'live', raw_ref: '/f',
    tools: null, agent_id: null, context_window: null,
      duration_ms: null, duration_kind: null,
    ...over,
  };
}

function store() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'vole-db-')), 't.db'));
  db.exec(SCHEMA);
  return db;
}

function row(db: Database): Record<string, unknown> {
  return db.prepare('SELECT * FROM usage_events WHERE event_key = ?').get('k1') as Record<string, unknown>;
}

test('upsert: a strictly greater copy upgrades the row', () => {
  const db = store();
  insertEvents(db, [ev({ output_tokens: 10, total_tokens: 15 })]);
  assert.equal(insertEvents(db, [ev({ output_tokens: 20, total_tokens: 25 })]), 1);
  assert.equal(row(db).total_tokens, 25);
});

test('upsert: re-reading identical data is a no-op', () => {
  const db = store();
  insertEvents(db, [ev({})]);
  assert.equal(insertEvents(db, [ev({})]), 0);
});

test('B5: an equal-token copy heals a stored tools NULL', () => {
  // Sibling content-block copies carry identical totals, so the token guard can
  // never reach them; without the NULL-widening clause the row stays NULL forever.
  const db = store();
  insertEvents(db, [ev({ tools: null })]);
  assert.equal(insertEvents(db, [ev({ tools: 'Bash' })]), 1, 'the healing copy must count as a change');
  assert.equal(row(db).tools, 'Bash');
});

test('B5: an equal-token copy never overwrites a stored tools value', () => {
  const db = store();
  insertEvents(db, [ev({ tools: 'Bash,Read' })]);
  assert.equal(insertEvents(db, [ev({ tools: 'Bash' })]), 0, 'no change, no rewrite');
  assert.equal(row(db).tools, 'Bash,Read');
});

test('B5: the healing path leaves every other column untouched', () => {
  const db = store();
  insertEvents(db, [ev({ output_tokens: 10, total_tokens: 15, tools: null })]);
  // Equal tokens, healing tools only — output_tokens must keep its stored value.
  insertEvents(db, [ev({ output_tokens: 0, total_tokens: 15, tools: 'Grep' })]);
  const r = row(db);
  assert.equal(r.tools, 'Grep');
  assert.equal(r.output_tokens, 10, 'no column may regress on the healing path');
  assert.equal(r.total_tokens, 15);
});

function anom(over: Partial<Anomaly>): Anomaly {
  return {
    anomaly_key: 'billable_burn_spike:claude_code:m:s:1', rule: 'billable_burn_spike',
    severity: 'warn', tool: 'claude_code', session_id: 's', model: 'm',
    window_start: 1, window_end: 2, title: 't', detail: 'd',
    observed: 100, baseline: 10, threshold: 30, confidence: 'exact', source: 'live',
    detected_at: 1000,
    ...over,
  };
}

function anomRow(db: Database): Record<string, unknown> {
  return db.prepare('SELECT * FROM anomalies WHERE anomaly_key = ?').get('billable_burn_spike:claude_code:m:s:1') as Record<string, unknown>;
}

test('insertAnomalies: a first sighting inserts and reports it', () => {
  const db = store();
  const r = insertAnomalies(db, [anom({})]);
  assert.deepEqual([r.inserted.length, r.escalated.length], [1, 0]);
  assert.equal(anomRow(db).severity, 'warn');
});

test('insertAnomalies: an identical re-detection is a no-op (no rewrite, no notify)', () => {
  const db = store();
  insertAnomalies(db, [anom({})]);
  const r = insertAnomalies(db, [anom({})]);
  assert.deepEqual([r.inserted.length, r.escalated.length], [0, 0]);
});

test('escalation channel: a window that grew past the critical threshold escalates in place', () => {
  // The blocker shape: a window first seen at 3.1x (warn) while still open under
  // 5-second polling, ending at 8x — INSERT OR IGNORE froze it at warn forever.
  const db = store();
  insertAnomalies(db, [anom({ severity: 'warn', observed: 31 })]);
  const r = insertAnomalies(db, [anom({ severity: 'critical', observed: 80 })]);
  assert.deepEqual([r.inserted.length, r.escalated.length], [0, 1], 'escalation, not a new row');
  const row = anomRow(db);
  assert.equal(row.severity, 'critical');
  assert.equal(row.observed, 80);
  assert.equal(new Set([row.id]).size, 1, 'same row updated, not duplicated');
});

test('escalation channel: observed growth WITHOUT a severity rise updates but never re-notifies', () => {
  const db = store();
  insertAnomalies(db, [anom({ severity: 'warn', observed: 40 })]);
  const r = insertAnomalies(db, [anom({ severity: 'warn', observed: 60 })]);
  assert.deepEqual([r.inserted.length, r.escalated.length], [0, 0], 'growth alone is not an escalation');
  assert.equal(anomRow(db).observed, 60, 'the figures still upgrade');
});

test('escalation channel: a severity can never be downgraded', () => {
  const db = store();
  insertAnomalies(db, [anom({ severity: 'critical', observed: 50 })]);
  const r = insertAnomalies(db, [anom({ severity: 'warn', observed: 90 })]);
  assert.deepEqual([r.inserted.length, r.escalated.length], [0, 0]);
  const row = anomRow(db);
  assert.equal(row.severity, 'critical', 'severity only rises');
  assert.equal(row.observed, 90, 'observed still grows');
});

test('escalation channel: detected_at advances with an upgrade so watermarks see it', () => {
  const db = store();
  insertAnomalies(db, [anom({ severity: 'warn', observed: 31, detected_at: 1000 })]);
  insertAnomalies(db, [anom({ severity: 'critical', observed: 80, detected_at: 9000 })]);
  const row = anomRow(db) as { detected_at: number };
  assert.equal(row.detected_at, 9000);
});

test('schema_migrations: a fresh store is ledgered with real dates and no pre-ledger row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-mig-'));
  resetDbCache();
  const db = openDb(join(dir, 'fresh.db'));
  try {
    const info = schemaInfo(db);
    assert.ok(info.userVersion >= MIGRATIONS.length, `user_version is the head (${info.userVersion})`);
    assert.ok(!info.ledger.some((r) => r.name === 'pre-ledger'), 'a fresh store knows its history');
    for (const r of info.ledger) {
      assert.ok(r.applied_at !== null, `step ${r.version} has a real applied_at`);
    }
    // Every step appears exactly once, in order.
    assert.deepEqual(info.ledger.map((r) => r.version), MIGRATIONS.map((m) => m.version));
  } finally {
    resetDbCache();
  }
});

test('schema_migrations: a pre-ledger store gets the synthetic unknown row', () => {
  // Build a store the old way: SCHEMA only, user_version 0, no ledger.
  const dir = mkdtempSync(join(tmpdir(), 'vole-mig-old-'));
  const file = join(dir, 'old.db');
  const old = new Database(file);
  old.exec(SCHEMA);
  old.close();

  resetDbCache();
  const db = openDb(file);
  try {
    const info = schemaInfo(db);
    const pre = info.ledger.find((r) => r.version === 0);
    assert.ok(pre, 'the synthetic row exists');
    assert.equal(pre!.name, 'pre-ledger');
    assert.equal(pre!.applied_at, null, 'NULL renders as unknown, never a date');
    assert.ok(info.ledger.some((r) => r.version === MIGRATIONS.length!), 'the head step is applied');
  } finally {
    resetDbCache();
  }
});

test('schema_migrations: re-opening is a no-op — no duplicate ledger rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-mig-2-'));
  const file = join(dir, 't.db');
  resetDbCache();
  openDb(file);
  resetDbCache();
  const db = openDb(file);
  try {
    const info = schemaInfo(db);
    assert.equal(info.ledger.length, MIGRATIONS.length);
    assert.equal(info.userVersion, MIGRATIONS[MIGRATIONS.length - 1]!.version);
  } finally {
    resetDbCache();
  }
});

test('schema_migrations: an older writer REFUSES a newer store, and the version survives', () => {
  // A store written by a NEWER collector: user_version beyond our list. The old
  // behaviour was silent corruption — every column the old schema did not know
  // landed NULL, indistinguishable from "the source did not carry this field".
  const dir = mkdtempSync(join(tmpdir(), 'vole-mig-future-'));
  const file = join(dir, 'future.db');
  {
    const future = new Database(file);
    future.exec(SCHEMA);
    future.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, applied_at INTEGER, duration_ms INTEGER, rows_changed INTEGER)');
    future.exec(`PRAGMA user_version = ${MIGRATIONS.length + 5}`);
    future.prepare('INSERT INTO schema_migrations (version, name, kind, applied_at) VALUES (?, ?, ?, ?)').run(MIGRATIONS.length + 5, 'from-the-future', 'ddl', 1);
    future.close();
  }
  resetDbCache();
  assert.throws(
    () => openDb(file),
    /was written by schema/,
    'the writer must refuse loudly, not write NULLs into columns it does not know',
  );
  resetDbCache();
  // The store itself is untouched: version intact, readable by a reader that can.
  const check = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const v = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    assert.equal(v, MIGRATIONS.length + 5, 'the newer version survives the refusal');
  } finally {
    check.close();
  }
});

test('openDb sets busy_timeout (B8: two writers are tolerated, default 0 aborts)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-open-'));
  const file = join(dir, 't.db');
  resetDbCache();
  const db = openDb(file);
  try {
    const got = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    assert.equal(got.timeout, 5000);
  } finally {
    resetDbCache(); // closes the handle it owns
  }
});
