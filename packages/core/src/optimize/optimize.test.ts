import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../sqlite';
import { SCHEMA } from '../schema';
import { insertEvents } from '../db';
import {
  compareOutcome, isDueForVerification, shouldRevert,
  NOISE_FLOOR_USD, WORKED_RATIO, VERIFY_AFTER_MS,
} from './outcome';
import { recordFindings, listFindings, applyFinding, revertFinding, verifyDueFindings } from './store';
import type { Finding } from './detect';
import type { UsageEvent } from '../types';

// ── the comparison, on synthetic before/after data ───────────────────────────
// No real elapsed time is needed to test any of this, which is the point of keeping
// the comparison pure and separate from detection.

test('a fix that delivers its prediction worked', () => {
  const v = compareOutcome({ predictedUsd: 10, baselineUsd: 50, actualUsd: 40 });
  assert.equal(v.outcome, 'worked');
  assert.equal(v.realisedUsd, 10);
  assert.equal(v.ratio, 1);
});

test('most of a prediction is still worked', () => {
  const v = compareOutcome({ predictedUsd: 10, baselineUsd: 50, actualUsd: 41.5 });
  assert.equal(v.realisedUsd, 8.5);
  assert.ok(8.5 >= 10 * WORKED_RATIO);
  assert.equal(v.outcome, 'worked');
});

test('a real but disappointing saving is reported as under its estimate, not as success', () => {
  const v = compareOutcome({ predictedUsd: 10, baselineUsd: 50, actualUsd: 47 });
  assert.equal(v.outcome, 'under_estimate');
  assert.equal(v.realisedUsd, 3);
});

test('no change at all did not help', () => {
  const v = compareOutcome({ predictedUsd: 10, baselineUsd: 50, actualUsd: 50 });
  assert.equal(v.outcome, 'did_not_help');
  assert.equal(v.realisedUsd, 0);
});

test('spend going UP is did_not_help, never a negative success', () => {
  const v = compareOutcome({ predictedUsd: 10, baselineUsd: 50, actualUsd: 65 });
  assert.equal(v.outcome, 'did_not_help');
  assert.equal(v.realisedUsd, -15);
});

test('a saving inside the noise floor is not claimed as a result', () => {
  // Agent spend drifts day to day for reasons unrelated to any fix. Counting a few
  // cents as success would make every finding look effective.
  const v = compareOutcome({ predictedUsd: 10, baselineUsd: 50, actualUsd: 50 - NOISE_FLOOR_USD });
  assert.equal(v.outcome, 'did_not_help');
});

test('an improvement with nothing predicted is not scored against a promise', () => {
  const v = compareOutcome({ predictedUsd: 0, baselineUsd: 50, actualUsd: 40 });
  assert.equal(v.outcome, 'worked');
  assert.equal(v.ratio, null, 'no prediction means no ratio to report');
});

test('only an auto-applied fix that did nothing is reverted', () => {
  assert.equal(shouldRevert('did_not_help', true), true);
  assert.equal(shouldRevert('did_not_help', false), false, 'never undo what the user did');
  // It helped less than hoped, but it helped — undoing it would cost the part that worked.
  assert.equal(shouldRevert('under_estimate', true), false);
  assert.equal(shouldRevert('worked', true), false);
});

test('a fix is not judged before its window closes', () => {
  const t = 1_000_000;
  assert.equal(isDueForVerification(t, t + VERIFY_AFTER_MS - 1), false);
  assert.equal(isDueForVerification(t, t + VERIFY_AFTER_MS), true);
});

// ── apply / revert against a real config file ────────────────────────────────

function store() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'vole-opt-')), 'v.db'));
  db.exec(SCHEMA);
  db.exec(`CREATE TABLE IF NOT EXISTS optimize_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, finding_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
    title TEXT NOT NULL, detail TEXT NOT NULL, fix TEXT, mechanical INTEGER NOT NULL DEFAULT 0,
    predicted_usd REAL, baseline_usd REAL, detected_at INTEGER NOT NULL, applied_at INTEGER,
    applied_payload TEXT, verify_after INTEGER, verified_at INTEGER, outcome TEXT,
    realised_usd REAL, reverted_at INTEGER, revert_reason TEXT)`);
  return db;
}

const finding = (over: Partial<Finding> = {}): Finding => ({
  key: 'unpriced_model:claude_code:some-model', kind: 'unpriced_model',
  title: 'Spend on some-model is invisible', detail: 'd', fix: 'f',
  mechanical: true, predictedUsd: 0, baselineUsd: 0, ...over,
});

function withPricing<T>(file: string, fn: () => T): T {
  const prev = process.env.VOLE_PRICING;
  process.env.VOLE_PRICING = file;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.VOLE_PRICING;
    else process.env.VOLE_PRICING = prev;
  }
}

test('applying writes a placeholder rate, and reverting removes it again', () => {
  const db = store();
  const file = join(mkdtempSync(join(tmpdir(), 'vole-price-')), 'pricing.json');
  const now = Date.now();
  recordFindings(db, [finding()], now);

  withPricing(file, () => {
    const f = listFindings(db)[0]!;
    const applied = applyFinding(db, f, now);
    assert.ok(applied.ok, applied.note);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { models: Record<string, unknown> };
    assert.ok(doc.models['some-model'], 'the model is now present');

    const again = listFindings(db)[0]!;
    const rev = revertFinding(db, again, 'test', now);
    assert.ok(rev.ok, rev.note);
    const after = JSON.parse(readFileSync(file, 'utf8')) as { models: Record<string, unknown> };
    assert.equal(after.models['some-model'], undefined, 'and removed again');
  });
});

test('a placeholder is never written over a rate the user already set', () => {
  const db = store();
  const file = join(mkdtempSync(join(tmpdir(), 'vole-price2-')), 'pricing.json');
  writeFileSync(file, JSON.stringify({ models: { 'some-model': { input: 3, output: 15 } } }));
  recordFindings(db, [finding()], Date.now());

  withPricing(file, () => {
    const r = applyFinding(db, listFindings(db)[0]!, Date.now());
    assert.equal(r.ok, false);
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { models: Record<string, { input: number }> };
    assert.equal(doc.models['some-model']!.input, 3, "the user's own rate survives untouched");
  });
});

test('revert leaves a rate the user has since edited', () => {
  const db = store();
  const file = join(mkdtempSync(join(tmpdir(), 'vole-price3-')), 'pricing.json');
  const now = Date.now();
  recordFindings(db, [finding()], now);

  withPricing(file, () => {
    applyFinding(db, listFindings(db)[0]!, now);
    // The user fills in the real number afterwards.
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { models: Record<string, unknown> };
    doc.models['some-model'] = { input: 5, output: 25, effective_from: '2026-01-01' };
    writeFileSync(file, JSON.stringify(doc));

    const r = revertFinding(db, listFindings(db)[0]!, 'test', now);
    assert.equal(r.ok, false, 'an edited rate is the user\'s, not ours to remove');
    const after = JSON.parse(readFileSync(file, 'utf8')) as { models: Record<string, { input: number }> };
    assert.equal(after.models['some-model']!.input, 5);
  });
});

test('a fix that did not help is verified and rolled back automatically', () => {
  const db = store();
  const file = join(mkdtempSync(join(tmpdir(), 'vole-price4-')), 'pricing.json');
  const appliedAt = Date.parse('2026-05-01T00:00:00Z');
  const now = appliedAt + VERIFY_AFTER_MS + 60_000;

  const ev = (ts: number, cost: number, key: string): UsageEvent => ({
    event_key: key, tool: 'claude_code', model: 'claude-opus-5', session_id: 's', project: null,
    git_branch: null, ts, input_tokens: 0, output_tokens: 10, cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0, total_tokens: 10,
    cost_usd: cost, confidence: 'exact', is_error: 0, stop_reason: null, source: 'live',
    raw_ref: null, tools: null, agent_id: null, context_window: null, duration_ms: null,
    duration_kind: null,
  });
  const span = now - appliedAt;
  // Spend is identical either side of the apply: the fix changed nothing.
  insertEvents(db, [ev(appliedAt - span / 2, 20, 'before'), ev(appliedAt + span / 2, 20, 'after')]);

  recordFindings(db, [finding({ predictedUsd: 5 })], appliedAt);
  withPricing(file, () => {
    applyFinding(db, listFindings(db)[0]!, appliedAt);
    const results = verifyDueFindings(db, now);

    assert.equal(results.length, 1);
    assert.equal(results[0]!.outcome, 'did_not_help');
    assert.equal(results[0]!.reverted, true, 'an auto-applied fix that did nothing is undone');
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { models: Record<string, unknown> };
    assert.equal(doc.models['some-model'], undefined);

    // And it is not judged twice.
    assert.equal(verifyDueFindings(db, now).length, 0);
  });
});
