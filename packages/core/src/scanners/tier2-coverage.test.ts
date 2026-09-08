import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, chmodSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache, insertEvents } from '../db';
import type { DB } from '../db';
import type { UsageEvent } from '../types';
import {
  probeDir, probeFile, recordScanAccess, runProbePass, launchContext,
  recordColumnProvenance, buildId, dayBucket,
  type ProbeRoot,
} from './scan-access';
import {
  countEndpointLines, tailCounter, consoleBlindShare, isConsoleBlind,
  ghostAppResidues, storeStats, heartbeatSurfaces,
} from './coverage';
import { foreignRootCheck } from './tier2-extras';
import { renderAssessment, loadConsoleCoverage, type ConsoleCoverageData } from '../cli/assess';

/** A throwaway store per test — migrations run, nothing touches the real ~/.vole. */
function store(): { db: DB; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vole-t2-'));
  process.env.VOLE_HOME_OVERRIDE = dir;
  resetDbCache();
  const db = openDb(join(dir, 't.db'));
  return { db, dir };
}

function teardown(s: { db: DB; dir: string }): void {
  resetDbCache();
  delete process.env.VOLE_HOME_OVERRIDE;
  try { rmSync(s.dir, { recursive: true, force: true }); } catch { /* chmod leftovers */ }
}

function ev(project: string | null): UsageEvent {
  return {
    event_key: `k:${project ?? 'null'}:${Math.random().toString(36).slice(2, 8)}`,
    tool: 'claude_code', model: 'claude-opus-5', session_id: 's', project,
    git_branch: null, ts: Date.parse('2026-01-01T00:00:00Z'),
    input_tokens: 5, output_tokens: 10, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0,
    cache_read_tokens: 0, reasoning_tokens: 0, total_tokens: 15, cost_usd: null,
    confidence: 'exact', is_error: 0, stop_reason: null, source: 'live', raw_ref: '/f',
    tools: null, agent_id: null, context_window: null, duration_ms: null, duration_kind: null,
  };
}

// ── the four-state probe ────────────────────────────────────────────────────────

test('probeDir: ok with entries, absent, exists (ENOTDIR), unreadable with errno', () => {
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  writeFileSync(join(dir, 'a'), 'x');
  writeFileSync(join(dir, 'b'), 'x');
  assert.deepEqual(probeDir(dir), { state: 'ok', errno: null, entries: 2 });
  assert.deepEqual(probeDir(join(dir, 'nope')), { state: 'absent', errno: null, entries: null });

  const asFile = probeDir(join(dir, 'a'));
  assert.equal(asFile.state, 'exists');
  assert.equal(asFile.errno, 'ENOTDIR');

  const locked = join(dir, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const denied = probeDir(locked);
    assert.equal(denied.state, 'unreadable');
    assert.ok(denied.errno); // the errno is the fact, never an inferred zero
  } finally {
    chmodSync(locked, 0o700);
  }

  const f = join(dir, 'some-file');
  writeFileSync(f, 'x');
  assert.equal(probeFile(f).state, 'ok');
  assert.equal(probeFile(join(dir, 'gone')).state, 'absent');
  chmodSync(f, 0o000);
  try {
    const deniedFile = probeFile(f);
    assert.equal(deniedFile.state, 'unreadable');
    assert.ok(deniedFile.errno);
  } finally {
    chmodSync(f, 0o644);
  }
  rmSync(dir, { recursive: true, force: true });
});

// ── scan_access upsert: last_ok history survives a later denial ──────────────────

test('recordScanAccess keeps last_ok_ts/entries through an ok→unreadable transition', () => {
  const s = store();
  const ctx = launchContext();
  recordScanAccess(s.db, '/tmp/root-x', ctx, { state: 'ok', errno: null, entries: 7 }, 1000);
  recordScanAccess(s.db, '/tmp/root-x', ctx, { state: 'unreadable', errno: 'EPERM', entries: null }, 2000);
  const row = s.db
    .prepare('SELECT state, errno, entries, last_ok_ts, last_ok_entries, last_result FROM scan_access WHERE root = ?')
    .get('/tmp/root-x') as Record<string, unknown>;
  assert.equal(row.state, 'unreadable');
  assert.equal(row.errno, 'EPERM');
  assert.equal(row.entries, null); // NULL unknown, never 0
  assert.equal(row.last_ok_ts, 1000);
  assert.equal(row.last_ok_entries, 7);
  assert.equal(row.last_result, 'unreadable:EPERM');
  teardown(s);
});

// ── coverage_degraded: ok→denied only, tiered severity, deterministic key ──────

test('runProbePass fires coverage_degraded on ok→unreadable (critical t1 / warn t2), never on ok→absent', () => {
  const s = store();
  const t1 = join(s.dir, 't1-root');
  const t2 = join(s.dir, 't2-root');
  const gone = join(s.dir, 'gone-root');
  for (const d of [t1, t2, gone]) mkdirSync(d);
  const roots: ProbeRoot[] = [
    { root: t1, tool: 'claude_code', label: 't1', tier: 1 },
    { root: t2, tool: 'claude_code', label: 't2', tier: 2 },
    { root: gone, tool: 'claude_code', label: 'gone', tier: 1 },
  ];
  assert.equal(runProbePass(s.db, roots, 1000).degraded, 0); // all readable: no incident

  chmodSync(t1, 0o000);
  chmodSync(t2, 0o000);
  rmSync(gone, { recursive: true }); // uninstalled is not degradation
  try {
    const now = 2_000_000_000_000;
    const { degraded } = runProbePass(s.db, roots, now);
    assert.equal(degraded, 2);
    const rows = s.db
      .prepare("SELECT anomaly_key, rule, severity, detail FROM anomalies WHERE rule = 'coverage_degraded'")
      .all() as { anomaly_key: string; rule: string; severity: string; detail: string }[];
    assert.equal(rows.length, 2);
    const sevByRoot = new Map(rows.map((r) => [r.anomaly_key.split(':')[1], r.severity]));
    assert.equal(sevByRoot.get(t1), 'critical');
    assert.equal(sevByRoot.get(t2), 'warn');
    for (const r of rows) {
      assert.ok(r.anomaly_key.endsWith(`:${buildId(s.db)}:${dayBucket(now)}`));
      assert.match(r.detail, /permission fact, not an absence fact/);
    }
    // Re-running the same pass does not stack incidents: only the transition fires.
    assert.equal(runProbePass(s.db, roots, now + 1).degraded, 0);
  } finally {
    chmodSync(t1, 0o700);
    chmodSync(t2, 0o700);
    teardown(s);
  }
});

// ── surface_activity: monotone counters with rotation reset ─────────────────────

test('countEndpointLines matches only endpoint-shaped lines', () => {
  const text = [
    'INFO boot ok',
    'POST /v1/messages x-api-key',
    'GET /health',
    'POST /v1/chat/completions http/1.1',
    'model=qwen3.8-27b loaded',
    'garbage POST /v1/messagesx should-not-match-suffix? actually /v1/messagesx does not match \\b boundary',
  ].join('\n');
  assert.equal(countEndpointLines(text), 3);
});

test('tailCounter: monotone growth, no double-count, rotation reset', () => {
  const s = store();
  const log = join(s.dir, 'gw.log');
  writeFileSync(log, 'POST /v1/messages one\n');
  const r1 = tailCounter(s.db, 'launchd:test', 'endpoint_lines', log, 1000, countEndpointLines);
  assert.deepEqual(r1, { added: 1, total: 1 });
  assert.equal(tailCounter(s.db, 'launchd:test', 'endpoint_lines', log, 1001, countEndpointLines)!.added, 0);

  appendFileSync(log, 'POST /v1/chat/completions two\n');
  const r2 = tailCounter(s.db, 'launchd:test', 'endpoint_lines', log, 2000, countEndpointLines);
  assert.deepEqual(r2, { added: 1, total: 2 }); // monotone: counter grew, never reset

  writeFileSync(log, 'POST /v1/messages rotated\n'); // smaller file: rotation
  const r3 = tailCounter(s.db, 'launchd:test', 'endpoint_lines', log, 3000, countEndpointLines);
  assert.equal(r3!.added, 1);
  assert.equal(r3!.total, 3);

  const row = s.db
    .prepare("SELECT counter, watermark FROM surface_activity WHERE surface_key = 'launchd:test'")
    .get() as { counter: number; watermark: number };
  assert.equal(row.counter, 3);
  assert.equal(row.watermark, Buffer.byteLength('POST /v1/messages rotated\n'));
  teardown(s);
});

// ── console-blind classification ─────────────────────────────────────────────────

test('isConsoleBlind / consoleBlindShare: unknown is null, never guessed', () => {
  assert.equal(isConsoleBlind('claude_code', 'qwen3.8-27b-fp8'), true);
  assert.equal(isConsoleBlind('claude_code', 'claude-opus-5'), false);
  assert.equal(isConsoleBlind('opencode', 'anything'), null); // no vendor shape: unknowable

  const s = store();
  insertEvents(s.db, [ev(null)]);
  s.db.prepare("UPDATE usage_events SET model = 'qwen3.8-27b-fp8' WHERE rowid = (SELECT MAX(rowid) FROM usage_events)").run();
  insertEvents(s.db, [ev(null)]);
  s.db.prepare("UPDATE usage_events SET model = 'claude-opus-5' WHERE rowid = (SELECT MAX(rowid) FROM usage_events)").run();
  const share = consoleBlindShare(s.db);
  assert.equal(share.length, 1);
  assert.equal(share[0]!.tool, 'claude_code');
  assert.equal(share[0]!.rows, 2);
  assert.equal(share[0]!.blind, 1);
  assert.equal(share[0]!.tokens, 30);
  assert.equal(share[0]!.blindTokens, 15);
  teardown(s);
});

// ── ghost-app detector: residue set-difference and dangling symlinks ────────────

test('ghostAppResidues: preference plist survives the app; dangling symlink counted', () => {
  const home = mkdtempSync(join(tmpdir(), 'ghost-'));
  const apps = join(home, 'Applications');
  mkdirSync(join(apps, 'Installed.app', 'Contents'), { recursive: true });
  writeFileSync(join(apps, 'Installed.app', 'Contents', 'Info.plist'),
    '<key>CFBundleIdentifier</key><string>com.anthropic.installed</string>');
  mkdirSync(join(home, 'Library', 'Preferences'), { recursive: true });
  const plist = join(home, 'Library', 'Preferences', 'com.anthropic.removed.plist');
  writeFileSync(plist, '<key>x</key><string>y</string>');

  const found = ghostAppResidues(home, [apps]);
  const residue = found.find((g) => g.bundleId === 'com.anthropic.removed');
  assert.ok(residue, 'residue bundle id is set-differenced against the installed census');
  assert.ok(residue!.lastWrite! > 0, 'plist mtime is the last preference write');
  assert.ok(!found.some((g) => g.bundleId === 'com.anthropic.installed'), 'installed apps are not ghosts');

  // A dangling symlink to a removed AI tool in a link farm.
  const bin = join(home, 'bin');
  mkdirSync(bin);
  symlinkSync(join(home, 'gone', 'claude-cli'), join(bin, 'claude'));
  const found2 = ghostAppResidues(home, [apps], [bin]);
  assert.ok(found2.some((g) => /dangling/.test(g.name) && /claude/.test(g.name)));
  rmSync(home, { recursive: true, force: true });
});

// ── second-tier store prober: counts, MB, last write — not bare existence ───────

test('storeStats reports session count, MB and last write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-'));
  for (let i = 0; i < 3; i++) {
    mkdirSync(join(dir, `sess_${i}`));
    writeFileSync(join(dir, `sess_${i}`, 'session.json'), 'x'.repeat(512 * 1024));
  }
  writeFileSync(join(dir, 'README'), 'noise');
  const stats = storeStats(dir, /^sess_/)!;
  assert.equal(stats.sessions, 3);
  assert.ok(stats.mb! > 0);
  assert.ok(stats.lastWrite! > 0);
  assert.equal(storeStats(join(dir, 'absent')), null); // absent store: no fact, not a zero
  rmSync(dir, { recursive: true, force: true });
});

// ── heartbeat: monotone per-pass surface counter ────────────────────────────────

test('heartbeatSurfaces ticks once per pass per surface', () => {
  const s = store();
  s.db.prepare(
    "INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, first_seen, last_seen) VALUES ('app:x', 'app', 'X', NULL, 'e', 1, 1)",
  ).run();
  heartbeatSurfaces(s.db, 1000);
  heartbeatSurfaces(s.db, 2000);
  const row = s.db
    .prepare("SELECT counter FROM surface_activity WHERE surface_key = 'app:x' AND counter_kind = 'heartbeat'")
    .get() as { counter: number };
  assert.equal(row.counter, 2);
  teardown(s);
});

// ── foreign_root_transcript: probe-routed, own rule literal ─────────────────────

test('foreignRootCheck: only truly absent cwds are foreign; unreadable dirs are not', () => {
  const s = store();
  const present = join(s.dir, 'present');
  const denied = join(s.dir, 'denied');
  const absent = join(s.dir, 'absent');
  mkdirSync(present);
  mkdirSync(denied);
  chmodSync(denied, 0o000);
  insertEvents(s.db, [ev(present), ev(denied), ev(absent)]);
  try {
    const n = foreignRootCheck(s.db, 1000);
    assert.equal(n, 1, 'an unreadable (existing) cwd must NOT be called foreign — existsSync is not the oracle here');
    const rows = s.db
      .prepare("SELECT rule, anomaly_key FROM anomalies WHERE rule = 'foreign_root_transcript'")
      .all() as { rule: string; anomaly_key: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.anomaly_key, `foreign_root:${absent}`);
    // Idempotent: re-running does not duplicate.
    assert.equal(foreignRootCheck(s.db, 2000), 1);
  } finally {
    chmodSync(denied, 0o700);
    teardown(s);
  }
});

// ── column_provenance: first_populated_ts is a stored fact, never re-derived ────

test('recordColumnProvenance writes once, then only refreshes the unbackfillable count', () => {
  const s = store();
  const cols = [{ table: 'scan_access', column: 'entries', migration: 20 }];
  recordColumnProvenance(s.db, 1000, cols);
  recordColumnProvenance(s.db, 9000, cols);
  const row = s.db
    .prepare("SELECT first_populated_ts, migration_version FROM column_provenance WHERE table_name = 'scan_access' AND column_name = 'entries'")
    .get() as { first_populated_ts: number; migration_version: number };
  assert.equal(row.first_populated_ts, 1000); // the later pass did not overwrite the fact
  assert.equal(row.migration_version, 20);
  teardown(s);
});

// ── the assess annex ────────────────────────────────────────────────────────────

const fakeCoverage: ConsoleCoverageData = {
  pack_version: 1,
  read_date: '2026-09-07',
  note: 'as documented, never "cannot"',
  categories: [{
    category: 'vendor_console',
    label: 'Vendor console',
    claims: [{
      vendor: 'Anthropic', url: 'https://docs.claude.com/en/api/administration/compliance', read_date: '2026-09-07',
      documented_coverage: ['first-party Claude Code traffic on workspace accounts'],
      documented_exclusions: ['API-key authenticated traffic', 'personal accounts'],
    }],
  }],
};

test('renderAssessment: local facts + dated claims + content boundary, no bare zeros', () => {
  const s = store();
  insertEvents(s.db, [ev(null)]);
  s.db.prepare("UPDATE usage_events SET model = 'qwen3.8-27b-fp8' WHERE rowid = (SELECT MAX(rowid) FROM usage_events)").run();
  const report = renderAssessment(s.db, fakeCoverage, Date.parse('2026-09-07T00:00:00Z'));
  assert.match(report, /console-blind \(claude_code\): 1 of 1 token-bearing rows \(100%\)/);
  assert.match(report, /Wedge annex/);
  assert.match(report, /as documented on 2026-09-07/);
  assert.match(report, /https:\/\/docs\.claude\.com/);
  assert.match(report, /excludes: API-key authenticated traffic/);
  assert.match(report, /non-empty/);
  assert.match(report, /vole verify --content/);
  teardown(s);
});

test('loadConsoleCoverage: the shipped pack parses and every claim carries url + read date', () => {
  const cov = loadConsoleCoverage();
  assert.ok(cov.pack_version >= 1);
  assert.ok(cov.read_date);
  for (const cat of cov.categories) {
    assert.ok(cat.claims.length);
    for (const c of cat.claims) {
      assert.match(c.url, /^https:\/\//);
      assert.match(c.read_date, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
});
