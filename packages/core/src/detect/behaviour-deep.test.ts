import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache, insertAnomalies } from '../db';
import { buildAutonomyIntervals, detectLedgerRules } from './behaviour';
import { writeNetLedgers } from '../toolcalls/net-ledgers';

const T0 = Date.parse('2026-08-01T00:00:00Z');
const NOW = T0 + 40 * 60_000; // 40 min after the first call: past the 10-min stall bound

let dbPath: string;
before(() => {
  // Firewall the test from this machine's real agent homes: no real transcripts,
  // no real watched configs, no real ssh_config.
  process.env.VOLE_HOME_OVERRIDE = mkdtempSync(join(tmpdir(), 'vole-home-'));
  dbPath = join(mkdtempSync(join(tmpdir(), 'vole-bh-')), 't.db');
});

after(() => {
  resetDbCache();
  delete process.env.VOLE_HOME_OVERRIDE;
});

function call(key: string, over: Record<string, unknown>): void {
  db().prepare(
    `INSERT INTO tool_calls (tool_call_key, tool, name, shape, args_digest, session_id, agent_id, ts, status, first_seen, last_seen, origin_kind, permission_mode)
     VALUES (?, 'claude_code', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    key,
    (over.name as string) ?? 'Bash',
    (over.shape as string) ?? null,
    (over.args_digest as string) ?? null,
    (over.session as string) ?? null,
    (over.agent as string) ?? null,
    (over.ts as number) ?? T0,
    (over.status as string) ?? null,
    NOW,
    NOW,
    (over.origin_kind as string) ?? null,
    (over.permission_mode as string) ?? null,
  );
}

function db() {
  return openDb(dbPath);
}

test('ledger rules: the deep signatures fire, and re-running changes nothing', () => {
  const dbh = db();

  // 27. denied then achieved, cross-tool (denied Read -> successful Bash cat)
  call('d1', { session: 's-denied', name: 'Read', args_digest: 'aa', status: 'denied', ts: T0 });
  call('d2', { session: 's-denied', name: 'Bash', shape: 'cat', args_digest: 'bb', status: 'success', ts: T0 + 1000 });

  // 24/18. headless, no human, full access over 20 minutes
  call('h1', { session: 's-headless', shape: 'claude -p', permission_mode: 'bypassPermissions', ts: T0 });
  call('h2', { session: 's-headless', shape: 'npm install', permission_mode: 'bypassPermissions', ts: T0 + 20 * 60_000 });

  // 36. posture escalated: default -> bypassPermissions, with calls after
  call('e1', { session: 's-esc', name: 'Read', permission_mode: 'default', ts: T0 });
  call('e2', { session: 's-esc', name: 'Bash', shape: 'git push', permission_mode: 'bypassPermissions', ts: T0 + 2 * 60_000 });

  // 34. failure storm: 6 failures of one tool name, ratio > 0.2 over decided outcomes
  for (let i = 0; i < 6; i++) call(`f${i}`, { session: 's-fail', name: 'mcp__playwright__navigate', args_digest: `n${i}`, status: 'error', ts: T0 + i * 1000 });
  call('f6', { session: 's-fail', name: 'mcp__playwright__navigate', args_digest: 'n6', status: 'success', ts: T0 + 7000 });
  call('f7', { session: 's-fail', name: 'mcp__playwright__navigate', args_digest: 'n7', status: 'success', ts: T0 + 8000 });

  // 37. stuck: unbound outcome, later call 15 min on — past the stall bound
  // measured to the session's data horizon, not the wall clock
  call('u1', { session: 's-stuck', name: 'Bash', shape: 'npm test', ts: T0 });
  call('u2', { session: 's-stuck', name: 'Read', status: 'success', ts: T0 + 15 * 60_000 });

  // 19. identical repeat loop
  for (let i = 0; i < 5; i++) call(`l${i}`, { session: 's-loop', name: 'Bash', shape: 'ls', args_digest: 'stuck', ts: T0 + i * 1000 });

  // 45. install after ingress: an MCP call 2 ordinals before a package_execs row
  call('i1', { session: 's-inst', name: 'mcp__searxng__search', args_digest: 'q', ts: T0 });
  call('i2', { session: 's-inst', name: 'Bash', shape: 'npm install', args_digest: 'w', ts: T0 + 1000 });

  // ledger rows the rules join
  writeNetLedgers(dbh, {
    contextEdges: [{ call_key: 'h9', transport: 'ssh', verb: 'ssh', destination: 'h200', direction: 'out', ts: T0 }],
    sensitiveAccess: [{ path_class: 'dotenv', path_hash: 'deadbeef', authorization_basis: null, count: 3, window_start: Math.floor(T0 / 86400000) * 86400000 }],
    packageExecs: [{ call_key: 'i2', package_name: 'left-pad', registry: 'npm', fetch_and_run: 0, ts: T0 + 1000 }],
  });
  call('h9', { session: 's-edge', shape: 'ssh -t', ts: T0 });

  buildAutonomyIntervals(dbh);
  const run1 = detectLedgerRules(dbh, NOW);
  const keys1 = run1.map((a) => a.anomaly_key).sort();
  const rules1 = new Set(run1.map((a) => a.rule));

  // ── the deep signatures fire ──
  assert.ok(rules1.has('denied_then_achieved'), 'cross-tool guardrail bypass');
  const dta = run1.filter((a) => a.rule === 'denied_then_achieved')[0]!;
  assert.match(dta.detail, /same read intent/);

  assert.ok(rules1.has('headless_bypass_launch'), 'headless, no human, full access');
  assert.match(run1.filter((a) => a.rule === 'headless_bypass_launch')[0]!.detail, /zero origin\.kind='human'/);

  assert.ok(rules1.has('unattended_full_access'), 'the no-human evidence chain');
  assert.ok(rules1.has('posture_escalated'), 'autonomy-rank interval comparison');
  assert.match(run1.filter((a) => a.rule === 'posture_escalated')[0]!.detail, /prompt_each -> full_auto/);

  assert.ok(rules1.has('tool_failure_storm'), 'per-tool-name failure ratio');
  assert.match(run1.filter((a) => a.rule === 'tool_failure_storm')[0]!.title, /mcp__playwright__navigate/);

  assert.ok(rules1.has('stuck_tool_call'), 'unbound outcome past the stall bound');
  assert.ok(run1.filter((a) => a.rule === 'stuck_tool_call').some((a) => a.anomaly_key.includes('unbound')));

  assert.ok(rules1.has('repeat_call_loop'), 'the ledger loop signatures');
  assert.ok(run1.filter((a) => a.rule === 'repeat_call_loop').some((a) => a.anomaly_key.includes(':ident:')));

  assert.ok(rules1.has('sensitive_read_unasked'), 'the path-class x basis matrix');
  assert.ok(rules1.has('context_edges'), 'crossings by transport');
  assert.ok(rules1.has('install_after_ingress'), 'ingress then action by ledger ordinals');
  const iai = run1.filter((a) => a.rule === 'install_after_ingress')[0]!;
  assert.match(iai.detail, /1 ledger ordinals later/);

  // 48. posture-weighted severity: the escalation note lands on overlapping windows
  const escalated = run1.filter((a) => a.detail.includes('Escalated: session was in bypassPermissions'));
  assert.ok(escalated.length > 0, 'at least one rule was weighted by posture');

  // ── idempotency: a second run over the same store produces the same keys ──
  // (persist the first run the way collect does, so the interrupt watermark etc. see it)
  insertAnomalies(dbh, run1);
  const run2 = detectLedgerRules(dbh, NOW);
  const keys2 = run2.map((a) => a.anomaly_key).sort();
  assert.deepEqual(keys2, keys1, 'no key contains a now()-derived value, so re-detection is stable');

  // ── idempotency across the wall clock: the defect was a no-op second pass
  // minting +245 rows because windows were run-relative. Every key and window
  // bound must be a function of the DATA — re-running hours later with zero new
  // rows reproduces byte-identical anomalies and inserts nothing.
  const run3 = detectLedgerRules(dbh, NOW + 2 * 3600_000);
  const stuck3 = run3.filter((a) => a.rule === 'stuck_tool_call');
  assert.ok(stuck3.length > 0, 'the stuck fixture still fires');
  for (const a of stuck3) {
    assert.ok(a.window_end <= NOW, `stuck window_end is data-anchored, not the run hour: ${a.anomaly_key}`);
  }
  const byKey = new Map(run1.map((a) => [a.anomaly_key, a] as const));
  for (const a of run3) {
    const first = byKey.get(a.anomaly_key);
    if (!first) continue;
    assert.equal(a.window_start, first.window_start, `window_start stable for ${a.anomaly_key}`);
    assert.equal(a.window_end, first.window_end, `window_end stable for ${a.anomaly_key}`);
    assert.equal(a.observed, first.observed, `observed stable for ${a.anomaly_key}`);
  }
  const keys3 = run3.map((a) => a.anomaly_key).sort();
  assert.deepEqual(keys3, keys1, 'a later wall clock mints no fresh keys over unchanged rows');
  const rewritten = insertAnomalies(dbh, run3);
  assert.equal(rewritten.inserted.length, 0, 'a no-op pass inserts no new rows');
  assert.equal(rewritten.escalated.length, 0, 'a no-op pass escalates nothing');

  // ── content boundary: no anomaly text carries a raw path or command body ──
  for (const a of run1) {
    assert.ok(!a.detail.includes('/Users/'), `detail must not carry raw paths: ${a.anomaly_key}`);
    assert.ok(!a.title.includes('~/.ssh'), `title must not carry raw paths: ${a.anomaly_key}`);
  }
});
