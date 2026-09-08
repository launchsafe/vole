import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache } from './db';
import type { DB } from './db';
import {
  loadAssetRegister, resolveAsset, severityWithAsset, severityInputsText, stampAnomalyAsset,
  detectCrownJewelVariants, detectTier1RemoteWrite, assetCoverage, preflightRegister,
  candidateEntryLine, proposeAsset, proposedAssetPath,
} from './assets';

const NOW = 1_750_000_000_000;

function freshDb(): DB {
  // openDb caches the first handle; tests need isolation, so drop the cache each time.
  resetDbCache();
  return openDb(':memory:');
}

const REGISTER_TEXT = JSON.stringify({
  version: 7,
  entries: [
    { asset_id: 'prod-db', tier: 1, kind: 'dsn', match: 'launchsafe-db-do-user-35002029-0.e.db.ondigitalocean.com:25060', owner: 'platform', basis: 'customer database, DPA scope' },
    { asset_id: 'corp-domain', tier: 2, kind: 'domain' as const, match: 'internal.corp.example', basis: 'internal services' },
    { asset_id: 'platform-repo', tier: 2, kind: 'repo' as const, match: 'github.com/acme/*', owner: 'acme', basis: 'the monorepo' },
    { asset_id: 'customer-data', tier: 1, kind: 'path' as const, match: '/data/customers/*.csv', basis: 'customer exports' },
    { asset_id: 'vault-store', tier: 1, kind: 'store', match: '/vault/prod', basis: 'production secrets' },
  ],
});

// ── loading and refusal ──────────────────────────────────────────────────────

test('loadAssetRegister accepts the six kinds and quotes the basis', () => {
  const reg = loadAssetRegister(REGISTER_TEXT, '/policy/assets.json');
  assert.equal(reg.version, 7);
  assert.equal(reg.entries.length, 5);
  assert.equal(reg.rejected.length, 0);
  assert.equal(reg.entries[0]!.basis, 'customer database, DPA scope');
});

test('loadAssetRegister refuses the entry kinds it must refuse', () => {
  const reg = loadAssetRegister(JSON.stringify({
    entries: [
      { asset_id: 'live', tier: 1, kind: 'literal', match: 'sk-live-123' },
      { asset_id: 'plain', tier: 1, kind: 'class' as const, match: { literal: 'not-an-hmac' } },
      { asset_id: 'ok-class', tier: 1, kind: 'class' as const, match: { literal: 'a'.repeat(64) } },
      { asset_id: 'no-port', tier: 1, kind: 'dsn', match: 'db.example.com' },
      { asset_id: 'bad-tier', tier: 9, kind: 'domain' as const, match: 'x.example' },
      { asset_id: 'empty', tier: 1, kind: 'domain' as const, match: '' },
    ],
  }));
  assert.equal(reg.entries.length, 1, 'only the HMAC-shaped class entry survives');
  assert.equal(reg.entries[0]!.asset_id, 'ok-class');
  const reasons = reg.rejected.map((r) => r.reason).join('\n');
  assert.ok(reasons.includes("kind 'literal' refused"));
  assert.ok(reasons.includes('entropy floor'));
  assert.ok(reasons.includes('carries no port'));
  assert.ok(reasons.includes('tier must be an integer 1..5'));
  assert.ok(reg.rejected.every((r) => typeof r.index === 'number'), 'rejections name the entry index');
});

test('loadAssetRegister rejects non-JSON wholesale', () => {
  const reg = loadAssetRegister('{oops');
  assert.equal(reg.entries.length, 0);
  assert.ok(reg.rejected[0]!.reason.includes('not valid JSON'));
});

// ── the resolver ────────────────────────────────────────────────────────────

test('resolveAsset follows the chain: repo -> dsn -> domain -> store -> path', () => {
  const reg = loadAssetRegister(REGISTER_TEXT);
  const repo = resolveAsset(reg, { kind: 'repo' as const, value: 'git@github.com:acme/platform.git' });
  assert.equal(repo?.entry.asset_id, 'platform-repo');
  const dsn = resolveAsset(reg, { kind: 'dsn', value: 'launchsafe-db-do-user-35002029-0.e.db.ondigitalocean.com:25060' });
  assert.equal(dsn?.entry.asset_id, 'prod-db');
  const domain = resolveAsset(reg, { kind: 'domain' as const, value: 'api.internal.corp.example' });
  assert.equal(domain?.entry.asset_id, 'corp-domain');
  assert.equal(domain?.matchedBy, 'domain');
  const store = resolveAsset(reg, { kind: 'store', value: '/vault/prod/secrets/kv' });
  assert.equal(store?.entry.asset_id, 'vault-store');
  const path = resolveAsset(reg, { kind: 'path' as const, value: '/data/customers/eu.csv' });
  assert.equal(path?.entry.asset_id, 'customer-data');
  // an unregistered DSN-shaped host resolves to nothing (shape near-misses stay near-misses)
  assert.equal(resolveAsset(reg, { kind: 'dsn', value: 'db-xxxx.b.db.ondigitalocean.com:25060' }), null);
  assert.equal(resolveAsset(reg, { kind: 'path' as const, value: '/data/other.txt' }), null);
});

// ── criticality as the second severity input ────────────────────────────────

test('severityWithAsset escalates exactly one step, never de-escalates', () => {
  assert.equal(severityWithAsset('info', 1), 'warn');
  assert.equal(severityWithAsset('warn', 1), 'critical');
  assert.equal(severityWithAsset('critical', 1), 'critical');
  assert.equal(severityWithAsset('warn', 2), 'critical');
  assert.equal(severityWithAsset('warn', 3), 'warn', 'tier 3-5: unchanged');
  assert.equal(severityWithAsset('warn', null), 'warn', 'unresolved never de-escalates');
});

test('severityInputsText renders the template sentences', () => {
  const reg = loadAssetRegister(REGISTER_TEXT);
  const escalated = severityInputsText({
    severity: 'critical', posture: 'bypass posture', tier: 1,
    entry: reg.entries[0], registerVersion: reg.version,
  });
  assert.equal(escalated, 'critical: bypass posture + tier 1 (assets.json v7, entry prod-db: "customer database, DPA scope")');
  const unresolved = severityInputsText({ severity: 'warn', posture: 'default posture', tier: null });
  assert.ok(unresolved.includes("target not in the register"));
  assert.ok(unresolved.includes("never 'low value'"));
});

test('stampAnomalyAsset widens asset columns and escalates severity once', () => {
  const db = freshDb();
  const reg = loadAssetRegister(REGISTER_TEXT);
  db.prepare(
    `INSERT INTO anomalies (anomaly_key, rule, severity, tool, window_start, window_end, title, detail, observed, confidence, source, detected_at)
     VALUES ('k1', 'remote_database', 'warn', 'claude_code', 1, 1, 't', 'd', 1, 'exact', 'live', 1)`,
  ).run();
  stampAnomalyAsset(db, 'k1', reg.entries[0]!, reg.version, 'warn');
  const row = db.prepare('SELECT asset_id, asset_tier, asset_rev, severity FROM anomalies WHERE anomaly_key = ?').get('k1') as { asset_id: string; asset_tier: number; asset_rev: number; severity: string };
  assert.equal(row.asset_id, 'prod-db');
  assert.equal(row.asset_tier, 1);
  assert.equal(row.asset_rev, 7);
  assert.equal(row.severity, 'critical');
  // re-stamping never double-escalates or rewrites (asset_id IS NULL guard)
  stampAnomalyAsset(db, 'k1', reg.entries[0]!, reg.version, 'warn');
  const again = db.prepare('SELECT severity FROM anomalies WHERE anomaly_key = ?').get('k1') as { severity: string };
  assert.equal(again.severity, 'critical');
});

// ── crown-jewel variants over the ledgers ───────────────────────────────────

function seedLedgers(db: DB): void {
  db.prepare(
    `INSERT INTO secret_sightings (fingerprint, detector, sink_key, path, byte_offset, byte_length, direction, status, first_seen, last_seen)
     VALUES ('fp1', 'aws_key', 'sk1', '/vault/prod/secrets/kv', 0, 10, 'at_rest', 'candidate', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO secret_sightings (fingerprint, detector, sink_key, path, byte_offset, byte_length, direction, status, first_seen, last_seen)
     VALUES ('fp2', 'aws_key', 'sk2', '/tmp/scratch', 0, 10, 'egress', 'candidate', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO action_targets (call_key, target_kind, target_label, locality, first_seen, last_seen)
     VALUES ('ck1', 'remote_database_write', 'launchsafe-db-do-user-35002029-0.e.db.ondigitalocean.com:25060', 'remote', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO action_targets (call_key, target_kind, target_label, locality, first_seen, last_seen)
     VALUES ('ck2', 'remote_database_write', 'db-xxxx.b.db.ondigitalocean.com:25060', 'remote', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO action_targets (call_key, target_kind, target_label, locality, first_seen, last_seen)
     VALUES ('ck3', 'remote_database_write', 'HOSTNAME_OR_IP_ADDRESS:25060', 'remote', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO context_edges (call_key, transport, verb, destination, direction, ts)
     VALUES ('ce1', 'https', 'post', 'https://launchsafe-db-do-user-35002029-0.e.db.ondigitalocean.com/upload', 'out', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO context_edges (call_key, transport, verb, destination, direction, ts)
     VALUES ('ce2', 'https', 'post', 'https://localhost:3000/x', 'out', 1)`,
  ).run();
}

test('crown-jewel variants fire on tiered targets only', () => {
  const db = freshDb();
  seedLedgers(db);
  const reg = loadAssetRegister(REGISTER_TEXT);
  const out = detectCrownJewelVariants(db, NOW, reg);
  const rules = out.map((a) => a.rule);
  assert.ok(rules.includes('crown_jewel_read_unasked'), 'at-rest sighting under /vault/prod (tier 1)');
  assert.ok(rules.includes('tier1_remote_write'), 'declared production DSN');
  assert.ok(rules.includes('crown_jewel_left_device'), 'off-device context edge to tier-1 domain');
  assert.ok(!rules.includes('crown_jewel_egress'), 'the /tmp egress sighting is not under a tiered path');
  // no register: nothing fires at all (absent register is never implicit zero)
  assert.equal(detectCrownJewelVariants(db, NOW, { ...reg, entries: [] }).length, 0);
});

test('tier1_remote_write ignores DSN look-alikes and placeholders', () => {
  const db = freshDb();
  seedLedgers(db);
  const reg = loadAssetRegister(REGISTER_TEXT);
  const out = detectTier1RemoteWrite(db, NOW, reg);
  const labels = out.map((a) => a.detail);
  assert.equal(out.length, 1, 'only the declared DSN fires');
  assert.ok(!labels.some((d) => d.includes('db-xxxx')), 'near-miss host does not fire');
  assert.ok(!labels.some((d) => d.includes('HOSTNAME')), 'placeholder does not fire');
});

// ── register coverage ────────────────────────────────────────────────────────

test('assetCoverage prints the absent-register sentence and the worklist', () => {
  const db = freshDb();
  seedLedgers(db);
  const empty = assetCoverage(db, loadAssetRegister('{}'));
  assert.equal(empty.absent, true);
  assert.equal(empty.sentence, 'No asset register loaded — every severity is posture-only');
  const reg = loadAssetRegister(REGISTER_TEXT);
  const cov = assetCoverage(db, reg);
  assert.equal(cov.absent, false);
  const fw = cov.ledgers.find((l) => l.ledger === 'file_writes')!;
  assert.equal(fw.eligible, 0);
  assert.equal(fw.coveragePct, null, 'no eligible rows: coverage is unknown, not 0%');
  const at = cov.ledgers.find((l) => l.ledger === 'action_targets')!;
  assert.equal(at.eligible, 3);
  assert.equal(at.resolved, 1);
  const worklist = cov.unresolvedTargets.find((t) => t.value.includes('db-xxxx'));
  assert.ok(worklist, 'the DSN look-alike lands in the unresolved worklist');
  assert.ok(cov.sentence.includes('never de-escalates'));
});

// ── preflight ──────────────────────────────────────────────────────────────

test('preflightRegister: rows, dead entries, near-matches and the worksheet header', () => {
  const db = freshDb();
  seedLedgers(db);
  const candidate = loadAssetRegister(JSON.stringify({
    version: 8,
    entries: [
      { asset_id: 'prod-db2', tier: 1, kind: 'dsn', match: 'launchsafe-db-do-user-35002029-1.e.db.ondigitalocean.com:25060', basis: 'landing db' },
      { asset_id: 'prod-db', tier: 1, kind: 'dsn', match: 'launchsafe-db-do-user-35002029-0.e.db.ondigitalocean.com:25060', basis: 'customer db' },
      { asset_id: 'dead', tier: 3, kind: 'domain' as const, match: 'never.seen.example', basis: 'nothing' },
    ],
  }));
  const report = preflightRegister(db, candidate);
  assert.ok(report.header.includes('worksheet'), 'the header states it is a worksheet, never a gate');
  const byId = new Map(report.entries.map((e) => [e.asset_id, e]));
  // the DSN host appears once in action_targets and once in context_edges: 2 rows would resolve
  assert.equal(byId.get('prod-db')!.rowsResolved, 2);
  assert.equal(byId.get('prod-db')!.dead, false);
  assert.equal(byId.get('dead')!.dead, true);
  // single-label difference from the observed DSN is a near-match, not a match
  assert.ok(byId.get('prod-db2')!.nearMatches.some((n) => n.includes('35002029-0')), 'near-match names the observed host');
  assert.equal(byId.get('prod-db2')!.rowsResolved, 0);
});

// ── proposals ───────────────────────────────────────────────────────────────

test('proposeAsset writes only to assets.proposed.json, never the signed pack', () => {
  const prevHome = process.env.VOLE_HOME_OVERRIDE;
  const dir = join(tmpdir(), `vole-propose-${Date.now()}`);
  process.env.VOLE_HOME_OVERRIDE = dir;
  try {
    const entry = { asset_id: 'cand', tier: 2, kind: 'domain' as const, match: 'new.corp.example', basis: 'proposed' };
    proposeAsset(entry);
    proposeAsset({ ...entry, asset_id: 'cand2' });
    const text = readFileSync(proposedAssetPath(), 'utf8');
    const doc = JSON.parse(text) as { asset_id: string }[];
    assert.equal(doc.length, 2);
    assert.ok(proposedAssetPath().endsWith('assets.proposed.json'));
    // the policy pack itself is untouched: it does not exist
    let packExists = true;
    try {
      readFileSync(join(dir, '.vole', 'policy', 'assets.json'));
    } catch {
      packExists = false;
    }
    assert.equal(packExists, false);
  } finally {
    process.env.VOLE_HOME_OVERRIDE = prevHome;
  }
});

test('candidateEntryLine emits a copy-as-entry register line', () => {
  const line = candidateEntryLine('api.internal.corp.example', 'context_edges');
  const doc = JSON.parse(line) as { kind: string; match: string };
  assert.equal(doc.kind, 'domain');
  assert.equal(doc.match, 'api.internal.corp.example');
  const pathLine = candidateEntryLine('/data/customers/eu.csv', 'file_writes');
  assert.equal((JSON.parse(pathLine) as { kind: string }).kind, 'path');
});
