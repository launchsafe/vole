/**
 * Tier 7 triage tests: case identity, the disposition ledger (spool, cursor,
 * denormalisation), control intents, detection quality, MTTA/MTTR, the noise
 * budget, custody (gaps, orphans, sentence), the answer sheet and the
 * human-confirmed handoff.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache, insertAnomalies } from '../db';
import type { DB } from '../db';
import type { Anomaly } from '../types';
import {
  caseKeyOf, applyCaseIdentity, validateAction, spoolAction, ingestActions, actionsCursor,
  setActionsCursor, denormaliseState, backfillActionCaseKeys, renderDetail, detailKeyOf,
} from './case';
import {
  recordIntent, sweepIntents, applyIntentSweep, readPidSession, INTENT_CONSUMERS,
} from './control-intents';
import { ruleQuality, mttaMttr } from './quality';
import { isoWeek, machineHash, noiseBudgetRows, loadNoiseBudget } from './noise';
import { deriveEvidenceGaps, classifyOrphans, custodySentence, custodyFigures, recordOrphans } from './custody';
import { recordHuntRun, latestHunt, answerSheet } from './answer-sheet';
import { handoffPayload, sendHandoff, incidentFigures } from './handoff';

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
  dir = mkdtempSync(join(tmpdir(), 'vole-t7-'));
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

// ── case identity ─────────────────────────────────────────────────────────────

test('case_key: same subject across buckets is one case; the bucket never enters it', () => {
  const a = caseKeyOf({ anomaly_key: 'live:billable_burn_spike:claude_code:claude-opus-5:s1:1788000000000', rule: 'billable_burn_spike', source: 'live' });
  const b = caseKeyOf({ anomaly_key: 'live:billable_burn_spike:claude_code:claude-opus-5:s2:1788000600000', rule: 'billable_burn_spike', source: 'live' });
  assert.equal(a, b); // session dropped: it is evs[0], not the case owner
  const c = caseKeyOf({ anomaly_key: 'live:billable_burn_spike:claude_code:claude-sonnet-5:s1:1788000000000', rule: 'billable_burn_spike', source: 'live' });
  assert.notEqual(a, c); // a different model is a different case
});

test('case_key: loop rules keep session+agent dims; non-bucketed rules are their own case', () => {
  const a = caseKeyOf({ anomaly_key: 'live:repeat_call_loop:claude_code:s1:agent-1:1788000000000', rule: 'repeat_call_loop', source: 'live' });
  const b = caseKeyOf({ anomaly_key: 'live:repeat_call_loop:claude_code:s1:agent-1:1788000600000', rule: 'repeat_call_loop', source: 'live' });
  assert.equal(a, b);
  const k = caseKeyOf({ anomaly_key: 'live:remote_execution:claude_code:tc-123', rule: 'remote_execution', source: 'live' });
  assert.equal(k, 'live:remote_execution:claude_code:tc-123');
});

test('applyCaseIdentity stamps NULL rows once and never overwrites', () => {
  insertAnomalies(db, [anomaly({ anomaly_key: 'live:billable_burn_spike:claude_code:claude-opus-5:s1:1', rule: 'billable_burn_spike' })]);
  assert.equal(applyCaseIdentity(db), 1);
  const row = db.prepare('SELECT case_key, detail_key, detail_params FROM anomalies').get() as { case_key: string; detail_key: string; detail_params: string };
  assert.equal(row.case_key, 'live:billable_burn_spike:claude_code:claude-opus-5');
  assert.equal(row.detail_key, 'burn_spike');
  assert.equal(applyCaseIdentity(db), 0); // nothing left to stamp
});

test('structured detail: key + params render the sentence', () => {
  assert.equal(detailKeyOf('billable_burn_spike'), 'burn_spike');
  const s = renderDetail('burn_spike', { observed: 36751, baseline: 12149, multiple: '3.0x' });
  assert.ok(s.includes('36751') && s.includes('12149'));
  assert.ok(renderDetail('burn_spike', { baseline: null }).includes('—')); // NULL renders as unknown
});

// ── the disposition ledger ───────────────────────────────────────────────────

test('a mute without an expiry is rejected, at the spool and at ingest', () => {
  assert.ok(validateAction({ action_id: '', anomaly_key: 'k', state: 'muted', ts: 1 }));
  assert.equal(validateAction({ action_id: '', anomaly_key: 'k', state: 'muted', expires_at: 2, ts: 1 }), null);
  let threw: Error | null = null;
  try {
    spoolAction({ anomaly_key: 'k', state: 'muted', ts: 1 });
  } catch (e) {
    threw = e as Error;
  }
  assert.ok(threw);
  assert.match(threw.message, /expires_at/);
});

test('spool -> ingest: idempotent, cursor byte-exact over non-ASCII, partial lines left for the next pass', () => {
  const dbPath = join(dir, 'vole.db');
  spoolAction({ anomaly_key: 'k1', state: 'acknowledged', actor: 'shiva', ts: 1 }, dbPath);
  spoolAction({ anomaly_key: 'k2', state: 'resolved', actor: 'shiva', note: 'résumé ✓', ts: 2 }, dbPath);
  const r1 = ingestActions(db, 0, dbPath, 100);
  assert.equal(r1.ingested, 2);
  const r2 = ingestActions(db, r1.offset, dbPath, 200);
  assert.equal(r2.ingested, 0);
  assert.equal(r2.offset, r1.offset);

  // A partial trailing line (crash mid-write) must not advance the cursor past itself.
  appendFileSync(join(dir, 'inbox', 'actions.jsonl'), '{"anomaly_key":"k3","state":"reopened"');
  const r3 = ingestActions(db, r1.offset, dbPath, 300);
  assert.equal(r3.ingested, 0);
  const fileLen = readFileSync(join(dir, 'inbox', 'actions.jsonl')).length;
  assert.ok(r3.offset < fileLen);

  // The cursor persists and resumes: complete the line, ingest from the stored cursor.
  setActionsCursor(db, r3.offset, dbPath);
  appendFileSync(join(dir, 'inbox', 'actions.jsonl'), ',"ts":3,"action_id":"fa:xyz"}\n');
  const r4 = ingestActions(db, actionsCursor(db, dbPath), dbPath, 400);
  assert.equal(r4.ingested, 1);
  assert.equal(r4.offset, readFileSync(join(dir, 'inbox', 'actions.jsonl')).length);
});

test('denormaliseState: the latest action per case wins, and replay changes nothing', () => {
  insertAnomalies(db, [anomaly({ anomaly_key: 'live:billable_burn_spike:claude_code:claude-opus-5:s1:1', rule: 'billable_burn_spike' })]);
  applyCaseIdentity(db);
  const ins = db.prepare(
    'INSERT INTO finding_actions (action_id, case_key, anomaly_key, action, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  ins.run('fa:1', 'live:billable_burn_spike:claude_code:claude-opus-5', 'live:billable_burn_spike:claude_code:claude-opus-5:s1:1', 'acknowledged', 'alice', 10);
  ins.run('fa:2', 'live:billable_burn_spike:claude_code:claude-opus-5', 'live:billable_burn_spike:claude_code:claude-opus-5:s1:1', 'resolved', 'bob', 20);
  assert.equal(denormaliseState(db), 1); // one anomaly row, its LATEST action applied once
  const row = db.prepare('SELECT state, state_ts, state_actor FROM anomalies').get() as { state: string; state_ts: number; state_actor: string };
  assert.equal(row.state, 'resolved');
  assert.equal(row.state_ts, 20);
  assert.equal(row.state_actor, 'bob');
  assert.equal(denormaliseState(db), 0); // converged
  // A machine transition never overwrites a newer human label.
  ins.run('fa:3', 'live:billable_burn_spike:claude_code:claude-opus-5', 'live:billable_burn_spike:claude_code:claude-opus-5:s1:1', 'reopened', 'app', 15);
  assert.equal(denormaliseState(db), 0); // older ts than the stored state_ts
});

test('backfillActionCaseKeys fills older ledger rows from their anomaly', () => {
  insertAnomalies(db, [anomaly({ anomaly_key: 'live:remote_execution:claude_code:tc-1', rule: 'remote_execution' })]);
  applyCaseIdentity(db);
  db.prepare(
    "INSERT INTO finding_actions (anomaly_key, action, actor, created_at) VALUES ('live:remote_execution:claude_code:tc-1', 'acknowledged', 'a', 1)",
  ).run();
  assert.equal(backfillActionCaseKeys(db), 1);
  const r = db.prepare('SELECT case_key FROM finding_actions').get() as { case_key: string };
  assert.equal(r.case_key, 'live:remote_execution:claude_code:tc-1');
});

// ── control intents ───────────────────────────────────────────────────────────

test('an intent records a REQUEST; the exact-PID gate never guesses', () => {
  mkdirSync(join(dir, '.claude', 'sessions'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: 's-yes', startedAt: 5 }));
  writeFileSync(join(dir, '.claude', 'sessions', '9999.json'), JSON.stringify({ pid: 1111, sessionId: 's-wrong' }));
  assert.ok(readPidSession(4242));
  assert.equal(readPidSession(9999), null); // pid mismatch: present but not exact
  assert.equal(readPidSession(1), null);

  const a = recordIntent(db, { intent: 'pause_session', session_id: 's1', pid: 4242, actor: 'alice', requested_at: 1, expires_at: 100, tool: 'claude_code' });
  assert.equal(a.inserted, true);
  const b = recordIntent(db, { intent: 'pause_session', session_id: 's1', pid: 4242, actor: 'alice', requested_at: 1, expires_at: 100, tool: 'claude_code' });
  assert.equal(b.inserted, false); // idempotent on intent_id
  assert.equal(a.intent_id, b.intent_id);
});

test('the state machine: enforced, expired_unenforced, stale_not_sent', () => {
  const rows = [
    { intent_id: 'i1', intent: 'pause_session', session_id: 's1', pid: 100, requested_at: 1, expires_at: 50, state: 'requested', source: 'claude_code' },
    { intent_id: 'i2', intent: 'quarantine_repo', session_id: 's2', pid: null, requested_at: 1, expires_at: 50, state: 'requested', source: 'codex' },
    { intent_id: 'i3', intent: 'snooze_1h', session_id: 's3', pid: 300, requested_at: 1, expires_at: null, state: 'requested', source: 'claude_code' },
    { intent_id: 'i4', intent: 'pause_session', session_id: 's4', pid: 400, requested_at: 1, expires_at: 50, state: 'enforced', source: 'claude_code' },
  ];
  const swept = sweepIntents(rows, 100, INTENT_CONSUMERS);
  const byId = new Map(swept.map((s) => [s.intent_id, s.state]));
  assert.equal(byId.get('i1'), 'expired_unenforced'); // consumer existed, deadline passed
  assert.equal(byId.get('i2'), 'stale_not_sent'); // no consumer at all — never rendered as done
  assert.equal(byId.get('i3'), undefined); // no expiry, still requested
  assert.equal(byId.get('i4'), undefined); // monotone: enforced never un-expires

  // applied to the store
  recordIntent(db, { intent: 'quarantine_repo', session_id: 's2', pid: null, actor: 'a', requested_at: 1, expires_at: 2, tool: 'codex' });
  assert.equal(applyIntentSweep(db, 100), 1);
  const r = db.prepare('SELECT state FROM control_intents').get() as { state: string };
  assert.equal(r.state, 'stale_not_sent');
});

// ── detection quality ────────────────────────────────────────────────────────

function seedCases(n: number, rule: Anomaly['rule'], keyPrefix: string, detectedAt: number): void {
  // The key's shape is <rule>:<tool>:<session>:<bucket> — vary the SESSION so
  // each seeded row is its own case under the bucket-stripping rule.
  for (let i = 0; i < n; i++) {
    insertAnomalies(db, [anomaly({ anomaly_key: `live:${keyPrefix}:${i}:1`, rule, detected_at: detectedAt + i })]);
  }
  applyCaseIdentity(db);
}

test('precision renders only above the labelled-fraction floor', () => {
  // 25 cases, 5 labelled false_positive: below the 20-case floor.
  seedCases(25, 'error_storm', 'error_storm:t', 1000);
  for (let i = 0; i < 5; i++) {
    db.prepare(
      "INSERT INTO finding_actions (anomaly_key, action, label_mode, created_at) VALUES (?, 'false_positive', 'single', ?)",
    ).run(`live:error_storm:t:${i}:1`, 2000 + i);
  }
  applyCaseIdentity(db);
  backfillActionCaseKeys(db);
  const q = ruleQuality(db).find((x) => x.rule === 'error_storm')!;
  assert.equal(q.cases, 25);
  assert.equal(q.labelled, 5);
  assert.equal(q.precision, null); // below the floor
  assert.equal(q.floor_met, false);

  // Above the floor: 21 labelled of 25 — precision renders.
  for (let i = 5; i < 21; i++) {
    db.prepare(
      "INSERT INTO finding_actions (anomaly_key, action, label_mode, created_at) VALUES (?, 'false_positive', 'bulk', ?)",
    ).run(`live:error_storm:t:${i}:1`, 3000 + i);
  }
  backfillActionCaseKeys(db);
  const q2 = ruleQuality(db).find((x) => x.rule === 'error_storm')!;
  assert.equal(q2.labelled, 21);
  assert.equal(q2.precision, 1);
  assert.equal(q2.labelled_bulk > 0, true); // the sweep cannot present itself as reviews
});

test('MTTA/MTTR: medians, backfill exclusion, unattended vs unactioned', () => {
  // Three anomalies sharing ONE detected_at = a backfill stamp (a first pass
  // over months of history): excluded from MTTA entirely.
  for (let i = 0; i < 3; i++) {
    insertAnomalies(db, [anomaly({ anomaly_key: `live:cp:a:${i}`, rule: 'context_pressure', detected_at: 500 })]);
  }
  // Two real cases: one acked at +10s and resolved at +100s, one never touched.
  insertAnomalies(db, [
    anomaly({ anomaly_key: 'live:context_pressure:claude_code:sA:7', rule: 'context_pressure', detected_at: 1_000_000 }),
    anomaly({ anomaly_key: 'live:context_pressure:claude_code:sB:7', rule: 'context_pressure', detected_at: 1_000_000 }),
  ]);
  applyCaseIdentity(db);
  db.prepare(
    "INSERT INTO finding_actions (anomaly_key, action, created_at) VALUES ('live:context_pressure:claude_code:sA:7', 'acknowledged', 1001000)",
  ).run();
  db.prepare(
    "INSERT INTO finding_actions (anomaly_key, action, created_at) VALUES ('live:context_pressure:claude_code:sA:7', 'resolved', 1100000)",
  ).run();
  // The queue was opened after detection: the untouched case is unactioned, not unattended.
  db.prepare(
    "INSERT INTO finding_actions (anomaly_key, action, created_at) VALUES ('live:context_pressure:claude_code:sB:7', 'queue_opened', 1200000)",
  ).run();

  const s = mttaMttr(db).find((x) => x.rule === 'context_pressure')!;
  assert.equal(s.backfill_excluded, 3);
  assert.equal(s.with_action, 1);
  assert.equal(Math.abs(s.mtta_min! - 1 / 60) < 1e-9, true); // 1s ack in minutes
  assert.equal(Math.abs(s.mttr_min! - 100 / 60) < 1e-9, true); // 100s to terminal
  assert.equal(s.unactioned, 1);
  assert.equal(s.unattended, 0);
});

test('unattended: a case where the queue never opened after detection', () => {
  insertAnomalies(db, [anomaly({ anomaly_key: 'live:context_pressure:claude_code:sC:7', rule: 'context_pressure', detected_at: 1000 })]);
  applyCaseIdentity(db);
  const s = mttaMttr(db).find((x) => x.rule === 'context_pressure')!;
  assert.equal(s.unattended, 1);
  assert.equal(s.unactioned, 0);
});

// ── the noise budget ──────────────────────────────────────────────────────────

test('isoWeek anchors on the ISO week; the anomaly key cannot re-fire per poll', () => {
  assert.equal(isoWeek(Date.UTC(2026, 0, 1)), '2026-W01'); // Thursday rule
  assert.equal(isoWeek(Date.UTC(2026, 8, 7)), '2026-W37');
  assert.equal(isoWeek(Date.UTC(2027, 0, 1)), '2026-W53');
  const k = `noise_budget:${machineHash('mac1')}:error_storm:2026-W37`;
  // anchored on the week: the same week's polls derive the same key
  assert.equal(`noise_budget:${machineHash('mac1')}:error_storm:2026-W37`, k);
});

test('the noise budget names the rules that blew it, excluding the meta-rule', () => {
  const t = Date.UTC(2026, 8, 7);
  for (let i = 0; i < 12; i++) {
    insertAnomalies(db, [anomaly({ anomaly_key: `live:noise_budget:x:${i}`, rule: 'noise_budget_exceeded', detected_at: t + i })]);
  }
  for (let i = 0; i < 5; i++) {
    insertAnomalies(db, [anomaly({ anomaly_key: `live:error_storm:t:2:${i}`, rule: 'error_storm', detected_at: t + i })]);
  }
  const { rows, exceeded } = noiseBudgetRows(db, { overall_per_week: 4 });
  assert.ok(!rows.some((r) => r.rule === 'noise_budget_exceeded')); // excluded from its own count
  const es = rows.find((r) => r.rule === 'error_storm')!;
  assert.equal(es.findings, 5);
  assert.ok(exceeded.some((e) => e.rule === 'error_storm' || e.rule === '__overall__'));
  assert.ok(exceeded.every((e) => /^noise_budget:[0-9a-f]+:.+:2026-W37$/.test(e.anomaly_key)));
  assert.equal(loadNoiseBudget().overall_per_week, 40); // builtin floor when no pack exists
});

// ── custody ──────────────────────────────────────────────────────────────────

test('evidence gaps: intervals over 3x the poll interval, with witness activity counted', () => {
  const t0 = 1_000_000;
  const runs = [
    { started_at: t0, duration_ms: 100 },
    { started_at: t0 + 5000, duration_ms: 100 },
    { started_at: t0 + 10000, duration_ms: 100 },
    { started_at: t0 + 20_000_000, duration_ms: 100 }, // ~5.5h gap
  ];
  const witnesses = {
    history_jsonl: [t0 + 10_000_000], // agent was active inside the gap
    pid_sessions: [],
    codex_session_index: [],
    collector_state_mtime: [],
    usage_events_ts: [],
  };
  const gaps = deriveEvidenceGaps(runs, witnesses);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.witnesses.history_jsonl, 1);
  assert.equal(gaps[0]!.activity_count, 1);
  assert.ok(gaps[0]!.minutes > 300);

  // No witnesses: the gap stays silent — unobserved, not tampering.
  const quiet = deriveEvidenceGaps(runs, { history_jsonl: [], pid_sessions: [], codex_session_index: [], collector_state_mtime: [], usage_events_ts: [] });
  assert.equal(quiet[0]!.activity_count, 0);
});

test('witness orphans: never_ingested, pruned, deleted', () => {
  mkdirSync(join(dir, '.claude', 'projects', 'p'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'projects', 'p', 'present.jsonl'), '{}');
  const now = Date.UTC(2026, 8, 7);
  // ingested + old witness: the tool's own housekeeping
  db.prepare(
    "INSERT INTO usage_events (event_key, tool, session_id, ts, confidence, source) VALUES ('k', 'claude_code', 'old', 1, 'exact', 'live')",
  ).run();
  const orphans = classifyOrphans(
    db,
    [
      { sessionId: 'present', timestamp: now },
      { sessionId: 'old', timestamp: now - 40 * 86400000 }, // outside retention
      { sessionId: 'recent-gone', timestamp: now - 86400000 }, // inside retention, no row
      { sessionId: 'ancient-gone', timestamp: now - 100 * 86400000 }, // no row either
    ],
    { now },
  );
  const byId = new Map(orphans.map((o) => [o.session_id, o.classification]));
  assert.equal(byId.has('present'), false); // transcript exists
  assert.equal(byId.get('old'), 'pruned');
  assert.equal(byId.get('recent-gone'), 'never_ingested');
  assert.equal(byId.get('ancient-gone'), 'never_ingested');
  assert.equal(recordOrphans(db, orphans, now), orphans.length);
});

test('the custody sentence carries the real figures and its own disclaimer', () => {
  const t = 1_000_000;
  for (let i = 0; i < 5; i++) {
    db.prepare(
      'INSERT INTO collector_runs (tool, started_at, duration_ms, files, parsed, inserted, source_state, ok) VALUES (?, ?, ?, 0, 0, 0, ?, 1)',
    ).run('claude_code', t + i * 5000, 5000, 'ok');
  }
  const f = custodyFigures(db, t, t + 25000);
  assert.ok(f.coverage_pct !== null && f.coverage_pct > 99);
  const s = custodySentence(f);
  assert.match(s, /Monitored \d+\.\d+%/);
  assert.match(s, /unmonitored interval/);
  assert.match(s, /coverage statement, not an innocence statement/);
});

// ── the answer sheet ─────────────────────────────────────────────────────────

test('the answer sheet: pack identity, four counters, the horizon caveat', () => {
  db.prepare(
    "INSERT INTO content_packs (kind, version, checksum, loaded_at, trust) VALUES ('hunt', 3, 'abc', 1, 'builtin')",
  ).run();
  recordHuntRun(db, {
    hunt_id: 'h1', pack_kind: 'hunt', pack_version: 3, signature: 'abc', ran_at: 10,
    verdict_confirmed: 2, verdict_cleared: 5, verdict_unanswerable: 1, verdict_not_seen: 40,
    horizon_ts: 1788000000000, answer_sentence: null,
  });
  // A re-run is a NEW row; the old answer is never corrected.
  recordHuntRun(db, {
    hunt_id: 'h2', pack_kind: 'hunt', pack_version: 3, signature: 'abc', ran_at: 20,
    verdict_confirmed: 1, verdict_cleared: 0, verdict_unanswerable: 3, verdict_not_seen: 44,
    horizon_ts: 1788100000000, answer_sentence: null,
  });
  const latest = latestHunt(db)!;
  const sheet = answerSheet(db, latest);
  assert.match(sheet, /hunt pack v3/);
  assert.match(sheet, /trust builtin/);
  assert.match(sheet, /1 confirmed, 0 cleared, 3 unanswerable, 44 not seen/);
  assert.match(sheet, /true only as of the horizon it names/);
});

// ── the human-confirmed handoff ──────────────────────────────────────────────

test('the handoff: figures ride, nothing leaves unconfirmed', () => {
  insertAnomalies(db, [anomaly({ anomaly_key: 'live:remote_execution:claude_code:tc-9', rule: 'remote_execution', severity: 'critical' })]);
  const i = incidentFigures(db, 'live:remote_execution:claude_code:tc-9')!;
  assert.equal(i.observed, 10);
  assert.equal(i.baseline, 5);
  assert.equal(i.threshold, 9);

  const generic = JSON.parse(handoffPayload(i, 'generic'));
  assert.equal(generic.vole_incident.observed, 10);
  assert.equal(generic.vole_incident.detail, undefined); // no prose
  assert.equal(generic.vole_incident.machine, undefined); // no machine

  const pd = JSON.parse(handoffPayload(i, 'pagerduty'));
  assert.equal(pd.dedup_key, 'live:remote_execution:claude_code:tc-9');
  assert.match(pd.routing_key, /REDACTED/); // the secret never renders in a preview

  // Unconfirmed: the payload was rendered, nothing left the machine.
  const r1 = sendHandoff(i, 'pagerduty', { endpoint: 'https://example.test/x', confirmed: false });
  assert.equal(r1.sent, false);
  // No endpoint: default-off, opt-in per URL.
  const r2 = sendHandoff(i, 'pagerduty', { endpoint: null, confirmed: true });
  assert.equal(r2.sent, false);
  // Confirmed but the egress switch is off: refused, and the refusal is reported.
  process.env.VOLE_NO_EGRESS = '1';
  const r3 = sendHandoff(i, 'pagerduty', { endpoint: 'https://example.test/x', confirmed: true });
  assert.equal(r3.sent, false);
  delete process.env.VOLE_NO_EGRESS;
});
