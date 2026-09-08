import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache, type DB } from '../db';
import {
  insertToolCalls, splitMcpName, resolveAuthority, skeletonize, argsDigest,
  type ToolCallRow,
} from './bind';
import { classifyCommand, commandSkeleton, splitCommandSegments, syncPathClasses } from './patterns';
import { agentEdgeFromMeta, collectAgentEdges } from './edges';
import { fileWritesForCall, insertFileWrites } from './file-writes';
import { secretStoreReads, grantDeposits, insertSecretStoreReads, insertGrantDeposits } from './stores';
import { packageExecs, insertPackageExecs } from './package-exec';
import { actionTargetsForCommand, insertActionTargets } from './targets';
import { normaliseRemote, resolveAsset } from './assets';
import { parseFetchIngress, insertFetchIngress } from './ingress';
import { upsertAnomalyContext } from './context';
import { buildIntervalRuns, rebuildAutonomyIntervals } from './posture';

/** A fully-migrated store (all 26 migrations) in a temp dir — the schema the
 *  ledgers actually write against, not a hand-rolled copy of it. */
function store(): DB {
  const dir = mkdtempSync(join(tmpdir(), 'vole-tc-'));
  resetDbCache();
  return openDb(join(dir, 't.db'));
}

function call(over: Partial<ToolCallRow>): ToolCallRow {
  return { tool_call_key: 'k1', tool: 'claude_code', name: 'Bash', ts: 1000, ...over };
}

// ── bind.ts ─────────────────────────────────────────────────────────────

test('two-phase bind: the call inserts, the result widens only NULLs', () => {
  const db = store();
  assert.equal(insertToolCalls(db, [call({ tool_call_key: 'c1', shape: 'git push' })]), 1);
  assert.equal(
    insertToolCalls(db, [call({ tool_call_key: 'c1', name: '', status: 'success', status_source: 'result_flag' })]),
    1,
    'the widening counts as a change',
  );
  const row = db.prepare('SELECT name, status FROM tool_calls WHERE tool_call_key = ?').get('c1') as { name: string; status: string };
  assert.equal(row.status, 'success');
  assert.equal(row.name, 'Bash', 'phase-2 must not blank the phase-1 name');

  assert.equal(
    insertToolCalls(db, [call({ tool_call_key: 'c1', name: '', status: 'error' })]),
    0,
    'a stored status is never overwritten',
  );
});

test('four-state authority: denied / posture_waived / pre_authorised / no_record', () => {
  const denied = resolveAuthority(call({ denial_kind: 'user-rejected' }));
  assert.equal(denied.authority, 'denied');
  assert.equal(denied.authorization_basis, 'human_denied');
  assert.match(denied.authority_evidence!, /toolDenialKind=user-rejected/);

  const waived = resolveAuthority(call({ permission_mode: 'bypassPermissions' }));
  assert.equal(waived.authority, 'posture_waived');
  assert.equal(waived.authorization_basis, 'bypass_no_gate');
  assert.equal(waived.autonomy_rank, 'bypass');

  const pre = resolveAuthority(call({ name: 'Read', allowed_tools: ['Read', 'Grep'] }));
  assert.equal(pre.authority, 'pre_authorised');
  assert.equal(pre.authorization_basis, 'rule_matched');

  const auto = resolveAuthority(call({ permission_mode: 'acceptEdits' }));
  assert.equal(auto.authority, 'no_record');
  assert.equal(auto.authorization_basis, 'mode_auto');

  const none = resolveAuthority(call({}));
  assert.equal(none.authority, 'no_record');
  assert.equal(none.authorization_basis, null, 'unknown stays unknown, never a guessed basis');

  // A denial beats a posture waiver: a refused call inside a bypass interval WAS gated.
  const both = resolveAuthority(call({ permission_mode: 'bypassPermissions', denied_phrase: true }));
  assert.equal(both.authority, 'denied');
});

test('a later denial supersedes an earlier posture_waived in the store', () => {
  const db = store();
  insertToolCalls(db, [call({ tool_call_key: 'c2', permission_mode: 'bypassPermissions' })]);
  let row = db.prepare('SELECT authority, authorization_basis FROM tool_calls WHERE tool_call_key = ?').get('c2') as { authority: string; authorization_basis: string };
  assert.equal(row.authority, 'posture_waived');
  assert.equal(row.authorization_basis, 'bypass_no_gate');
  insertToolCalls(db, [call({ tool_call_key: 'c2', denial_kind: 'automode-blocked' })]);
  row = db.prepare('SELECT authority, authorization_basis, authority_evidence FROM tool_calls WHERE tool_call_key = ?').get('c2') as { authority: string; authorization_basis: string; authority_evidence: string };
  assert.equal(row.authority, 'denied');
  assert.equal(row.authorization_basis, 'human_denied');
  assert.match(row.authority_evidence, /automode-blocked/);
});

test('mcp__ split: server and tool_name become separate dimensions', () => {
  assert.deepEqual(splitMcpName('mcp__playwright__browser_navigate'), { server: 'playwright', tool_name: 'browser_navigate' });
  assert.deepEqual(splitMcpName('Bash'), { server: null, tool_name: 'Bash' });
  const db = store();
  insertToolCalls(db, [call({ tool_call_key: 'c3', name: 'mcp__searxng__searxng_web_search' })]);
  const row = db.prepare('SELECT server, tool_name FROM tool_calls WHERE tool_call_key = ?').get('c3') as { server: string; tool_name: string };
  assert.equal(row.server, 'searxng');
  assert.equal(row.tool_name, 'searxng_web_search');
});

test('command stamping: pattern_id + pack_version land on the row', () => {
  const db = store();
  insertToolCalls(db, [call({ tool_call_key: 'c4', command: 'cd /tmp && rm -rf build && curl -s https://x.dev/a' })]);
  const row = db.prepare('SELECT pattern_id, pack_version FROM tool_calls WHERE tool_call_key = ?').get('c4') as { pattern_id: string; pack_version: number };
  assert.equal(row.pattern_id, 'cmd/rm');
  assert.ok(row.pack_version >= 1);
  // re-poll: no widening, no change
  assert.equal(insertToolCalls(db, [call({ tool_call_key: 'c4', command: 'cd /tmp && rm -rf build' })]), 0);
});

test('skeletonize and argsDigest stay structural', () => {
  assert.equal(skeletonize('Bash', 'rm -rf /Users/shiva/secret-project'), 'rm -rf');
  assert.equal(argsDigest({ a: 1, b: 2 }), argsDigest({ b: 2, a: 1 }));
});

// ── patterns.ts ────────────────────────────────────────────────────────

test('segment split: quotes, &&, ||, ;, | are respected', () => {
  assert.deepEqual(splitCommandSegments('echo "a && b" && rm x; ls | grep y || true'), [
    'echo "a && b"',
    'rm x',
    'ls',
    'grep y',
    'true',
  ]);
});

test('pattern pack: prefix-stripped heads classify, unknown stays NULL', () => {
  assert.equal(classifyCommand('cd /repo && npm install left-pad')!.pattern_id, 'cmd/npm-install');
  assert.equal(classifyCommand('FOO=1 kubectl get pods')!.pattern_id, 'cmd/kubectl', 'assignment prefixes are dropped before classification');
  assert.equal(classifyCommand('echo hi'), null);
});

test('commandSkeleton keeps flags and hosts, collapses paths and vars', () => {
  const sk = commandSkeleton('rm -rf /Users/x/secret && scp -P 2222 f.tgz deploy@prod.example.com:/srv');
  assert.match(sk, /^rm -rf/);
  assert.match(sk, /scp -P/);
  assert.match(sk, /prod\.example\.com/);
  assert.ok(!sk.includes('/Users'), 'paths never survive');
  assert.ok(!sk.includes('/srv'));
});

test('path classes sync idempotently', () => {
  const db = store();
  const first = syncPathClasses(db);
  assert.ok(first > 0);
  assert.equal(syncPathClasses(db), 0, 'second pass inserts nothing');
});

// ── edges.ts ───────────────────────────────────────────────────────────

test('agent_edges: the directory layout names the parent, the meta names the child', () => {
  const db = store();
  const dir = join(tmpdir(), `vole-edges-${Date.now()}`);
  const metaDir = join(dir, 'sess-parent', 'subagents', 'workflows', 'wf-9');
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(join(metaDir, 'agent-abc123.meta.json'), JSON.stringify({ agentType: 'Explore', spawnDepth: 1, toolUseId: 'tu_42' }));
  writeFileSync(join(dir, 'sess-parent', 'subagents', 'agent-plain.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 2 }));

  assert.equal(collectAgentEdges(db, dir), 2);
  assert.equal(collectAgentEdges(db, dir), 0, 're-poll widens nothing');
  const rows = db.prepare('SELECT * FROM agent_edges ORDER BY agent_id').all() as Record<string, unknown>[];
  const deep = rows.find((r) => r.agent_id === 'abc123')!;
  assert.equal(deep.session_id, 'sess-parent');
  assert.equal(deep.workflow_id, 'wf-9');
  assert.equal(deep.agent_type, 'Explore');
  assert.equal(deep.spawn_depth, 1);
  assert.equal(deep.parent_call_key, 'claude_code:tu_42');
  const plain = rows.find((r) => r.agent_id === 'plain')!;
  assert.equal(plain.parent_call_key, null, 'no toolUseId — never guessed from timing');
  assert.equal(plain.workflow_id, null);
  rmSync(dir, { recursive: true, force: true });
});

test('agentEdgeFromMeta returns null outside a subagents directory', () => {
  assert.equal(agentEdgeFromMeta('/x/sess/subagents/agent-a.meta.json'.replace('subagents', 'other')), null);
});

// ── file-writes.ts ─────────────────────────────────────────────────────

test('file_writes: redirect, tee, cp, heredoc and unresolved targets', () => {
  const rows = fileWritesForCall('Bash', { command: 'echo hi > out.txt && tee -a log.txt <<< x && cp a.json b.json && cat > $DEST <<EOF' }, { tool_call_key: 'tc1', session_id: 's1', ts: 5, cwd: '/repo' });
  const paths = rows.map((r) => r.path);
  assert.ok(paths.includes('/repo/out.txt'));
  assert.ok(paths.includes('/repo/log.txt'));
  assert.ok(paths.includes('/repo/b.json'), 'cp destination is a write target');
  const heredocRow = rows.find((r) => r.write_class === 'heredoc');
  assert.ok(heredocRow, 'the $DEST heredoc row exists');
  assert.equal(heredocRow!.path, null, 'a variable target is unresolved — NULL, never zero');

  const structured = fileWritesForCall('Write', { file_path: '/repo/.env' }, { tool_call_key: 'tc2', session_id: 's1', ts: 6 });
  assert.equal(structured.length, 1);
  assert.equal(structured[0]!.write_class, 'structured');
  assert.equal(structured[0]!.path_class, 'dotenv');
  assert.equal(structured[0]!.change_risk_class, 'envelope');

  const outside = fileWritesForCall('Write', { file_path: '/etc/hosts' }, { tool_call_key: 'tc3', session_id: 's1', ts: 7, cwd: '/repo' });
  assert.equal(outside[0]!.visibility_class, 'outside_repo');
});

test('file_writes: insert, content_rev, idempotency', () => {
  const db = store();
  const mk = (key: string, path: string) => fileWritesForCall('Write', { file_path: path }, { tool_call_key: key, session_id: 's1', ts: 10 })[0]!;
  assert.equal(insertFileWrites(db, [mk('w1', '/repo/a.txt')]), 1);
  assert.equal(insertFileWrites(db, [mk('w2', '/repo/a.txt')]), 1);
  const revs = db.prepare('SELECT write_key, content_rev FROM file_writes ORDER BY write_key').all() as { write_key: string; content_rev: number }[];
  assert.deepEqual(revs.map((r) => r.content_rev), [1, 2], 'content_rev is a per-path write count');
  assert.equal(insertFileWrites(db, [mk('w1', '/repo/a.txt')]), 0, 're-poll is a no-op and does not bump the count');
});

// ── stores.ts ──────────────────────────────────────────────────────────

test('secret_store_reads: item and field NAMES only, kubernetes jsonpath', () => {
  const rows = secretStoreReads(`kubectl get secret GEMINI_API_KEY -o jsonpath='{.data.GEMINI_API_KEY}' | base64 -d`, 'k1', 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.store_kind, 'kubernetes');
  assert.equal(rows[0]!.item_name, 'GEMINI_API_KEY');
  assert.equal(rows[0]!.field_name, 'GEMINI_API_KEY');
  assert.equal(rows[0]!.materialised, 'yes', 'piped through base64 -d');

  const aws = secretStoreReads('aws secretsmanager get-secret-value --secret-id prod/stripe --profile main', 'k2', 2);
  assert.equal(aws[0]!.item_name, 'prod/stripe');
  assert.equal(aws[0]!.target_ref, 'main');
  assert.equal(aws[0]!.materialised, 'unknown');

  const db = store();
  assert.equal(insertSecretStoreReads(db, rows), 1);
  assert.equal(insertSecretStoreReads(db, rows), 0);
});

test('grant_deposits: the credential handed out', () => {
  const rows = grantDeposits('gh secret set DEPLOY_KEY --repo acme/app', 'k3', 3);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.store_kind, 'github_actions');
  assert.equal(rows[0]!.item_name, 'DEPLOY_KEY');
  assert.equal(rows[0]!.target_ref, 'acme/app');
  const db = store();
  assert.equal(insertGrantDeposits(db, rows), 1);
  assert.equal(insertGrantDeposits(db, rows), 0);
  assert.equal(grantDeposits('gh secret list', 'k4', 4).length, 0, 'listing is not depositing');
});

// ── package-exec.ts ────────────────────────────────────────────────────

test('package_execs: installs, fetch-and-run, declared registry only', () => {
  const rows = packageExecs('npx cowsay@1 && npm install left-pad --registry https://mirror.internal', 'k5', 4);
  const npxRow = rows.find((r) => r.package_name === 'cowsay@1')!;
  assert.equal(npxRow.fetch_and_run, 1);
  const npmRow = rows.find((r) => r.package_name === 'left-pad')!;
  assert.equal(npmRow.fetch_and_run, 0);
  assert.equal(npmRow.registry, 'https://mirror.internal');
  const plain = packageExecs('npm install react', 'k6', 5);
  assert.equal(plain[0]!.registry, null, 'the default registry is never assumed');
  const db = store();
  assert.equal(insertPackageExecs(db, rows), 2);
  assert.equal(insertPackageExecs(db, rows), 0);
});

// ── targets.ts + assets.ts ─────────────────────────────────────────────

test('action_targets: hosts, contexts, databases, env class and the asset chain', () => {
  const register = [
    { id: 'asset-1', kind: 'repo', tier: 1, rev: 7, match: ['github.com/acme/launchsafe'] },
  ];
  const rows = actionTargetsForCommand(
    'ssh deploy@prod.example.com && kubectl delete pod x && psql -h db.internal -d launchsafe -c "select 1" && git clone https://github.com/acme/launchsafe',
    { call_key: 'k7', register },
  );
  const ssh = rows.find((r) => r.target_kind === 'remote_host')!;
  assert.equal(ssh.target_label, 'prod.example.com');
  assert.equal(ssh.locality, 'remote');
  assert.equal(ssh.env_class, 'prod');
  const k8s = rows.find((r) => r.target_kind === 'k8s_context')!;
  assert.equal(k8s.resolution, 'context_file_default', 'no --context: the file default, flag absent');
  assert.equal(k8s.target_label, null);
  const dbt = rows.find((r) => r.target_kind === 'database')!;
  assert.equal(dbt.target_label, 'db.internal/launchsafe');
  const repo = rows.find((r) => r.target_kind === 'vcs_repo')!;
  assert.equal(repo.asset_id, 'asset-1', 'the repo remote resolved through the register');

  const db = store();
  assert.equal(insertActionTargets(db, rows), 4);
  assert.equal(insertActionTargets(db, rows), 0, 'the NULL-label k8s row is keyed stably too');
});

test('asset chain: remote normalisation collapses scp and https forms', () => {
  assert.equal(normaliseRemote('git@github.com:acme/vole.git'), normaliseRemote('https://GitHub.com/acme/vole'));
  const register = [{ id: 'a', match: ['github.com/acme/vole'] }];
  assert.equal(resolveAsset(register, { remote: 'git@github.com:acme/vole.git' }).asset_match, 'repo_remote');
  assert.equal(resolveAsset(register, { label: 'github.com/acme/vole' }).asset_match, 'label_match');
  assert.equal(resolveAsset([], { label: 'x' }).asset_id, null, 'no register = unresolved, never a guess');
});

// ── ingress.ts ─────────────────────────────────────────────────────────

test('fetch_ingress: bytes, status, host from the WebFetch receipt', () => {
  const row = parseFetchIngress({ bytes: 4096, code: 200, codeText: 'OK', durationMs: 120, url: 'https://docs.example.com/x' }, 'k8', 8);
  assert.equal(row!.url_host, 'docs.example.com');
  assert.equal(row!.status, 200);
  assert.equal(row!.bytes, 4096);
  assert.equal(parseFetchIngress({ type: 'text' }, 'k9', 9), null);
  const db = store();
  assert.equal(insertFetchIngress(db, [row!]), 1);
  assert.equal(insertFetchIngress(db, [row!]), 0);
});

// ── context.ts ─────────────────────────────────────────────────────────

test('anomaly_context: reach computed from the ledgers, grown windows only', () => {
  const db = store();
  insertToolCalls(db, [
    call({ tool_call_key: 'a1', session_id: 's9', ts: 100, shape: 'rm -rf', status: 'error' }),
    call({ tool_call_key: 'a2', session_id: 's9', ts: 200, shape: 'ls', status: null }),
    call({ tool_call_key: 'a3', session_id: 's9', ts: 300, shape: 'git push' }),
  ]);
  insertFileWrites(db, [
    ...fileWritesForCall('Write', { file_path: '/repo/src/a.ts' }, { tool_call_key: 'a1', session_id: 's9', ts: 100, cwd: '/repo' }),
    ...fileWritesForCall('Write', { file_path: '/repo/src/b.ts' }, { tool_call_key: 'a2', session_id: 's9', ts: 150, cwd: '/repo' }),
    ...fileWritesForCall('Write', { file_path: '/etc/hosts' }, { tool_call_key: 'a3', session_id: 's9', ts: 240, cwd: '/repo' }),
  ]);
  db.prepare(
    `INSERT INTO anomalies (anomaly_key, rule, severity, tool, session_id, window_start, window_end, title, detail, observed, confidence, source, detected_at)
     VALUES ('an1', 'test_rule', 'high', 'Bash', 's9', 50, 250, 't', 'd', 1, 'exact', 'live', 250)`,
  ).run();

  assert.equal(upsertAnomalyContext(db), 1);
  let ctx = db.prepare('SELECT * FROM anomaly_context WHERE anomaly_key = ?').get('an1') as Record<string, unknown>;
  assert.equal(ctx.distinct_files, 3);
  assert.equal(ctx.out_of_repo_writes, 1);
  assert.equal(ctx.destructive_calls, 1);
  assert.equal(ctx.failed_calls, 1);
  assert.equal(ctx.unknown_outcome_calls, 1);
  assert.equal(ctx.window_end, 250);

  assert.equal(upsertAnomalyContext(db), 0, 'same window: no rewrite');
  db.prepare('UPDATE anomalies SET window_end = 400 WHERE anomaly_key = ?').run('an1');
  assert.equal(upsertAnomalyContext(db), 1, 'a grown window recomputes the reach');
  ctx = db.prepare('SELECT window_end FROM anomaly_context WHERE anomaly_key = ?').get('an1') as Record<string, unknown>;
  assert.equal(ctx.window_end, 400);
});

// ── posture.ts ─────────────────────────────────────────────────────────

test('autonomy_intervals: contiguous posture runs with the widened columns', () => {
  const runs = buildIntervalRuns(
    [
      { ts: 1, mode_raw: 'default', status: null },
      { ts: 2, mode_raw: 'default', status: 'error' },
      { ts: 3, mode_raw: 'bypassPermissions', status: null },
      { ts: 4, mode_raw: 'bypassPermissions', status: 'denied' },
    ],
    's1', null,
  );
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.mode_raw, 'default');
  assert.equal(runs[0]!.autonomy, 'default');
  assert.equal(runs[0]!.errors, 1);
  assert.equal(runs[1]!.autonomy, 'full_auto');
  assert.equal(runs[1]!.denied, 1);

  const db = store();
  insertToolCalls(db, [
    call({ tool_call_key: 'p1', session_id: 's2', ts: 10, permission_mode: 'default' }),
    call({ tool_call_key: 'p2', session_id: 's2', ts: 20, permission_mode: 'default' }),
    call({ tool_call_key: 'p3', session_id: 's2', ts: 30, permission_mode: 'bypassPermissions' }),
  ]);
  assert.equal(rebuildAutonomyIntervals(db), 2);
  assert.equal(rebuildAutonomyIntervals(db), 0, 'rebuild is idempotent once the ledger has not grown');
  const rows = db.prepare('SELECT mode_raw, autonomy, calls FROM autonomy_intervals ORDER BY started_at').all() as Record<string, unknown>[];
  assert.deepEqual(rows.map((r) => r.mode_raw), ['default', 'bypassPermissions']);
  assert.equal(rows[1]!.calls, 1);
});
