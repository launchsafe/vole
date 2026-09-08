import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache } from '../db';
import type { DB } from '../db';
import { huntWindow, recordHuntRun, huntRunId } from './window';
import { successorWindow } from './successor';
import { residueHunt } from './residue';
import {
  loadAdvisories,
  advisoriesSignature,
  rangeMatches,
  versionCmp,
  versionResidency,
  advisoryExposure,
  huntFingerprints,
} from './advisories';

const NOW = Date.parse('2026-09-07T00:00:00Z');

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'vole-hunt-'));
  const db = openDb(join(dir, 't.db'));
  return { db, dir };
}

function seedWindowLedgers(db: DB) {
  db.prepare(
    "INSERT INTO package_execs (call_key, package_name, registry, fetch_and_run, ts) VALUES ('k1','left-pad','npm.npmjs',1,?)",
  ).run(Date.parse('2026-08-10T00:00:00Z'));
  db.prepare(
    "INSERT INTO package_execs (call_key, package_name, registry, fetch_and_run, ts) VALUES ('k2','old-pkg','npm.npmjs',0,?)",
  ).run(Date.parse('2026-01-02T00:00:00Z'));
  db.prepare(
    "INSERT INTO ai_surfaces (surface_key, kind, name, first_seen, last_seen) VALUES ('sk-1','cli','Cursor',?,?)",
  ).run(Date.parse('2026-08-15T00:00:00Z'), Date.parse('2026-08-15T00:00:00Z'));
  db.prepare(
    "INSERT INTO answerable_from (source, indicator_kind, horizon_ts, basis, first_seen, last_seen) VALUES ('ai_surfaces','first_seen',?, 'first collect', ?, ?)",
  ).run(Date.parse('2026-08-15T00:00:00Z'), NOW, NOW);
}

test('window hunt: first appearances inside [A,B], floored at the answerable_from floor', () => {
  const { db } = store();
  try {
    seedWindowLedgers(db);
    const a = Date.parse('2026-08-01T00:00:00Z');
    const b = Date.parse('2026-09-01T00:00:00Z');
    const res = huntWindow(db, a, b);
    const ids = res.hits.map((h) => `${h.ledger}:${h.identity}`);
    assert.ok(ids.includes('package_execs:left-pad'), 'package first appearance in window');
    assert.ok(!ids.includes('package_execs:old-pkg'), 'before the window is not a first appearance in it');
    const cursor = res.hits.find((h) => h.ledger === 'ai_surfaces')!;
    assert.equal(cursor.floored, true, 'first_seen at the horizon is floored, never claimed as arrival');
    const pad = res.hits.find((h) => h.ledger === 'package_execs')!;
    assert.equal(pad.floored, false, 'no answerable_from row for package_execs → not floored');
    assert.ok(res.hits[0]!.first_seen <= res.hits[res.hits.length - 1]!.first_seen, 'sorted by time');
  } finally {
    resetDbCache();
  }
});

test('hunt_runs: the key is deterministic, re-running the same hunt never duplicates', () => {
  const { db } = store();
  try {
    const rec = {
      pack_kind: 'advisories',
      pack_version: 1,
      signature: 'abc123',
      window: [0, 100] as [number, number],
      ran_at: NOW,
      verdicts: { confirmed: 2, cleared: 1, unanswerable: 0, not_seen: 3 },
      horizon_ts: 50,
      answer_sentence: 'answerable only from 1970-01-01',
    };
    const id1 = recordHuntRun(db, rec);
    const id2 = recordHuntRun(db, { ...rec, ran_at: NOW + 5000, verdicts: { confirmed: 3, cleared: 0, unanswerable: 1, not_seen: 2 } });
    assert.equal(id1, id2, 'same pack + signature + window = same hunt');
    assert.equal(huntRunId(rec), id1);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM hunt_runs').get() as { c: number }).c, 1);
    const row = db.prepare('SELECT * FROM hunt_runs').get() as Record<string, unknown>;
    assert.equal(row.ran_at, NOW + 5000, 'the re-run updates verdicts, never duplicates');
    assert.equal(row.verdict_confirmed, 3);
    assert.equal(row.horizon_ts, 50);
  } finally {
    resetDbCache();
  }
});

function seedSuccessor(db: DB) {
  const t0 = Date.parse('2026-08-10T12:00:00Z');
  const ins = db.prepare(
    "INSERT INTO tool_calls (tool_call_key, tool, name, session_id, ts, first_seen, last_seen) VALUES (?,?,?,?,?,?,?)",
  );
  ins.run('c1', 'claude_code', 'Bash', 'sess-1', t0, t0, t0);
  ins.run('c2', 'claude_code', 'WebFetch', 'sess-1', t0 + 5 * 60_000, t0, t0);
  ins.run('c3', 'claude_code', 'Bash', 'sess-2', t0 + 6 * 60_000, t0, t0); // other session
  ins.run('c4', 'claude_code', 'Bash', 'sess-1', t0 + 45 * 60_000, t0, t0); // outside the window
  db.prepare(
    "INSERT INTO context_edges (call_key, transport, verb, destination, direction, ts) VALUES ('c2','https','GET','evil.example','egress',?)",
  ).run(t0 + 5 * 60_000);
  db.prepare(
    "INSERT INTO package_execs (call_key, package_name, registry, fetch_and_run, ts) VALUES ('c1','left-pad','npm.npmjs',1,?)",
  ).run(t0 + 60_000);
  db.prepare(
    "INSERT INTO secret_sightings (fingerprint, detector, sink_key, path, byte_offset, byte_length, first_seen, last_seen) VALUES ('fp1:aa','aws_key','transcripts','/f.jsonl',10,40,?,?)",
  ).run(t0 + 2 * 60_000, t0 + 2 * 60_000);
  return t0;
}

test('successor window: bounded forward join, adjacency not causation', () => {
  const { db } = store();
  try {
    const t0 = seedSuccessor(db);
    const res = successorWindow(db, { session_id: 'sess-1', ts: t0 });
    assert.equal(res.window_minutes, 30, 'declared default, never inferred');
    assert.match(res.caption, /adjacency, not causation/);
    assert.match(res.caption, /30-minute window/);
    const kinds = res.consequences.map((c) => c.kind);
    assert.ok(kinds.includes('tool_call'));
    assert.ok(kinds.includes('context_edge'));
    assert.ok(kinds.includes('package_exec'));
    assert.ok(kinds.includes('secret_sighting'));
    assert.ok(!res.consequences.some((c) => c.ts > t0 + 30 * 60_000), 'outside the window');
    assert.ok(!res.consequences.some((c) => c.label === 'Bash' && c.ts === t0 + 6 * 60_000), 'other session excluded');
    const fetch = res.consequences.find((c) => c.kind === 'tool_call' && c.label.startsWith('WebFetch'))!;
    assert.equal(fetch.minute_offset, 5);
    const widened = successorWindow(db, { session_id: 'sess-1', ts: t0 }, { minutes: 60 });
    assert.ok(widened.consequences.length > res.consequences.length, 'widening strictly widens');
  } finally {
    resetDbCache();
  }
});

test('residue hunt: dated residue names whose clock the date came from', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-residue-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.npm', '_logs'), { recursive: true });
  writeFileSync(join(home, '.npm', '_logs', '2026-08-04T09_10_11_123Z-debug-0.log'), 'log body');
  const root = join(dir, 'repo');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(
    join(root, 'node_modules', '.package-lock.json'),
    JSON.stringify({ packages: { 'node_modules/left-pad': { version: '1.3.0' }, '': {} } }),
  );
  const cellar = join(dir, 'Cellar');
  mkdirSync(join(cellar, 'q', '1.84.0'), { recursive: true });
  writeFileSync(join(cellar, 'q', '1.84.0', 'INSTALL_RECEIPT.json'), JSON.stringify({ time: '2025-07-23T10:00:00Z', source: { versions: { q: '1.84.0' } } }));
  const vscode = join(home, '.vscode', 'extensions');
  mkdirSync(vscode, { recursive: true });
  writeFileSync(
    join(vscode, 'extensions.json'),
    JSON.stringify([{ identifier: { id: 'github.copilot-chat' }, version: '0.61.0', relativeLocation: 'github.copilot-chat-0.61.0' }]),
  );
  writeFileSync(join(vscode, '.obsolete'), JSON.stringify({ 'old.ext-1.0.0': true }));

  const res = residueHunt({ home, workRoots: [root], cellarDir: cellar, caskroomDir: join(dir, 'Caskroom'), vscodeExtensionsDir: vscode });
  const npmLog = res.rows.find((r) => r.source === 'npm_log')!;
  assert.equal(npmLog.date_basis, 'log filename');
  assert.equal(npmLog.date_ts, Date.parse('2026-08-04T09:10:11.123Z'));
  const lock = res.rows.find((r) => r.source === 'npm_lockfile' && r.name === 'left-pad')!;
  assert.equal(lock.version, '1.3.0');
  assert.equal(lock.date_basis, 'lockfile mtime');
  assert.equal(lock.still_on_disk, true);
  const keg = res.rows.find((r) => r.source === 'homebrew_cellar')!;
  assert.equal(keg.date_basis, 'install receipt time');
  assert.equal(keg.date_ts, Date.parse('2025-07-23T10:00:00Z'));
  const ext = res.rows.find((r) => r.source === 'vscode_extension')!;
  assert.equal(ext.name, 'github.copilot-chat');
  assert.equal(ext.date_ts, null, 'the manifest carries no date — presence without a when');

  const tiny = residueHunt({ home, workRoots: [root], byteBudget: 1, cellarDir: join(dir, 'none'), caskroomDir: join(dir, 'none2'), vscodeExtensionsDir: join(dir, 'none3') });
  assert.equal(tiny.truncated, true, 'the declared byte budget stops the hunt');
  assert.ok(tiny.rows.length < res.rows.length);
});

test('advisories: shipped floor table loads, override merges, signature is content-derived', () => {
  const base = loadAdvisories();
  assert.ok(base.file.entries.length >= 6, 'the shipped floor table is non-empty');
  assert.equal(base.overridden, false);
  assert.ok(base.file.entries.every((e) => e.id && e.tool));
  const sig1 = advisoriesSignature(base.file.entries);
  assert.equal(advisoriesSignature(loadAdvisories().file.entries), sig1, 'stable signature');

  const dir = mkdtempSync(join(tmpdir(), 'vole-adv-'));
  const ov = join(dir, 'advisories.json');
  writeFileSync(
    ov,
    JSON.stringify({ as_of: '2026-09-08', entries: [{ id: 'adv-claude-code-ifs-bypass', tool: 'claude_code', cve: 'CVE-2025-66032', fixed_in: ['1.0.93'], affects_range: '<1.0.93', title: 't', url: null, published: null, class: null, value: 'AKIAIOSFODNN7EXAMPLE' }] }),
  );
  const merged = loadAdvisories(ov);
  assert.equal(merged.overridden, true);
  const overridden = merged.file.entries.find((e) => e.id === 'adv-claude-code-ifs-bypass')!;
  assert.equal(overridden.value, 'AKIAIOSFODNN7EXAMPLE', 'only the admin override carries a value');
  assert.ok(!base.file.entries.some((e) => e.value), 'the shipped table never carries values');
  assert.notEqual(advisoriesSignature(merged.file.entries), sig1);
});

test('range matching: an uncomputable range is NULL, never false, never safe', () => {
  assert.equal(versionCmp('0.1.13', '0.1.14') < 0, true);
  assert.equal(rangeMatches('<0.1.14', '0.1.13'), true);
  assert.equal(rangeMatches('<0.1.14', '0.1.14'), false);
  assert.equal(rangeMatches('=1.84.0', '1.84.0'), true);
  assert.equal(rangeMatches('=1.84.0', '1.84.1'), false);
  assert.equal(rangeMatches(null, '1.0.0'), null, 'no range recorded → uncomputable');
});

function seedVersions(db: DB) {
  const ins = db.prepare(
    "INSERT INTO usage_events (event_key, tool, model, session_id, ts, confidence, is_error, source, observed_at, cli_version) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  ins.run('e1', 'claude_code', 'claude-opus-5', 's1', Date.parse('2026-08-01T00:00:00Z'), 'exact', 0, 'live', Date.parse('2026-08-01T00:00:00Z'), '1.0.92');
  ins.run('e2', 'claude_code', 'claude-opus-5', 's1', Date.parse('2026-08-05T00:00:00Z'), 'exact', 0, 'live', Date.parse('2026-08-05T00:00:00Z'), '1.0.92');
  ins.run('e3', 'claude_code', 'claude-opus-5', 's2', Date.parse('2026-08-10T00:00:00Z'), 'exact', 0, 'live', Date.parse('2026-08-10T00:00:00Z'), '1.0.111');
  ins.run('e4', 'gemini_cli', 'gemini-2', 's3', Date.parse('2026-08-12T00:00:00Z'), 'exact', 0, 'live', Date.parse('2026-08-12T00:00:00Z'), '0.1.13');
  ins.run('e5', 'cursor', 'cursor-a', 's4', Date.parse('2026-08-14T00:00:00Z'), 'exact', 0, 'live', Date.parse('2026-08-14T00:00:00Z'), '2.9.9');
}

test('version residency: exposure intervals per version, left-open at the floor', () => {
  const { db } = store();
  try {
    seedVersions(db);
    const horizon = Date.parse('2026-08-01T00:00:00Z');
    const res = versionResidency(db, horizon);
    const v92 = res.find((r) => r.version === '1.0.92')!;
    assert.equal(v92.tool, 'claude_code');
    assert.equal(v92.sessions, 1);
    assert.equal(v92.left_open, true, 'first-observed at the floor is a left-open band');
    const v111 = res.find((r) => r.version === '1.0.111')!;
    assert.equal(v111.left_open, false);
  } finally {
    resetDbCache();
  }
});

test('advisory exposure: confirmed, cleared, unanswerable, not_seen', () => {
  const { db } = store();
  try {
    seedVersions(db);
    const horizon = Date.parse('2026-08-01T00:00:00Z');
    const res = versionResidency(db, horizon);
    const advisories = loadAdvisories().file.entries;
    const byId = new Map(advisoryExposure(advisories, res, horizon).map((e) => [e.advisory.id, e]));

    const ifs = byId.get('adv-claude-code-ifs-bypass')!;
    assert.equal(ifs.verdict, 'confirmed', '1.0.92 < 1.0.111 was observed');
    assert.equal(ifs.intervals.map((i) => i.version).join(','), '1.0.92');

    const dune = byId.get('adv-cursor-duneslide')!;
    assert.equal(dune.verdict, 'confirmed', '2.9.9 < 3.0 was observed — a direct observation is confirmed even at the floor');

    // Cleared: versions observed, all outside the affected range, none left-open.
    const cleared = advisoryExposure(
      [{ id: 'x', tool: 'cursor', cve: null, fixed_in: ['1.3.9'], affects_range: '<1.3.9', title: 't', url: null, published: null, class: null }],
      res.map((r) => (r.version === '2.9.9' ? { ...r, left_open: false } : r)),
      horizon,
    )[0]!;
    assert.equal(cleared.verdict, 'cleared');

    // Unanswerable: nothing in range observed, but the first observed version
    // sits at the answerable floor — an earlier vulnerable version is invisible.
    const unanswerable = advisoryExposure(
      [{ id: 'z', tool: 'cursor', cve: null, fixed_in: ['1.3.9'], affects_range: '<1.3.9', title: 't', url: null, published: null, class: null }],
      [{ tool: 'cursor', version: '2.9.9', first_seen: horizon, last_seen: horizon + 1, sessions: 1, left_open: true }],
      horizon,
    )[0]!;
    assert.equal(unanswerable.verdict, 'unanswerable');

    const notSeen = advisoryExposure(
      [{ id: 'y', tool: 'opencode', cve: null, fixed_in: ['1'], affects_range: '<1', title: 't', url: null, published: null, class: null }],
      res,
      horizon,
    )[0]!;
    assert.equal(notSeen.verdict, 'not_seen');
    assert.match(notSeen.basis, /no version recorded for opencode/);

    const uncomputable = byId.get('adv-claude-code-project-file-rce')!;
    assert.equal(uncomputable.verdict, 'unanswerable', 'no fixed-in recorded: exposure uncomputable, verdict conservative');
  } finally {
    resetDbCache();
  }
});

test('hunt-time fingerprinting: the value lives in the pack, the store holds only the digest', () => {
  const { db } = store();
  try {
    const EPOCH_MS = 30 * 24 * 3600_000;
    const now = NOW;
    const fp = (value: string, t?: number) =>
      `fp${Math.floor((t ?? now) / EPOCH_MS)}:${Buffer.from(value).toString('hex').slice(0, 32)}`;
    const burned = 'AKIAIOSFODNN7EXAMPLE';
    const t = Date.parse('2026-08-20T00:00:00Z');
    db.prepare(
      "INSERT INTO secret_sightings (fingerprint, detector, sink_key, path, byte_offset, byte_length, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?)",
    ).run(fp(burned, t), 'aws_key', 'transcripts', '/f.jsonl', 10, 20, t, t);
    db.prepare(
      "INSERT INTO secret_sightings (fingerprint, detector, sink_key, path, byte_offset, byte_length, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?)",
    ).run(fp('another-secret', t), 'aws_key', 'transcripts', '/f.jsonl', 100, 20, t, t);

    const advisories = [
      { id: 'a1', tool: 'claude_code', cve: null, fixed_in: [], affects_range: null, title: 't', url: null, published: null, class: null, value: burned },
      { id: 'a2', tool: 'claude_code', cve: null, fixed_in: [], affects_range: null, title: 't', url: null, published: null, class: null, value: 'not-on-disk' },
    ];
    const results = huntFingerprints(db, advisories, fp, now);
    const hit = results.find((r) => r.advisory_id === 'a1')!;
    assert.equal(hit.matches.length, 1);
    assert.equal(hit.matches[0]!.sink_key, 'transcripts');
    assert.equal(hit.matches[0]!.epoch, Math.floor(t / EPOCH_MS), 'the epoch the sighting was minted under');
    assert.match(hit.receipt, /value not stored/);
    const miss = results.find((r) => r.advisory_id === 'a2')!;
    assert.equal(miss.matches.length, 0, 'negative means no fingerprint exists, not that it never leaked');
    assert.equal(JSON.stringify(hit).includes(burned), false, 'the burned value never enters the result');
  } finally {
    resetDbCache();
  }
});
