/**
 * Tier 7 clock, support-bundle and evidence-bundle tests: boot-anchored
 * clock sanity, the footprint stamp, the re-identification scan, the
 * dependency-free zip writer, raw_ref provenance against the cleanup
 * horizon, the store epoch, and the incident evidence bundle.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache, insertAnomalies, insertEvents } from '../db';
import type { DB } from '../db';
import type { Anomaly, UsageEvent } from '../types';
import { bootEpoch, clockSuspects, runClockStamp, footprintMetricName } from '../clock';
import { applyCaseIdentity } from '../triage/case';
import { localIdentifiers, reIdentificationScan, supportBundle, ensureStoreEpoch } from './support';
import { makeZip, classifyRawRefs, incidentBundle, incidentMarkdown, incidentPreviewFields } from './bundle';

let dir = '';
let db: DB;

function anomaly(over: Partial<Anomaly> & { anomaly_key: string; rule: Anomaly['rule'] }): Anomaly {
  return {
    severity: 'warn', tool: 'claude_code', session_id: 's1', model: 'claude-opus-5',
    window_start: 1000000, window_end: 1060000, title: 't', detail: 'd',
    observed: 10, baseline: 5, threshold: 9, confidence: 'exact', source: 'live',
    detected_at: 1100000, ...over,
  } as Anomaly;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vole-t7b-'));
  process.env.VOLE_DB = join(dir, 'vole.db');
  process.env.VOLE_HOME_OVERRIDE = dir;
  resetDbCache();
  db = openDb();
});

afterEach(() => {
  resetDbCache();
  delete process.env.VOLE_DB;
  delete process.env.VOLE_HOME_OVERRIDE;
  rmSync(dir, { recursive: true, force: true });
});

// ── clock ─────────────────────────────────────────────────────────────────────

test('bootEpoch: now/1000 - uptime, the boot-anchored pair', () => {
  assert.equal(bootEpoch(1788228000000, 1000), 1788227000);
  assert.equal(bootEpoch(1788227500000, 999.9), 1788226501); // fractional uptime floors
  const s = runClockStamp();
  assert.ok(s.boot_epoch === null || Number.isInteger(s.boot_epoch)); // NULL when the OS refuses uptime()
  assert.ok(s.rss_peak_bytes > 0);
  assert.ok(s.cpu_user_ms >= 0 && s.cpu_sys_ms >= 0);
  assert.match(footprintMetricName(), /rss_peak_bytes/); // the budget names its metric
});

test('clockSuspects: a shift under increasing uptime is a clock change; a reboot is not; wall going backwards is a rollback', () => {
  // Same boot, uptime 1000 -> 2000, but the wall clock moved +60s: a shift.
  const shift = clockSuspects([
    { id: 1, started_at: 1788000000000, wall_ms: 1788000000000, boot_epoch: 1787000000 },
    { id: 2, started_at: 1788000060000, wall_ms: 1788000120000, boot_epoch: 1787000060 },
  ]);
  assert.equal(shift.length, 1);
  assert.equal(shift[0]!.kind, 'boot_epoch_shift');
  assert.equal(shift[0]!.shift_s, 60);

  // A reboot: uptime RESETS, so the boot_epoch change is the boot, not the clock.
  const reboot = clockSuspects([
    { id: 1, started_at: 1788000000000, wall_ms: 1788000000000, boot_epoch: 1787000000 },
    { id: 2, started_at: 1789000000000, wall_ms: 1789000000000, boot_epoch: 1788999000 },
  ]);
  assert.equal(reboot.length, 0);

  // wall_ms going backwards between consecutive runs is a rollback.
  const rollback = clockSuspects([
    { id: 1, started_at: 1788000000000, wall_ms: 1788000000000, boot_epoch: 1787000000 },
    { id: 2, started_at: 1788000060000, wall_ms: 1787999990000, boot_epoch: 1787000000 },
  ]);
  assert.equal(rollback.length, 1);
  assert.equal(rollback[0]!.kind, 'wall_rollback');

  // NULL stamps (pre-migration rows) are skipped, never guessed as zero.
  assert.equal(clockSuspects([{ id: 1, started_at: 1, wall_ms: null, boot_epoch: null }]).length, 0);
});

// ── the re-identification scan ────────────────────────────────────────────────

test('the re-identification scan finds local identifiers and reports only the path', () => {
  const ids = ['shiva', 'Marys-MacBook-Pro.local'];
  const dirty = { note: 'shiva did it', nested: { host: 'Marys-MacBook-Pro.local' } };
  const hits = reIdentificationScan(dirty, ids);
  assert.equal(hits.length, 2);
  assert.ok(hits.every((h) => !JSON.stringify(h).includes('shiva') || h.path.length > 0));
  assert.equal(reIdentificationScan({ clean: 'nothing here' }, ids).length, 0);
  assert.ok(localIdentifiers(['needle']).includes('needle'));
});

// ── the zip writer ────────────────────────────────────────────────────────────

test('makeZip: a real, readable zip with deterministic bytes', () => {
  const files = [
    { name: 'a.json', data: Buffer.from('{"x":1}') },
    { name: 'b/nested.md', data: Buffer.from('# hi') },
  ];
  const zip = makeZip(files);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50); // EOCD
  const cdStart = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(cdStart > 0);
  assert.equal(zip.readUInt32LE(zip.length - 6), cdStart); // the EOCD names where the central directory really is
  assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304'); // local header sig
  assert.deepStrictEqual(makeZip(files), zip); // no timestamps: identical input, identical bytes
  const out = join(dir, 't.zip');
  writeFileSync(out, zip);
  const listing = execFileSync('unzip', ['-l', out], { encoding: 'utf8' }); // the OS reader is the oracle
  assert.match(listing, /a\.json/);
  assert.match(listing, /b\/nested\.md/);
  assert.equal(execFileSync('unzip', ['-t', out], { encoding: 'utf8' }).includes('OK'), true);
});

// ── raw_ref provenance ────────────────────────────────────────────────────────

test('raw refs: verifiable inside the horizon, expired outside or missing', () => {
  const fresh = join(dir, 'fresh.jsonl');
  const stale = join(dir, 'stale.jsonl');
  writeFileSync(fresh, 'x');
  writeFileSync(stale, 'x');
  const now = Date.now();
  const old = new Date(now - 40 * 86400000);
  const refs = classifyRawRefs([`${fresh}#123`, `${stale}#456`, `${join(dir, 'gone.jsonl')}#1`, null], 30, now);
  // the same file, read from a "now" 40 days past its mtime: outside the horizon
  const refs2 = classifyRawRefs([`${stale}#456`], 30, now + 40 * 86400000);
  assert.equal(refs.find((r) => r.raw_ref === `${fresh}#123`)!.verifiable, true);
  assert.equal(refs.find((r) => r.raw_ref === `${stale}#456`)!.verifiable, true); // mtime is fresh
  assert.equal(refs2[0]!.verifiable, false);
  assert.equal(refs.find((r) => r.raw_ref === `${join(dir, 'gone.jsonl')}#1`)!.verifiable, false);
  assert.equal(refs.length, 3); // null refs never enter the ledger
});

// ── store epoch ───────────────────────────────────────────────────────────────

test('store_epoch: written once; the second call returns the same epoch', () => {
  const ev: UsageEvent = {
    event_key: 'k1', tool: 'claude_code', model: null, session_id: 's', project: null,
    git_branch: null, ts: 1234, input_tokens: 1, output_tokens: 2, cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0, total_tokens: 3,
    cost_usd: null, confidence: 'exact', is_error: 0, stop_reason: null, source: 'live',
    raw_ref: '/f', tools: null, agent_id: null, context_window: null, duration_ms: null,
    duration_kind: null,
  };
  insertEvents(db, [ev]);
  const e1 = ensureStoreEpoch(db, '1.0.0');
  const e2 = ensureStoreEpoch(db, '1.0.1'); // a version bump never rewrites the epoch
  assert.equal(e1!.epoch_id, e2!.epoch_id);
  assert.equal(e1!.first_event_ts, 1234);
  assert.equal(e1!.prev_epoch_id, null); // NULL on a genuinely first install — the whole mechanism
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM store_epoch').get() as { n: number }).n, 1);
});

// ── the support bundle ────────────────────────────────────────────────────────

test('the support bundle carries the shape of the store, never its rows, and passes its own scan', () => {
  insertAnomalies(db, [anomaly({ anomaly_key: 'live:remote_execution:claude_code:tc-1', rule: 'remote_execution' })]);
  db.prepare(
    'INSERT INTO collector_runs (tool, started_at, duration_ms, files, parsed, inserted, source_state, ok) VALUES (?, ?, ?, 0, 0, 0, ?, 1)',
  ).run('claude_code', 1, 5, 'ok');
  const b = supportBundle(db) as { store: Record<string, unknown>; versions: Record<string, unknown> };
  const json = JSON.stringify(b);
  // No rows: the bundle never embeds an anomaly or usage row.
  assert.equal(json.includes('remote_execution'), false);
  assert.match(JSON.stringify(b.store), /quick_check/);
  assert.ok(String(b.store.sqlite_schema_sha256).length === 64);
  // Migration 28 (DROP TABLE export_seq) frees a page on a fresh store: the
  // freelist is a fact about drops, not a leak — future writes reuse the page.
  assert.ok((b.store.freelist_count as number) <= 1, `freelist ${b.store.freelist_count}`);
  assert.equal(b.versions.node, process.version);
  // The self-check: no local identifiers anywhere in the bundle.
  assert.equal(reIdentificationScan(b, localIdentifiers()).length, 0);
});

// ── the incident evidence bundle ──────────────────────────────────────────────

test('the incident bundle: the figures that fired, window evidence, byte-offset provenance, custody', () => {
  insertAnomalies(db, [anomaly({ anomaly_key: 'live:remote_execution:claude_code:tc-1', rule: 'remote_execution', severity: 'critical' })]);
  applyCaseIdentity(db);
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, '{"a":1}\n');
  db.prepare(
    `INSERT INTO tool_calls (tool_call_key, tool, name, shape, session_id, ts, status, authority, raw_ref, first_seen, last_seen)
     VALUES ('claude_code:tc-1', 'claude_code', 'Bash', 'bash <redacted>', 's1', 1020000, 'success', 'pre_authorised', ?, 1, 1)`,
  ).run(transcript);
  db.prepare(
    `INSERT INTO tool_calls (tool_call_key, tool, name, shape, session_id, ts, status, authority, raw_ref, first_seen, last_seen)
     VALUES ('claude_code:tc-2', 'claude_code', 'Read', 'read <redacted>', 's1', 1050000, 'success', 'no_record', ?, 1, 1)`,
  ).run(join(dir, 'gone.jsonl'));
  db.prepare(
    `INSERT INTO autonomy_intervals (session_id, agent_id, started_at, ended_at, calls, denied, errors)
     VALUES ('s1', NULL, 1000000, 1060000, 2, 0, 0)`,
  ).run();
  db.prepare(
    `INSERT INTO grants (grant_key, agent, source_file, kind, entry, granted_by, first_seen, last_seen) VALUES ('g1', 'claude_code', '/x', 'allow', 'Bash(*)', 'admin_policy', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO file_writes (write_key, tool_call_key, session_id, path, path_class, write_class, ts, first_seen, last_seen)
     VALUES ('w1', 'claude_code:tc-1', 's1', '/tmp/x', 'tmp', 'create', 1030000, 1, 1)`,
  ).run();

  const b = incidentBundle(db, 'live:remote_execution:claude_code:tc-1')!;
  assert.equal(b.anomaly.observed, 10);
  assert.equal(b.anomaly.baseline, 5);
  assert.equal(b.anomaly.threshold, 9);
  assert.equal(b.anomaly.case_key, 'live:remote_execution:claude_code:tc-1');
  assert.equal(b.window.tool_calls.length, 2);
  assert.equal(b.window.file_writes.length, 1);
  assert.equal(b.autonomy_intervals.length, 1);
  assert.equal((b.grants[0] as { granted_by: string }).granted_by, 'admin_policy');
  assert.equal((b.window.bounding_entries.first as { name: string }).name, 'Bash');
  assert.equal(b.raw_refs.find((r) => r.raw_ref === transcript)!.verifiable, true);
  assert.equal(b.raw_refs.find((r) => r.raw_ref === join(dir, 'gone.jsonl'))!.verifiable, false);
  assert.match(b.custody.sentence, /coverage statement, not an innocence statement/);
  assert.ok(b.manifest.columns.length > 10);
  assert.ok(incidentPreviewFields().some((f) => f.transform === 'dropped'));
  const md = incidentMarkdown(b);
  assert.match(md, /observed \*\*10\*\* \/ baseline 5 \/ threshold 9/);

  // Nothing in the bundle carries a local identifier.
  assert.equal(reIdentificationScan(b, localIdentifiers()).length, 0);
});

test('incidentBundle returns null for a key the store does not hold', () => {
  assert.equal(incidentBundle(db, 'live:nope:nada'), null);
});
