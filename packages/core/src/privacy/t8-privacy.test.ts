/**
 * Tier 8 lifecycle/privacy tests: the purpose union's guards, the two-pass
 * complementary suppression, the retention classes with the rebuildability
 * gate, the declared lifecycle + activity_after_departure, the freeze, the
 * erasure register, decommission's hold gate, the DSAR/registers, literacy,
 * and the store budget/reclaim measurement.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache, insertEvents, insertAnomalies } from '../db';
import type { DB } from '../db';
import type { UsageEvent } from '../types';
import {
  where, assertColumnsAllowed, assertGroupByAllowed, PURPOSE_SPECS,
} from './purposes';
import { toGrid, twoPassSuppression, policyK, dailyRollup } from './kanon';
import { loadRetentionPolicy, prunePass, rawRefRebuildable } from './retention';
import { measureStoreBudget, measuredReclaim, dbstatAvailable } from './store-budget';
import {
  declareLifecycle, stateAt, activityAfterDeparture, freezeEvidence,
  buildDeparturePack, departureDelta, scopeDiff,
} from './departure';
import { forgetSubject, isSubjectErased, erasureRegister, art19Report, decommission, loadLegalHold } from './forget';
import { processingRegister, recipientsAnswer, buildDsar, worksCouncilPack } from './register';
import { literacyRecord, parseTrainingCsv, withTraining } from './literacy';

let dir = '';
let db: DB;
const NOW = Date.parse('2026-09-07T12:00:00Z');
const DAY = 86_400_000;

function ev(over: Partial<UsageEvent> & Pick<UsageEvent, 'event_key' | 'ts'>): UsageEvent {
  return {
    tool: 'claude_code', model: 'claude-opus-5', session_id: 's1', project: '/w/repo',
    git_branch: 'main', input_tokens: 5, output_tokens: 10, cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0, total_tokens: 15,
    cost_usd: null, confidence: 'exact', is_error: 0, stop_reason: null, source: 'live',
    raw_ref: null, tools: null, agent_id: null, context_window: null,
    duration_ms: null, duration_kind: null, ...over,
  } as UsageEvent;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vole-t8-'));
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

// ── purposes ─────────────────────────────────────────────────────────────────

test('purposes: the union is closed and the builder defaults to live-only', () => {
  assert.equal(new Set(['security_incident', 'cost_allocation', 'capacity', 'self_view', 'dsar']).size, 5);
  for (const p of Object.keys(PURPOSE_SPECS) as (keyof typeof PURPOSE_SPECS)[]) {
    assert.equal(p, PURPOSE_SPECS[p]!.purpose, 'every spec carries its own purpose');
  }
  const w = where('capacity', { from: 100, to: 200, tool: 'claude_code' });
  assert.equal(w.clause, "source = 'live' AND ts >= :where_from AND ts < :where_to AND tool = :where_tool");
  assert.deepEqual(w.params, { where_from: 100, where_to: 200, where_tool: 'claude_code' });
  const withSeed = where('dsar', { includeSeed: true });
  assert.match(withSeed.clause, /source IN \('live', 'seed'\)/);
});

test('purposes: subject columns are denied to cost_allocation/capacity, allowed to dsar', () => {
  assert.throws(() => assertColumnsAllowed('cost_allocation', ['tool', 'user']));
  assert.throws(() => where('capacity', { user: 'x' } as never));
  assert.doesNotThrow(() => assertColumnsAllowed('dsar', ['user', 'machine', 'subject_id']));
  assert.throws(() => assertGroupByAllowed('cost_allocation', ['user']));
  assert.doesNotThrow(() => assertGroupByAllowed('security_incident', ['user']));
  assert.throws(() => assertColumnsAllowed('security_incident', ['made_up_column']));
});

// ── k-anonymity ──────────────────────────────────────────────────────────────

test('kanon: a single suppressed cell gets complementary suppression and margins are protected', () => {
  // Row [1, 9]: the 1 is primary-suppressed (k=5); a row with exactly one
  // suppressed cell is derivable from the margin, so the 9 goes too.
  const r = twoPassSuppression([[1, 9]], 5);
  assert.equal(r.primary, 1);
  assert.equal(r.complementary, 1);
  assert.ok(r.suppressed[0]![0]! && r.suppressed[0]![1]!, 'both cells suppressed');
  // Column [1, 9] also has exactly one suppressed cell after the row pass —
  // the column margin must be withheld, not published.
  assert.ok(r.rowMargins.every((m) => m === null || m > 0));
  const r2 = twoPassSuppression([[1, 9], [7, 8]], 5);
  // With two rows the single suppressed cell in column 0 forces another.
  const col0 = r2.suppressed.map((row) => row[0]);
  assert.ok(col0.filter(Boolean).length !== 1, `column 0 must not have exactly one suppressed cell (${col0})`);
});

test('kanon: nothing suppressed when all cells >= k', () => {
  const r = twoPassSuppression([[10, 20], [30, 40]], 5);
  assert.equal(r.primary, 0);
  assert.equal(r.complementary, 0);
  assert.equal(r.grandTotal, 100);
  assert.deepEqual(r.rowMargins, [30, 70]);
});

test('kanon: k from policy, distinct subjects, deterministic grid', () => {
  assert.equal(policyK(null), 5);
  assert.equal(policyK({ k: 11 }), 11);
  assert.equal(policyK({ k: 1 }), 5, 'k < 2 is not a k');
  insertEvents(db, [
    ev({ event_key: 'k1', ts: NOW, session_id: 's1', total_tokens: 15 }),
    ev({ event_key: 'k2', ts: NOW, session_id: 's2', total_tokens: 15 }),
  ]);
  db.prepare(`UPDATE usage_events SET subject_id = 'p:a' WHERE event_key = 'k1'`).run();
  db.prepare(`UPDATE usage_events SET subject_id = 'p:b' WHERE event_key = 'k2'`).run();
  const cells = dailyRollup(db, NOW - DAY, NOW + DAY);
  const grid = toGrid(cells);
  assert.equal(grid.values[0]![0], 2, 'two distinct subjects, not two calls');
});

// ── retention ───────────────────────────────────────────────────────────────

test('retention: prune refuses rows whose source is gone and receipts the rest', () => {
  const keep = join(dir, 'alive.jsonl');
  writeFileSync(keep, 'x');
  insertEvents(db, [
    ev({ event_key: 'r1', ts: NOW - 100 * DAY, raw_ref: keep }), // rebuildable → pruned
    ev({ event_key: 'r2', ts: NOW - 100 * DAY, raw_ref: join(dir, 'gone.jsonl') }), // refused
    ev({ event_key: 'r3', ts: NOW - 100 * DAY, raw_ref: null }), // refused
    ev({ event_key: 'r4', ts: NOW - 1 * DAY, raw_ref: keep }), // in window → kept
  ]);
  assert.equal(rawRefRebuildable(keep), true);
  assert.equal(rawRefRebuildable(join(dir, 'gone.jsonl')), false);
  assert.equal(rawRefRebuildable(null), false);
  const policy = loadRetentionPolicy([join(dir, 'none.json')]);
  const behavioural = policy.classes.find((c) => c.class === 'behavioural')!;
  assert.equal(behavioural.days, 90);
  const dry = prunePass(db, policy, { apply: false, now: NOW });
  const usageResult = dry.results.find((r) => r.table === 'usage_events')!;
  assert.equal(usageResult.refused_rows, 2, 'r2 and r3 held back');
  assert.equal(usageResult.deleted_rows, 0, 'dry run deletes nothing');
  const wet = prunePass(db, policy, { apply: true, now: NOW });
  const wetUsage = wet.results.find((r) => r.table === 'usage_events')!;
  assert.equal(wetUsage.deleted_rows, 1, 'only the rebuildable row goes');
  assert.equal(wet.receipts.length, wet.results.filter((r) => r.deleted_rows > 0).length, 'a receipt per table that deleted');
  const receipts = db.prepare(`SELECT table_name, deleted_rows FROM store_prunes`).all() as { table_name: string; deleted_rows: number }[];
  assert.ok(receipts.some((r) => r.table_name === 'usage_events' && r.deleted_rows === 1));
  const left = db.prepare(`SELECT COUNT(*) AS n FROM usage_events`).get() as { n: number };
  assert.equal(left.n, 3, 'r2, r3, r4 remain');
});

test('retention: a declared floor below the configured value refuses the incident class', () => {
  mkdirSync(join(dir, '.vole', 'policy'), { recursive: true });
  writeFileSync(
    join(dir, '.vole', 'policy', 'policy.json'),
    JSON.stringify({ retention: { classes: { incident_evidence: { days: 30, floor_days: 180 } } } }),
  );
  insertAnomalies(db, [{
    anomaly_key: 'x', rule: 'error_storm', severity: 'warn', tool: 'claude_code', session_id: 's',
    model: null, window_start: NOW - 200 * DAY, window_end: NOW - 199 * DAY, title: 't', detail: 'd',
    observed: 1, baseline: null, threshold: null, confidence: 'exact', source: 'live', detected_at: NOW,
  }]);
  const policy = loadRetentionPolicy([join(dir, '.vole', 'policy', 'policy.json')]);
  const cls = policy.classes.find((c) => c.class === 'incident_evidence')!;
  assert.equal(cls.days, 30);
  assert.equal(cls.floor_days, 180);
  const pass = prunePass(db, policy, { apply: true, now: NOW });
  const anomalies = pass.results.find((r) => r.table === 'anomalies')!;
  assert.equal(anomalies.refused_rows, 1, 'the floor protects the evidence');
  assert.equal(anomalies.deleted_rows, 0);
  assert.match(anomalies.refused_reason!, /floor 180d exceeds configured 30d/);
});

// ── lifecycle + activity_after_departure ─────────────────────────────────────

test('lifecycle: declarations are append-only, idempotent, and stateAt is a query not a column', () => {
  const from1 = NOW - 10 * DAY;
  const from2 = NOW - 2 * DAY;
  assert.equal(declareLifecycle(db, { principal_key: 'p:x', state: 'active', effective_from: from1, declared_by: 'hr', basis: 'test' }, NOW), 1);
  assert.equal(declareLifecycle(db, { principal_key: 'p:x', state: 'active', effective_from: from1, declared_by: 'hr', basis: 'test' }, NOW), 0, 'same tuple is a no-op');
  declareLifecycle(db, { principal_key: 'p:x', state: 'departed', effective_from: from2, declared_by: 'hr', basis: 'exit interview' }, NOW);
  const at = stateAt(db, 'p:x', NOW - 5 * DAY);
  assert.equal(at?.state, 'active', 'the state at a past instant is the earlier declaration');
  assert.equal(stateAt(db, 'p:x', NOW)?.state, 'departed');
  assert.equal(stateAt(db, 'p:y', NOW), null, 'no declaration, no state — never inferred');
});

test('activity_after_departure: fires only for departed, only on live rows after effective_from, deterministic keys', () => {
  const departedAt = NOW - 3 * DAY;
  declareLifecycle(db, { principal_key: 'p:x', state: 'departed', effective_from: departedAt, declared_by: 'hr', basis: 'test' }, NOW);
  db.prepare(`INSERT INTO session_identity (session_id, principal_key, binding_evidence, first_seen, last_seen) VALUES ('s-x', 'p:x', 'store_origin', ?, ?)`).run(NOW - 30 * DAY, NOW);
  const day = Math.floor((NOW - DAY) / DAY);
  insertEvents(db, [
    ev({ event_key: 'a1', ts: NOW - DAY, session_id: 's-x', tool: 'claude_code' }), // after departure → fires
    ev({ event_key: 'a2', ts: NOW - 5 * DAY, session_id: 's-x', tool: 'claude_code' }), // before → no
    ev({ event_key: 'a3', ts: NOW - DAY, session_id: 's-x', tool: 'claude_code', source: 'seed' }), // seed → no
    ev({ event_key: 'a4', ts: NOW - DAY, session_id: 'other', tool: 'grok' }), // unbound → no
  ]);
  const anomalies = activityAfterDeparture(db, NOW);
  assert.equal(anomalies.length, 1);
  const a = anomalies[0]!;
  assert.equal(a.rule, 'activity_after_departure');
  assert.equal(a.anomaly_key, `live:activity_after_departure:p:x:${day}:claude_code`);
  assert.equal(a.observed, 1);
  assert.equal(a.threshold, 0);
  assert.equal(a.baseline, 1, 'rows in the seven days before the declaration');
  assert.ok(!a.anomaly_key.includes(String(NOW)), 'no now()-derived value in the key');
  // Idempotent through the real writer.
  assert.equal(insertAnomalies(db, anomalies).inserted.length, 1);
  assert.equal(insertAnomalies(db, activityAfterDeparture(db, NOW)).inserted.length, 0);
  // No departure, no rule — silence is never departure.
  declareLifecycle(db, { principal_key: 'p:z', state: 'active', effective_from: NOW - 30 * DAY }, NOW);
  assert.equal(activityAfterDeparture(db, NOW).filter((x) => x.anomaly_key.includes('p:z')).length, 0);
});

// ── evidence freeze ─────────────────────────────────────────────────────────

test('freeze: hashes present sources, marks gone ones, is idempotent, never rewrites', () => {
  declareLifecycle(db, { principal_key: 'p:x', state: 'departed', effective_from: NOW - DAY, declared_by: 'hr', basis: 'b' }, NOW);
  db.prepare(`INSERT INTO session_identity (session_id, principal_key, binding_evidence, first_seen, last_seen) VALUES ('s-x', 'p:x', 'store_origin', ?, ?)`).run(NOW - 30 * DAY, NOW);
  const alive = join(dir, 'transcript.jsonl');
  writeFileSync(alive, '{"a":1}');
  insertEvents(db, [
    ev({ event_key: 'f1', ts: NOW - 2 * DAY, session_id: 's-x', raw_ref: alive }),
    ev({ event_key: 'f2', ts: NOW - 2 * DAY, session_id: 's-x', raw_ref: join(dir, 'pruned.jsonl') }),
  ]);
  const r1 = freezeEvidence(db, 'p:x', NOW - 3 * DAY, NOW);
  assert.equal(r1.paths, 2);
  assert.equal(r1.hashed, 1);
  assert.equal(r1.already_gone, 1);
  const rows = db.prepare(`SELECT path, present, sha256, reason FROM evidence_freeze ORDER BY path`).all() as { path: string; present: number; sha256: string | null; reason: string | null }[];
  const aliveRow = rows.find((x) => x.path === alive)!;
  assert.equal(aliveRow.present, 1);
  assert.match(aliveRow.sha256!, /^sha256:[0-9a-f]{64}$/);
  const goneRow = rows.find((x) => x.path.includes('pruned'))!;
  assert.equal(goneRow.present, 0);
  assert.equal(goneRow.sha256, null);
  assert.equal(goneRow.reason, 'source deleted');
  // Re-run appends nothing and rewrites nothing.
  freezeEvidence(db, 'p:x', NOW - 3 * DAY, NOW);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM evidence_freeze`).get() as { n: number }).n, 2);
});

// ── departure pack + delta ───────────────────────────────────────────────────

test('departure pack: sections carry denominators, not-covered is named, delta is purpose-gated', () => {
  declareLifecycle(db, { principal_key: 'p:x', state: 'departed', effective_from: NOW - DAY, declared_by: 'hr', basis: 'b' }, NOW);
  db.prepare(`INSERT INTO session_identity (session_id, principal_key, binding_evidence, first_seen, last_seen) VALUES ('s-x', 'p:x', 'store_origin', ?, ?)`).run(NOW - 30 * DAY, NOW);
  insertEvents(db, [ev({ event_key: 'p1', ts: NOW - 2 * DAY, session_id: 's-x' })]);
  const pack = buildDeparturePack(db, { principalKey: 'p:x', windowDays: 30, basis: 'exit', now: NOW });
  const usage = pack.sections.find((s) => s.section === 'usage_events')!;
  assert.equal(usage.rows_in_window, 1);
  assert.equal(usage.total_rows, 1);
  assert.ok(pack.not_covered.length >= 3);
  assert.match(pack.chain_head, /^sha256:/);
  // Delta refuses when coverage is below the floor: no collector_runs at all.
  const delta = departureDelta(db, 'p:x', NOW, { floor: 0.7 });
  assert.match((delta as { refused: string }).refused, /coverage below the pack's floor/);
  // An undeclared principal never gets a delta.
  const none = departureDelta(db, 'p:none', NOW);
  assert.match((none as { refused: string }).refused, /purpose-gated/);
});

test('scope diff: kept/added/removed/residual with the granting file as evidence', () => {
  const from = NOW - 10 * DAY;
  db.prepare(`INSERT INTO session_identity (session_id, principal_key, binding_evidence, first_seen, last_seen) VALUES ('sx', 'p:x', 'store_origin', ?, ?)`).run(from - 20 * DAY, NOW);
  db.prepare(
    `INSERT INTO grants (grant_key, agent, source_file, kind, entry, first_seen, last_seen) VALUES (?, 'claude_code', '/w/.claude/settings.json', 'allow', 'Bash(*)', ?, ?)`,
  ).run('g1', from - 20 * DAY, NOW);
  db.prepare(
    `INSERT INTO grants (grant_key, agent, source_file, kind, entry, first_seen, last_seen) VALUES (?, 'claude_code', '/w/.claude/settings.json', 'allow', 'Read(*)', ?, ?)`,
  ).run('g2', NOW - 5 * DAY, NOW);
  insertEvents(db, [
    ev({ event_key: 'sd1', ts: from - 5 * DAY, project: '/w/old-repo', session_id: 'sx' }),
    ev({ event_key: 'sd2', ts: NOW - DAY, project: '/w/new-repo', session_id: 'sx' }),
  ]);
  const rows = scopeDiff(db, 'p:x', from, { now: NOW });
  const projects = rows.filter((r) => r.dimension === 'project');
  assert.deepEqual(
    projects.map((r) => [r.value, r.state]).sort(),
    [['/w/new-repo', 'added'], ['/w/old-repo', 'removed']],
  );
  const g1 = rows.find((r) => r.dimension === 'grant' && r.value === 'g1')!;
  assert.equal(g1.state, 'residual', 'a grant declared before the move that no declaration removed is residual reach');
  assert.equal(g1.evidence, '/w/.claude/settings.json');
  const g2 = rows.find((r) => r.dimension === 'grant' && r.value === 'g2')!;
  assert.equal(g2.state, 'added');
});

// ── erasure + Art. 19 + decommission ─────────────────────────────────────────

test('forget: deletes the subject, writes the register, and the register survives re-reads', () => {
  db.prepare(`INSERT INTO session_identity (session_id, principal_key, binding_evidence, first_seen, last_seen) VALUES ('s-x', 'p:x', 'store_origin', ?, ?)`).run(NOW - 30 * DAY, NOW);
  insertEvents(db, [
    ev({ event_key: 'd1', ts: NOW - DAY, session_id: 's-x' }),
    ev({ event_key: 'd2', ts: NOW - DAY, session_id: 's-other' }),
  ]);
  db.prepare(`UPDATE usage_events SET subject_id = 'p:x' WHERE event_key = 'd1'`).run();
  const result = forgetSubject(db, 'p:x', { now: NOW });
  assert.ok(result.total_rows >= 2, 'usage_events + session_identity at minimum');
  const left = db.prepare(`SELECT event_key FROM usage_events ORDER BY event_key`).all() as { event_key: string }[];
  assert.deepEqual(left.map((l) => l.event_key), ['d2'], 'only the other subject survives');
  assert.equal(isSubjectErased(db, 'p:x'), true);
  assert.equal(isSubjectErased(db, 'p:other'), false);
  const reg = erasureRegister(db);
  assert.equal(reg.length, 1);
  assert.equal(reg[0]!.kind, 'erasure');
  assert.equal(reg[0]!.entry_id, 'p:x');
  // The register entry is distinct from the rule-off suppression register.
  assert.notEqual(reg[0]!.rule, 'error_storm');
});

test('art19: sent sinks cannot be recalled, pending ones can, and the limits are stated', () => {
  db.prepare(`INSERT INTO export_outbox (sink, doc_id, state, created_at) VALUES ('otlp', 'a', 'sent', ?), ('otlp', 'b', 'pending', ?)`).run(NOW - DAY, NOW);
  const before = art19Report(db, { now: NOW });
  const sent = before.sinks.find((s) => s.sink === 'otlp')!;
  assert.equal(sent.recall, 'nothing_pending');
  const recalled = art19Report(db, { recallPending: true, now: NOW });
  assert.equal(recalled.sinks[0]!.recall, 'recalled');
  assert.ok(recalled.limits.length >= 3);
  assert.ok(recalled.limits.some((l) => l.includes('cannot be recalled')));
});

test('decommission: seal hashes the archive, attest matches, erase blocked by a named hold', () => {
  db.prepare(`INSERT INTO session_identity (session_id, principal_key, binding_evidence, first_seen, last_seen) VALUES ('s-x', 'p:x', 'store_origin', ?, ?)`).run(NOW - 30 * DAY, NOW);
  insertEvents(db, [ev({ event_key: 'c1', ts: NOW - DAY, session_id: 's-x' })]);
  const out = join(dir, 'archive.json');
  const receipt = decommission(db, 'p:x', out, { now: NOW });
  assert.equal(receipt.attest.matches_seal, true);
  assert.equal(receipt.attest.store_epoch_id, null, 'no epoch stamped on a fresh test store');
  assert.ok(receipt.erase.register_entry !== null);
  assert.ok(receipt.sources_still_holding_data.length >= 3);
  // Now with a hold: the erase gate is blocked and names its declarer.
  rmSync(out);
  mkdirSync(join(dir, '.vole', 'policy'), { recursive: true });
  writeFileSync(join(dir, '.vole', 'policy', 'policy.json'), JSON.stringify({ legal_hold: { active: true, declared_by: 'legal', expires_at: NOW + DAY } }));
  const held = decommission(db, 'p:q', out, { now: NOW });
  assert.equal(held.erase.blocked_by_hold, true);
  assert.equal(held.erase.hold?.declared_by, 'legal');
  assert.equal(loadLegalHold(undefined, NOW).active, true);
  assert.equal(loadLegalHold(undefined, NOW + 2 * DAY).active, false, 'an expired hold no longer blocks');
});

// ── registers + DSAR + literacy ──────────────────────────────────────────────

test('art30 + recipients: unresolved recipients are counted in the header, never dropped', () => {
  db.prepare(`INSERT INTO terms_basis (surface_key, basis, source, first_seen, last_seen) VALUES ('cli:grok', 'free', 'seed', ?, ?)`).run(NOW - DAY, NOW);
  db.prepare(`INSERT INTO recipient_state (surface_key, state, evidence_ref, first_seen, last_seen) VALUES ('cli:grok', 'us-east', 'x', ?, ?)`).run(NOW - DAY, NOW);
  db.prepare(`INSERT INTO terms_basis (surface_key, basis, source, first_seen, last_seen) VALUES ('cli:mystery', 'x', 'seed', ?, ?)`).run(NOW - DAY, NOW);
  const reg = processingRegister(db);
  assert.equal(reg.rows.length, 2);
  assert.equal(reg.unresolved_recipients, 1);
  const grok = reg.rows.find((r) => r.surface_key === 'cli:grok')!;
  assert.equal(grok.recipient_state, 'us-east');
  assert.equal(grok.third_country, 'unknown');
  const mystery = reg.rows.find((r) => r.surface_key === 'cli:mystery')!;
  assert.equal(mystery.recipient_state, null);
  db.prepare(`UPDATE usage_events SET subject_id = 'p:x' WHERE 1=0`).run();
  const answer = recipientsAnswer(db, 'p:x');
  assert.match(answer.answer, /no resolved recipient|unresolved/i);
});

test('dsar: the logic statement carries the three figures; unstamped thresholds are labelled', () => {
  db.prepare(`INSERT INTO session_identity (session_id, principal_key, binding_evidence, first_seen, last_seen) VALUES ('s-x', 'p:x', 'store_origin', ?, ?)`).run(NOW - 30 * DAY, NOW);
  insertEvents(db, [ev({ event_key: 'q1', ts: NOW - DAY, session_id: 's-x' })]);
  insertAnomalies(db, [{
    anomaly_key: 'q', rule: 'error_storm', severity: 'warn', tool: 'claude_code', session_id: 's-x',
    model: null, window_start: NOW - DAY, window_end: NOW, title: 't', detail: 'd',
    observed: 14, baseline: 3, threshold: 10, confidence: 'exact', source: 'live', detected_at: NOW,
  }]);
  insertAnomalies(db, [{
    anomaly_key: 'q-legacy', rule: 'repeat_call_loop', severity: 'warn', tool: 'claude_code', session_id: 's-x',
    model: null, window_start: NOW - DAY, window_end: NOW, title: 't', detail: 'd',
    observed: 5, baseline: null, threshold: null, confidence: 'exact', source: 'live', detected_at: NOW,
  }]);
  const doc = buildDsar(db, { principalKey: 'p:x', now: NOW });
  assert.equal(doc.data_held.sessions, 1);
  const storm = doc.logic.rules.find((r) => r.rule === 'error_storm')!;
  assert.deepEqual([storm.observed, storm.baseline, storm.threshold], [14, 3, 10]);
  const legacy = doc.logic.rules.find((r) => r.rule === 'repeat_call_loop')!;
  assert.equal(legacy.thresholds_not_recorded_at_detection_time, true);
  assert.ok(doc.retention.classes.some((c) => c.class === 'behavioural'));
});

test('works-council pack: measured facts only — rows, non-NULL rates, the collector footprint', () => {
  insertEvents(db, [ev({ event_key: 'w1', ts: NOW - DAY, session_id: 's', model: null })]);
  const pack = worksCouncilPack(db, { now: NOW });
  assert.equal(pack.scope.startsWith('one endpoint'), true);
  const usage = pack.fact_tables.find((t) => t.table === 'usage_events')!;
  assert.equal(usage.rows, 1);
  const modelCol = usage.columns.find((c) => c.column === 'model')!;
  assert.equal(modelCol.non_null, 0);
  assert.equal(modelCol.rate, 0);
  assert.ok(pack.personal_data_fields >= 0 && pack.exported_fields_total >= pack.personal_data_fields);
  assert.match(pack.co_determination_note, /co-determination/);
});

test('literacy: per-subject DISTINCT (tool, model) with MIN/MAX ts and session counts; training is imported', () => {
  db.prepare(`INSERT INTO session_identity (session_id, principal_key, binding_evidence, first_seen, last_seen) VALUES ('s1', 'p:x', 'store_origin', ?, ?)`).run(NOW - 30 * DAY, NOW);
  insertEvents(db, [
    ev({ event_key: 'l1', ts: NOW - 20 * DAY, session_id: 's1', model: 'm-a' }),
    ev({ event_key: 'l2', ts: NOW - 5 * DAY, session_id: 's1', model: 'm-a' }),
    ev({ event_key: 'l3', ts: NOW - 3 * DAY, session_id: 's1', model: 'm-b' }),
    ev({ event_key: 'l4', ts: NOW - DAY, session_id: 's-other', model: 'm-a' }),
  ]);
  const rows = literacyRecord(db, { principalKey: 'p:x' });
  assert.equal(rows.length, 2, 'distinct (tool, model) pairs for the subject only');
  const ma = rows.find((r) => r.model === 'm-a')!;
  assert.equal(ma.first_seen, NOW - 20 * DAY);
  assert.equal(ma.last_seen, NOW - 5 * DAY);
  assert.equal(ma.sessions, 1);
  const training = parseTrainingCsv('tool,completed_at\nclaude_code,2026-08-15\ncodex,not-a-date\n');
  assert.deepEqual(training, [
    { tool: 'claude_code', completed_at: Date.parse('2026-08-15') },
    { tool: 'codex', completed_at: null },
  ]);
  const joined = withTraining(rows, training, 'org.csv');
  assert.equal(joined.find((r) => r.tool === 'claude_code')!.training_completed_at, Date.parse('2026-08-15'));
  assert.equal(joined.find((r) => r.tool === 'claude_code')!.training_source, 'org.csv');
});

// ── store budget + reclaim ───────────────────────────────────────────────────

test('store budget: measured per object, written to the table, dbstat probed not assumed', () => {
  insertEvents(db, [ev({ event_key: 'b1', ts: NOW - DAY, session_id: 's' })]);
  const { rows, dbstat } = measureStoreBudget(db, NOW);
  assert.equal(typeof dbstat, 'boolean');
  const usage = rows.find((r) => r.object === 'usage_events')!;
  assert.equal(usage.kind, 'table');
  assert.equal(usage.rows, 1);
  if (dbstat) {
    assert.ok((usage.bytes ?? 0) > 0, 'dbstat present: bytes are measured');
    assert.ok((usage.bytes_per_row ?? 0) > 0);
  } else {
    assert.equal(usage.bytes, null, 'no dbstat: NULL, never estimated');
  }
  const stored = db.prepare(`SELECT COUNT(*) AS n FROM store_budget`).get() as { n: number };
  assert.ok(stored.n >= 1);
});

test('measured reclaim: scratch copy measures the delta; a small store stays under the threshold', () => {
  const result = measuredReclaim(db, join(dir, 'vole.db'), { thresholdBytes: 2 ** 30, apply: true });
  assert.equal(result.state, 'measured', 'delta below the threshold: the in-place VACUUM is the decision');
  assert.equal(result.applied, false);
  assert.equal(typeof result.reclaimable_bytes, 'number', 'the observed delta, never a rule of thumb');
  assert.equal(readdirSync(dir).some((f) => f.includes('reclaim-probe')), false, 'the scratch copy is deleted');
});
