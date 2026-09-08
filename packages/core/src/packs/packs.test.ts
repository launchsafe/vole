/**
 * Tier 6 pack-plane tests: signature verification and refusal, builtin floor,
 * managed precedence, pricing pack, content_rev re-scoring, suppression
 * register accounting, content_stale aging keys, comparability gate,
 * baseline drift, preflight scoring.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, insertEvents, insertAnomalies } from '../db';
import type { DB } from '../db';
import type { Anomaly, UsageEvent } from '../types';
import { registerPacks, activePack, readLoadState } from './registry';
import { resolvePricing } from './pricing-pack';
import { applySuppressionPack, activeSuppressions, recordSuppressed, suppressReported, splitModes } from './suppression';
import { insertAnomaliesWithRev, requeueOnBump, reReviewQueue, carryOverLabels, stampContentRev } from './rescore';
import { contentStaleRows, staleFloors } from './policy';
import { comparabilityGate, BUILTIN_INDICATORS } from './comparability';
import { captureBaseline, driftDiff } from './baseline';
import { provenanceFor, controlsForRule } from './controls';
import { preflightPack } from './preflight';

const HOME = mkdtempSync(join(tmpdir(), 'vole-packs-'));
const MANAGED = join(HOME, 'managed-packs');
const USER = join(HOME, '.vole', 'packs');
const DBFILE = join(HOME, 'vole.db');

// Two trust anchors, generated per test run: the registry reads them from env.
const vendor = generateKeyPairSync('ed25519');
const admin = generateKeyPairSync('ed25519');
const spki = (k: { publicKey: KeyObject }) => k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

const envBefore = { ...process.env };

before(() => {
  process.env.VOLE_HOME_OVERRIDE = HOME;
  process.env.VOLE_PRICING = join(HOME, '.vole', 'pricing.json');
  process.env.VOLE_BASELINE = join(HOME, '.vole', 'baseline.json');
  process.env.VOLE_PACK_VENDOR_PUBKEY = spki(vendor);
  process.env.VOLE_PACK_ADMIN_PUBKEY = spki(admin);
  mkdirSync(MANAGED, { recursive: true });
  mkdirSync(USER, { recursive: true });
});

after(() => {
  process.env = envBefore;
});

function db(): DB {
  return openDb(DBFILE);
}

const dirs: [string, string] = [MANAGED, USER];
const sync = (d: DB) => registerPacks(d, NOW, dirs);

/** Write a pack file; sign it (vendor/admin), tamper it, or leave it unsigned. */
function writePack(dir: string, name: string, manifest: unknown, key?: { privateKey: KeyObject } | 'tamper' | 'none'): string {
  const file = join(dir, name);
  const bytes = Buffer.from(JSON.stringify(manifest));
  writeFileSync(file, bytes);
  if (key === 'none') return file;
  const sig =
    key === 'tamper' || !key
      ? edSign(null, Buffer.from('not the pack bytes'), (key === 'tamper' ? vendor : vendor).privateKey)
      : edSign(null, bytes, key.privateKey);
  writeFileSync(`${file}.sig`, sig.toString('base64'));
  return file;
}

const NOW = Date.parse('2026-09-07T12:00:00Z');

function ev(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    event_key: 'k', tool: 'claude_code', model: 'claude-sonnet-4', session_id: 's',
    project: null, git_branch: null, ts: NOW - 60_000,
    input_tokens: 5, output_tokens: 10, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0,
    cache_read_tokens: 0, reasoning_tokens: 0, total_tokens: 15, cost_usd: null,
    confidence: 'exact', is_error: 0, stop_reason: null, source: 'live', raw_ref: '/f',
    tools: null, agent_id: null, context_window: null, duration_ms: null, duration_kind: null,
    ...over,
  };
}

function an(over: Partial<Anomaly> = {}): Anomaly {
  return {
    anomaly_key: 'error_storm:s:w1', rule: 'error_storm', severity: 'warn', tool: 'claude_code',
    session_id: 's', model: null, window_start: NOW - 60_000, window_end: NOW,
    title: 't', detail: 'd', observed: 5, baseline: null, threshold: null,
    confidence: 'exact', source: 'live', detected_at: NOW,
    ...over,
  };
}

const packRecord = (over: Partial<Parameters<typeof contentStaleRows>[0][number]>) => ({
  kind: 'dlp_detectors', version: 5, checksum: 'x', built_at: null, ring: null, entry_count: null,
  trust: 'builtin_floor' as const, signature: null, path: null, source: 'builtin' as const,
  load_state: 'builtin' as const, reason: null, ...over,
});

test('empty pack roots: the builtin floor is registered and active', () => {
  const d = db();
  const r = sync(d);
  assert.ok(r.packs.some((p) => p.kind === 'dlp_detectors' && p.trust === 'builtin_floor'));
  assert.ok(r.packs.some((p) => p.kind === 'pricing' && p.trust === 'builtin_floor'));
  const rows = d.prepare("SELECT kind FROM content_packs WHERE trust = 'builtin_floor' AND active = 1").all() as { kind: string }[];
  assert.ok(rows.length >= 2);
});

test('a vendor-signed pack loads with trust vendor_signed and becomes active', () => {
  writePack(MANAGED, 'advisory_floor.json', { kind: 'advisory_floor', version: 3, built_at: NOW - 86_400_000, entries: [{ id: 'a' }, { id: 'b' }] }, vendor);
  const d = db();
  const r = sync(d);
  const p = r.packs.find((x) => x.kind === 'advisory_floor');
  assert.equal(p?.load_state, 'loaded');
  assert.equal(p?.trust, 'vendor_signed');
  assert.equal(p?.entry_count, 2);
  const row = d.prepare("SELECT trust, active, signature FROM content_packs WHERE kind = 'advisory_floor' AND version = 3").get() as { trust: string; active: number; signature: string };
  assert.equal(row.trust, 'vendor_signed');
  assert.equal(row.active, 1);
  assert.ok(row.signature.length > 10);
  assert.equal(activePack(d, 'advisory_floor').version, 3);
});

test('a tampered signature refuses the pack — never warn-and-load', () => {
  writePack(USER, 'noise.json', { kind: 'noise', version: 1, built_at: NOW }, 'tamper');
  const d = db();
  const r = sync(d);
  assert.equal(r.packs.find((x) => x.kind === 'noise')?.load_state, 'rejected');
  assert.match(r.packs.find((x) => x.kind === 'noise')?.reason ?? '', /signature invalid under every trust anchor/);
  assert.equal((d.prepare("SELECT COUNT(*) AS n FROM content_packs WHERE kind = 'noise'").get() as { n: number }).n, 0);
  assert.ok(readLoadState().some((l) => l.state === 'rejected' && /signature invalid/.test(l.reason ?? '')));
});

test('an unsigned pack outside the managed root is refused', () => {
  writePack(USER, 'semconv.json', { kind: 'semconv', version: 1 }, 'none');
  const d = db();
  const r = sync(d);
  assert.equal(r.packs.find((x) => x.kind === 'semconv')?.load_state, 'rejected');
});

test('a user pack of a kind shadowed by a managed pack is recorded as ignored_user_override', () => {
  writePack(MANAGED, 'assets.json', { kind: 'assets', version: 4, built_at: NOW - 1000 }, admin);
  writePack(USER, 'my-assets.json', { kind: 'assets', version: 9, built_at: NOW - 1000 }, admin);
  const d = db();
  const r = sync(d);
  const loaded = r.packs.find((x) => x.kind === 'assets' && x.load_state === 'loaded');
  const ignored = r.packs.find((x) => x.kind === 'assets' && x.load_state === 'ignored_user_override');
  assert.equal(loaded?.version, 4); // the managed dir is scanned first and wins
  assert.equal(ignored?.version, 9);
  assert.equal(ignored?.checksum.length, 64); // checksum retained, not silently dropped
  const active = d.prepare("SELECT version FROM content_packs WHERE kind = 'assets' AND active = 1").get() as { version: number };
  assert.equal(active.version, 4);
});

test('pricing: the user override loses to a managed pack but is listed with its checksum', () => {
  const d = db();
  writePack(MANAGED, 'pricing.json', { kind: 'pricing', version: 7, models: { 'claude-sonnet-4': { input: 3, output: 15, effective_from: '2026-09-01' } } }, vendor);
  writeFileSync(join(HOME, '.vole', 'pricing.json'), JSON.stringify({ models: { 'my-model': { input: 1, output: 1, effective_from: '2026-01-01' } } }));
  sync(d);
  const r = resolvePricing(d);
  assert.equal(r.source, 'managed_pack');
  assert.equal(r.pricing_rev, 7);
  assert.equal(r.cost_basis, 'pricing_pack:v7');
  assert.ok(r.ignored_override_sha256); // the losing override is recorded, not silently dropped
});

test('pricing: with no managed pack the user override wins', () => {
  const d = db();
  rmSync(join(MANAGED, 'pricing.json'));
  rmSync(join(MANAGED, 'pricing.json.sig'));
  d.prepare("DELETE FROM content_packs WHERE kind = 'pricing' AND trust != 'builtin_floor'").run();
  d.prepare("UPDATE content_packs SET active = 1 WHERE kind = 'pricing'").run();
  const r = resolvePricing(d);
  assert.equal(r.source, 'user_override');
  assert.match(r.cost_basis, /^pricing_override:[0-9a-f]{8}$/);
});

test('content_rev: re-scoring escalates in place, does not duplicate, and declines are counted', () => {
  const d = db();
  const key = 'error_storm:s:w1';
  const r1 = insertAnomaliesWithRev(d, [an({ anomaly_key: key, severity: 'warn', observed: 5 })], 2);
  assert.equal(r1.inserted.length, 1);
  assert.equal((d.prepare('SELECT content_rev FROM anomalies WHERE anomaly_key = ?').get(key) as { content_rev: number }).content_rev, 2);

  // A newer pack scoring the same window higher: one row, wider severity, original content_rev kept.
  const r2 = insertAnomaliesWithRev(d, [an({ anomaly_key: key, severity: 'critical', observed: 9 })], 3);
  assert.equal(r2.inserted.length, 0);
  assert.equal(r2.escalated.length, 1);
  assert.equal((d.prepare('SELECT COUNT(*) AS n FROM anomalies WHERE anomaly_key = ?').get(key) as { n: number }).n, 1);
  const row = d.prepare('SELECT severity, content_rev FROM anomalies WHERE anomaly_key = ?').get(key) as { severity: string; content_rev: number };
  assert.equal(row.severity, 'critical');
  assert.equal(row.content_rev, 2); // the revision that first produced the row, never re-derived

  // A newer pack scoring it lower: nothing changes, and the decline is counted.
  const r3 = insertAnomaliesWithRev(d, [an({ anomaly_key: key, severity: 'info', observed: 1 })], 4);
  assert.equal(r3.declined, 1);
  assert.equal((d.prepare('SELECT severity FROM anomalies WHERE anomaly_key = ?').get(key) as { severity: string }).severity, 'critical');

  // stampContentRev only ever widens NULLs.
  insertAnomalies(d, [an({ anomaly_key: 'error_storm:s:w4' })]);
  assert.equal(stampContentRev(d, 1), 1);
  assert.equal((d.prepare('SELECT content_rev FROM anomalies WHERE anomaly_key = ?').get('error_storm:s:w4') as { content_rev: number }).content_rev, 1);
});

test('label carry-over: a disposition survives the bump; the re-review queue lists old-rev rows', () => {
  const d = db();
  insertAnomaliesWithRev(d, [an({ anomaly_key: 'error_storm:s:w3', severity: 'critical', observed: 6 })], 5);
  d.prepare('INSERT INTO finding_actions (anomaly_key, action, note, actor, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('error_storm:s:w3', 'acknowledged', 'known CI noise', 'analyst', NOW);
  const queue = reReviewQueue(d, 9);
  assert.ok(queue.rows.some((r) => r.anomaly_key === 'error_storm:s:w3'));
  const labels = carryOverLabels(d, ['error_storm:s:w3']);
  assert.equal(labels['error_storm:s:w3']?.[0]?.action, 'acknowledged'); // the label carried over
});

test('requeueOnBump requeues retained DLP evidence behind the new revision', () => {
  const d = db();
  d.prepare('INSERT INTO dlp_scan_state (sink_key, bytes_scanned, completed, pack_rev) VALUES (?, 100, 1, 1)').run('k1');
  d.prepare('INSERT INTO dlp_scan_state (sink_key, bytes_scanned, completed, pack_rev) VALUES (?, 100, 1, 3)').run('k2');
  const n = requeueOnBump(d, 4);
  assert.equal(n, 2);
  const rows = d.prepare('SELECT sink_key, completed, pack_rev FROM dlp_scan_state').all() as { sink_key: string; completed: number; pack_rev: number }[];
  assert.ok(rows.every((r) => r.completed === 0 && r.pack_rev === 4));
});

test('suppression register: mute_report counts what it hid; mute_scan writes NULL, never 0', () => {
  const d = db();
  applySuppressionPack(d, [
    { kind: 'error_storm', entry_id: 'e1', reason: 'CI noise', set_by: 'admin@corp', mode: 'mute_report' },
    { kind: 'rate_limit_pressure', entry_id: 'e2', reason: 'noisy on codex', set_by: 'admin@corp', mode: 'mute_scan' },
    { kind: 'context_pressure', entry_id: '', reason: '', set_by: 'x' }, // no reason: refused
  ], NOW);
  const { evaluate, skip } = splitModes(d, NOW);
  assert.ok(evaluate.has('error_storm'));
  assert.ok(skip.has('rate_limit_pressure'));

  const survivors = suppressReported(d, [an({ rule: 'error_storm' }), an({ rule: 'repeat_call_loop' })], NOW);
  assert.equal(survivors.length, 1); // the muted finding is withheld, not deleted
  const sc = d.prepare("SELECT n FROM suppressed_counts WHERE kind = 'error_storm' AND entry_id = 'e1'").get() as { n: number };
  assert.equal(sc.n, 1);
  assert.equal((d.prepare("SELECT hidden_count FROM suppression WHERE rule = 'error_storm'").get() as { hidden_count: number }).hidden_count, 1);

  recordSuppressed(d, 'rate_limit_pressure', 'e2', null, NOW); // mute_scan: not evaluated
  const row = d.prepare("SELECT n FROM suppressed_counts WHERE kind = 'rate_limit_pressure'").get() as { n: number | null };
  assert.equal(row.n, null); // unknown, never 0

  // Expiry: an expired entry stops suppressing.
  applySuppressionPack(d, [{ kind: 'error_storm', entry_id: 'e1', reason: 'CI noise', set_by: 'admin@corp', mode: 'mute_report', expires_at: NOW - 1 }], NOW);
  assert.equal(activeSuppressions(d, NOW).length, 1); // only the mute_scan entry remains

  // The register path itself: a signed admin pack carrying a suppressions block.
  writePack(MANAGED, 'suppressions.json', {
    kind: 'noise', version: 3, built_at: NOW,
    suppressions: [{ kind: 'tool_failure_storm', entry_id: 'ops-1', reason: 'known flake', set_by: 'ops@corp', mode: 'mute_report' }],
  }, admin);
  sync(d);
  const fromPack = d.prepare("SELECT entry_id, mode, set_by FROM suppression WHERE rule = 'tool_failure_storm'").get() as { entry_id: string; mode: string; set_by: string };
  assert.equal(fromPack.entry_id, 'ops-1');
  assert.equal(fromPack.mode, 'mute_report');
});

test('content_stale: ages in 30-day steps with a deterministic key, per-kind floors from policy', () => {
  mkdirSync(join(HOME, '.vole', 'policy'), { recursive: true });
  writeFileSync(join(HOME, '.vole', 'policy', 'policy.json'), JSON.stringify({ content_stale_floors: { dlp_detectors: 30 } }));
  const floors = staleFloors();
  assert.equal(floors.find((f) => f.kind === 'dlp_detectors')?.floor_days, 30);
  assert.equal(floors.find((f) => f.kind === 'dlp_detectors')?.provenance, 'policy.json');
  assert.equal(floors.find((f) => f.kind === 'advisory_floor')?.floor_days, 30); // module default
  assert.equal(floors.find((f) => f.kind === 'default')?.floor_days, 90);

  const old = packRecord({ built_at: NOW - 118 * 86_400_000 });
  const rows = contentStaleRows([old], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.anomaly_key, 'content_stale:dlp_detectors:5:3'); // floor(118/30) = 3, no now() in the key
  assert.equal(rows[0]!.floor_days, 30);

  // 32 days later the same pack escalates to the next step — a new key, not a frozen severity.
  const rows2 = contentStaleRows([old], NOW + 32 * 86_400_000);
assert.equal(rows2[0]!.anomaly_key, 'content_stale:dlp_detectors:5:5');

  // semconv is info-only.
  const semi = contentStaleRows([packRecord({ kind: 'semconv', built_at: NOW - 200 * 86_400_000 })], NOW);
assert.equal(semi[0]!.severity, 'info');
  writeFileSync(join(HOME, '.vole', 'policy', 'policy.json'), '{}');
});

test('registerPacks writes content_stale rows that escalate in steps, not per-poll duplicates', () => {
  const d = db();
  writePack(USER, 'oldpack.json', { kind: 'noise', version: 2, built_at: NOW - 118 * 86_400_000 }, admin);
  sync(d);
  const n1 = (d.prepare("SELECT COUNT(*) AS n FROM anomalies WHERE rule = 'content_stale'").get() as { n: number }).n;
  assert.ok(n1 >= 1);
  const k = d.prepare("SELECT anomaly_key FROM anomalies WHERE rule = 'content_stale'").get() as { anomaly_key: string };
  assert.match(k.anomaly_key, /^content_stale:noise:2:3$/);
  sync(d); // second pass with the same files: no duplicate
  assert.equal((d.prepare("SELECT COUNT(*) AS n FROM anomalies WHERE rule = 'content_stale'").get() as { n: number }).n, n1);
});

test('comparability gate: not_comparable, not_seen and comparable verdicts with reasons', () => {
  const d = db();
  let r = comparabilityGate(d, BUILTIN_INDICATORS);
  const pkg = r.find((x) => x.spec.kind === 'package')!;
  assert.equal(pkg.verdict, 'not_comparable'); // ledger empty
  assert.match(pkg.reason, /ledger package_execs is empty/);

  d.prepare('INSERT INTO package_execs (call_key, package_name, registry, fetch_and_run, ts) VALUES (?, ?, ?, ?, ?)').run('c1', 'keyv', 'npm', 0, NOW);
  r = comparabilityGate(d, [{ kind: 'package', ledger: 'package_execs', column: 'package_name', normaliser_id: 'semver_range', strength: 'identity', value: 'left-pad' }]);
assert.equal(r[0]!.verdict, 'not_seen');
  r = comparabilityGate(d, [{ kind: 'package', ledger: 'package_execs', column: 'package_name', normaliser_id: 'semver_range', strength: 'identity', value: 'keyv' }]);
assert.equal(r[0]!.verdict, 'comparable');
  r = comparabilityGate(d, [{ kind: 'bogus', ledger: 'nope', column: 'x', normaliser_id: 'y', strength: 'identity' }]);
assert.equal(r[0]!.verdict, 'not_comparable');
});

test('baseline snapshot and drift diff', () => {
  const d = db();
  d.prepare('INSERT INTO posture_mcp_servers (source, config_path, client, server_name, mcp_identity, transport, command, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('s', '/f.json', 'claude_code', 'github', 'id-abc', 'stdio', 'npx -y @github/mcp', NOW, NOW);
  captureBaseline(d, NOW);
  assert.equal(driftDiff(d).rows.filter((r) => r.kind === 'mcp_identity').length, 0); // unchanged: no drift
  d.prepare("UPDATE posture_mcp_servers SET command = 'npx -y @evil/mcp' WHERE mcp_identity = 'id-abc'").run();
  const drift = driftDiff(d).rows.filter((r) => r.kind === 'mcp_identity');
  assert.equal(drift.length, 1);
  assert.equal(drift[0]!.state, 'changed');
  assert.notEqual(drift[0]!.before, drift[0]!.after);
  d.prepare('INSERT INTO posture_mcp_servers (source, config_path, client, server_name, mcp_identity, transport, command, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('s', '/f.json', 'claude_code', 'searxng', 'id-2', 'stdio', 'x', NOW, NOW);
  assert.equal(driftDiff(d).rows.filter((r) => r.state === 'added').length, 1);
});

test('rule provenance and controls mapping', () => {
  assert.ok(provenanceFor('content_stale')?.incident_name);
  assert.ok(controlsForRule('sensitive_read_unasked').some((c) => c.framework === 'MITRE ATLAS' && c.control_id === 'CS0045'));
  assert.equal(controlsForRule('repeat_call_loop').length, 0);
});

test('preflight: unsigned candidates are refused; signed ones are scored read-only', () => {
  const d = db();
  insertEvents(d, [ev({ event_key: 'p1', model: 'claude-sonnet-4' }), ev({ event_key: 'p2', model: 'mystery-model' })]);

  const file = join(USER, 'candidate-pricing.json');
  writeFileSync(file, JSON.stringify({ kind: 'pricing', version: 9, models: { 'mystery-model': { input: 1, output: 2, effective_from: '2026-09-01' } } }));
  let r = preflightPack(d, file);
  assert.equal(r.refusal, 'unsigned candidate — refusing to score (pass --allow-unsigned to score anyway)');

  writePack(USER, 'candidate-pricing.json', { kind: 'pricing', version: 9, models: { 'mystery-model': { input: 1, output: 2, effective_from: '2026-09-01' } } }, vendor);
  r = preflightPack(d, file);
  assert.equal(r.verified, true);
  assert.equal(r.pricing?.rows_gaining_rate, 1);
  assert.ok(r.pricing?.models_added.includes('mystery-model'));
  assert.equal((d.prepare("SELECT COUNT(*) AS n FROM content_packs WHERE kind = 'pricing' AND version = 9").get() as { n: number }).n, 0); // nothing was written
});

test('preflight: a tampered signature refuses the candidate outright', () => {
  const d = db();
  writePack(USER, 'candidate2.json', { kind: 'assets', version: 1, entries: [] }, 'tamper');
  const r = preflightPack(d, join(USER, 'candidate2.json'));
  assert.match(r.refusal ?? '', /signature invalid under every trust anchor/);
});

test('preflight: command_patterns and thresholds kinds score their ledgers', () => {
  const d = db();
  d.prepare('INSERT INTO tool_calls (tool_call_key, tool, name, shape, ts, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('tc1', 'claude_code', 'Bash', 'git push origin main', NOW, NOW, NOW);
  d.prepare('INSERT INTO tool_calls (tool_call_key, tool, name, shape, ts, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('tc2', 'claude_code', 'Bash', 'npm install left-pad', NOW, NOW, NOW);
  const cpFile = writePack(USER, 'candidate-cmdpat.json', { kind: 'command_patterns', version: 1, entries: [{ id: 'git-push', pattern: '^git push' }] }, vendor);
  const cp = preflightPack(d, cpFile);
  assert.equal(cp.command_patterns?.entries[0]!.hits, 1);
  assert.equal(cp.command_patterns?.total_tool_calls, 2);

  const thFile = writePack(USER, 'candidate-thresholds.json', { kind: 'thresholds', rules: { error_storm: { min_errors: 9 } } }, admin);
  const th = preflightPack(d, thFile);
  assert.equal(th.thresholds?.changed.length, 1);
  assert.equal(th.thresholds?.changed[0]!.to, 9);
  assert.ok((th.thresholds?.changed[0]?.stored_anomalies ?? 0) >= 1); // the error_storm rows inserted earlier
});

test('preflight assets: rows resolved, dead entries, collisions, near_match, severity delta', () => {
  const d = db();
  const ins = d.prepare('INSERT INTO action_targets (call_key, target_kind, target_label, locality, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('c1', 'remote_database', 'db-2.b.db.ondigitalocean.com', 'remote', NOW, NOW);
  ins.run('c2', 'remote_database', 'db-2.b.db.ondigitalocean.com', 'remote', NOW, NOW);
  ins.run('c3', 'remote_database', 'docs.example.com', 'remote', NOW, NOW);

  const manifest = {
    kind: 'assets', version: 1,
    entries: [
      { asset_id: 'prod-db', tier: 1, kind: 'dsn', match: 'db-2.b.db.ondigitalocean.com', basis: 'customer database, DPA scope' },
      { asset_id: 'prod-db-alias', tier: 2, kind: 'domain', match: 'db-2.b.db.ondigitalocean.com' }, // collision: loses to chain order
      { asset_id: 'staging', tier: 3, kind: 'domain', match: 'staging.example.com' }, // dead: resolves nothing
      { asset_id: 'oops', tier: 1, kind: 'nonsense', match: 'x' }, // invalid kind: refused
    ],
  };
  const file = writePack(USER, 'candidate-assets.json', manifest, admin);
  const r = preflightPack(d, file);
  assert.equal(r.assets?.entries.find((e) => e.asset_id === 'prod-db')?.rows_resolved, 2);
  assert.deepEqual(r.assets?.dead, ['staging']);
  assert.equal(r.assets?.collisions.length, 1);
  assert.equal(r.assets?.collisions[0]!.winner, 'prod-db');
  assert.equal(r.assets?.collisions[0]!.loser, 'prod-db-alias');
  assert.equal(r.assets?.near_match.length, 1); // docs.example.com sits one label from staging.example.com
  assert.equal(r.assets?.invalid.length, 1);
  assert.equal(r.assets?.severity_delta, 2); // the two tier-1-resolving rows escalate one step
});
