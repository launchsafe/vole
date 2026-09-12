import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from './sqlite';
import { SCHEMA } from './schema';
import { insertEvents } from './db';
import { classifyYield, computeYield, getYieldSummary, DEFAULT_GRACE_MS } from './yield';
import { repoRoot, commitTimesMs } from './util/git';
import type { UsageEvent } from './types';

const MIN = 60_000;
const T0 = Date.parse('2026-05-01T12:00:00Z');

// ── the pure classifier ──────────────────────────────────────────────────────

test('a session with a commit in its window is committed', () => {
  const v = classifyYield({
    repoRoot: '/repo', firstTs: T0, lastTs: T0 + 10 * MIN,
    commitTimes: [T0 + 5 * MIN], now: T0 + 3 * 60 * MIN,
  });
  assert.deepEqual(v, { status: 'committed', commits: 1 });
});

test('a closed session with no commit is abandoned', () => {
  const v = classifyYield({
    repoRoot: '/repo', firstTs: T0, lastTs: T0 + 10 * MIN,
    commitTimes: [], now: T0 + 3 * 60 * MIN,
  });
  assert.deepEqual(v, { status: 'abandoned', commits: 0 });
});

test('a session still inside its grace period is unclear, never abandoned', () => {
  // The failure this prevents: telling someone their work was wasted while they are
  // still typing the commit message.
  const v = classifyYield({
    repoRoot: '/repo', firstTs: T0, lastTs: T0 + 10 * MIN,
    commitTimes: [], now: T0 + 11 * MIN,
  });
  assert.equal(v.status, 'unclear');
  assert.equal(v.commits, 0);
});

test('a session with no repository is unclear, not abandoned', () => {
  const v = classifyYield({
    repoRoot: null, firstTs: T0, lastTs: T0 + 10 * MIN,
    commitTimes: [T0 + 5 * MIN], now: T0 + 3 * 60 * MIN,
  });
  assert.deepEqual(v, { status: 'unclear', commits: 0 });
});

test('a commit inside the grace period still counts as the session output', () => {
  const lastTs = T0 + 10 * MIN;
  const justInside = classifyYield({
    repoRoot: '/repo', firstTs: T0, lastTs,
    commitTimes: [lastTs + DEFAULT_GRACE_MS - MIN], now: T0 + 5 * 60 * MIN,
  });
  assert.equal(justInside.status, 'committed');

  const justOutside = classifyYield({
    repoRoot: '/repo', firstTs: T0, lastTs,
    commitTimes: [lastTs + DEFAULT_GRACE_MS + MIN], now: T0 + 5 * 60 * MIN,
  });
  assert.equal(justOutside.status, 'abandoned', 'a commit past the grace window is not this session');
});

test('commits before the session started are not credited to it', () => {
  const v = classifyYield({
    repoRoot: '/repo', firstTs: T0, lastTs: T0 + 10 * MIN,
    commitTimes: [T0 - MIN], now: T0 + 3 * 60 * MIN,
  });
  assert.equal(v.status, 'abandoned');
});

// ── against a real repository ────────────────────────────────────────────────

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vole-repo-'));
  const run = (...a: string[]) =>
    execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  run('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'f.txt'), 'x');
  run('add', 'f.txt');
  run('commit', '-qm', 'first');
  return dir;
}

function ev(over: Partial<UsageEvent>): UsageEvent {
  return {
    event_key: `k${Math.random()}`, tool: 'claude_code', model: 'claude-opus-5',
    session_id: 's1', project: null, git_branch: null, ts: T0,
    input_tokens: 0, output_tokens: 100, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0,
    cache_read_tokens: 0, reasoning_tokens: 0, total_tokens: 100, cost_usd: 1,
    confidence: 'exact', is_error: 0, stop_reason: null, source: 'live', raw_ref: null,
    tools: null, agent_id: null, context_window: null, duration_ms: null, duration_kind: null,
    ...over,
  };
}

test('a subdirectory resolves to its repository root, not "no repo"', () => {
  // Most recorded project paths are subdirectories; only the root has a .git, so
  // looking for one directly would misread nearly every session as unclear.
  const repo = tempRepo();
  const sub = join(repo, 'a', 'b');
  mkdirSync(sub, { recursive: true });
  const root = repoRoot(sub);
  assert.ok(root, 'a subdirectory is still inside the repository');
  assert.equal(root?.replace('/private', ''), repo.replace('/private', ''));
});

test('computeYield classifies real sessions against a real repository', () => {
  const repo = tempRepo();
  const commitMs = commitTimesMs(repo, 0)[0];
  assert.ok(commitMs, 'the fixture repo has a commit');

  const db = new Database(join(mkdtempSync(join(tmpdir(), 'vole-y-')), 'v.db'));
  db.exec(SCHEMA);
  // Not in this branch's SCHEMA constant yet in older stores — create it the way the
  // migration does, so the test exercises computeYield rather than migration order.
  db.exec(`CREATE TABLE IF NOT EXISTS session_yield (
    session_id TEXT NOT NULL, tool TEXT NOT NULL, repo_root TEXT, status TEXT NOT NULL,
    commits INTEGER NOT NULL DEFAULT 0, window_start INTEGER, window_end INTEGER,
    computed_at INTEGER NOT NULL, PRIMARY KEY (session_id, tool))`);

  const now = commitMs + 4 * 60 * MIN;
  insertEvents(db, [
    // Wraps the commit -> committed.
    ev({ event_key: 'a1', session_id: 'did-work', project: repo, ts: commitMs - 2 * MIN, cost_usd: 3 }),
    ev({ event_key: 'a2', session_id: 'did-work', project: repo, ts: commitMs - MIN, cost_usd: 3 }),
    // Long after the only commit -> abandoned.
    ev({ event_key: 'b1', session_id: 'no-output', project: repo, ts: commitMs + 60 * MIN, cost_usd: 5 }),
    // No project at all -> unclear.
    ev({ event_key: 'c1', session_id: 'no-project', project: null, ts: commitMs, cost_usd: 7 }),
  ]);

  const n = computeYield(db, now);
  assert.equal(n, 3, 'every session was classified');

  const rows = Object.fromEntries(
    (db.prepare('SELECT session_id, status, commits FROM session_yield').all() as
      { session_id: string; status: string; commits: number }[]).map((r) => [r.session_id, r]),
  );
  assert.equal(rows['did-work']?.status, 'committed');
  assert.equal(rows['did-work']?.commits, 1);
  assert.equal(rows['no-output']?.status, 'abandoned');
  assert.equal(rows['no-project']?.status, 'unclear');

  const sum = getYieldSummary(db, 0);
  assert.equal(sum.committed.cost, 6);
  assert.equal(sum.abandoned.cost, 5);
  assert.equal(sum.unclear.cost, 7);
  // 5 of the 11 classified dollars produced nothing; the 7 unknown dollars are excluded
  // from the denominator rather than quietly improving the ratio.
  assert.ok(Math.abs((sum.abandonedShare ?? 0) - 5 / 11) < 1e-9);
});

test('a settled verdict is not recomputed on the next pass', () => {
  const repo = tempRepo();
  const commitMs = commitTimesMs(repo, 0)[0]!;
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'vole-y2-')), 'v.db'));
  db.exec(SCHEMA);
  db.exec(`CREATE TABLE IF NOT EXISTS session_yield (
    session_id TEXT NOT NULL, tool TEXT NOT NULL, repo_root TEXT, status TEXT NOT NULL,
    commits INTEGER NOT NULL DEFAULT 0, window_start INTEGER, window_end INTEGER,
    computed_at INTEGER NOT NULL, PRIMARY KEY (session_id, tool))`);

  insertEvents(db, [ev({ event_key: 'z1', session_id: 'done', project: repo, ts: commitMs })]);
  const now = commitMs + 4 * 60 * MIN;
  assert.equal(computeYield(db, now), 1, 'classified on the first pass');
  assert.equal(computeYield(db, now), 0, 'and never spawns git for it again');
});
