/**
 * Tier 3 identity machinery tests. Only this batch's own logic is covered
 * here; the collector/db.ts wiring is the integrator's.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache, type DB } from '../db';
import { recordIdentity } from '../identity';
import {
  classifyAccount, upsertSessionIdentity, detectAccountSwitched, detectShadowAccountOnCorporateRepo,
  seatInventory, parseRemote, repoRemoteOrigin, type SessionIdentityRow,
} from './accounts';
import {
  resolvePrincipal, recordPrincipal, principalRows, detectPrincipalConflicts,
} from './chain';
import { loadIdentityPolicy, identityPropose } from './policy';
import { tenancyAnchor, preTenancyCount, quarantinePreTenancy, pilotStart, pilotStatus, pilotGate } from './tenancy';
import { verifyIdentity } from './verify';
import { mcpEnabled, peopleViewGranted, restrictToCallerPrincipal, logAccess } from './access';
import { matchingWindows, runShellHistoryScan, eraseShellHistoryRows, shellHistoryEnabled } from '../scanners/shell-history';
import { surfacePrincipal, outranks } from './surface';

function freshDb(): { db: DB; dir: string } {
  resetDbCache();
  const dir = mkdtempSync(join(tmpdir(), 'vole-identity-'));
  const db = openDb(join(dir, 't.db'));
  return { db, dir };
}

const ENV_KEYS = ['VOLE_USER', 'VOLE_MCP_OFF', 'VOLE_HOME_OVERRIDE', 'VOLE_SCAN_SHELL_HISTORY', 'VOLE_BASIS'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv ??= Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

test('classifier: cloud provider from env flags and model-id shape', () => {
  assert.deepEqual(
    classifyAccount({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }),
    { account_class: 'cloud_provider', class_evidence: 'env.CLAUDE_CODE_USE_BEDROCK=1', console_invisible: true, cloud_provider: 'bedrock' },
  );
  assert.equal(classifyAccount({ model: 'us.anthropic.claude-sonnet-4-6' }).cloud_provider, 'bedrock');
  assert.equal(classifyAccount({ model: 'publishers/anthropic/models/claude-sonnet' }).cloud_provider, 'vertex');
  assert.equal(classifyAccount({ model: 'gpt-5/deployments/x' }).cloud_provider, 'foundry');
  assert.equal(classifyAccount({ model: 'claude-sonnet-4-6' }).cloud_provider, null);
});

test('classifier: base-URL override and router are console_invisible', () => {
  const r = classifyAccount({ env: { ANTHROPIC_BASE_URL: 'http://localhost:4444' } });
  assert.equal(r.console_invisible, true);
  assert.equal(r.account_class, 'unknown');
  const keyed = classifyAccount({ env: { ANTHROPIC_BASE_URL: 'http://localhost:4444', ANTHROPIC_API_KEY: 'sk' } });
  assert.equal(keyed.account_class, 'api_key');
  const router = classifyAccount({ routerConfigPresent: true });
  assert.equal(router.console_invisible, true);
  assert.equal(classifyAccount({ apiKeyHelper: '/bin/helper' }).console_invisible, true);
  assert.equal(classifyAccount({ env: {} }).console_invisible, false);
});

test('classifier: claude oauthAccount — verified cases', () => {
  const r = classifyAccount({ oauthAccount: { organizationType: 'claude_max', billingType: 'stripe_subscription', seatTier: null } });
  assert.equal(r.account_class, 'personal_oauth');
  assert.ok(r.class_evidence.includes('claude_max'));
  const seat = classifyAccount({ oauthAccount: { organizationType: 'enterprise', seatTier: 'default', organizationUuid: 'u1' } });
  assert.equal(seat.account_class, 'team_seat');
  const org = classifyAccount({ oauthAccount: { organizationType: 'enterprise', organizationUuid: 'u1', organizationRole: 'member' } });
  assert.equal(org.account_class, 'org_oauth');
});

test('classifier: codex and grok shapes', () => {
  assert.equal(classifyAccount({ codexPlan: 'team' }).account_class, 'team_seat');
  assert.equal(classifyAccount({ codexPlan: 'free' }).account_class, 'personal_oauth');
  assert.equal(classifyAccount({ codexAuthMode: 'chatgpt', codexApiKeyPresent: false }).account_class, 'personal_oauth');
  assert.equal(classifyAccount({ codexApiKeyPresent: true }).account_class, 'api_key');
  assert.equal(classifyAccount({ grokTeamIdPresent: true }).account_class, 'team_seat');
  assert.equal(classifyAccount({ grokAuthMode: 'oidc', grokPrincipalIdPresent: true }).account_class, 'personal_oauth');
  assert.equal(classifyAccount({}).account_class, 'unknown');
  assert.equal(classifyAccount({}).class_evidence, 'no identity-bearing field observed');
});

test('session_identity upsert: rank ladder, NULL-only widening, idempotency', () => {
  const { db } = freshDb();
  const base: SessionIdentityRow = { session_id: 's1', tool: 'codex', binding_evidence: 'ambient', plan: 'team' };
  upsertSessionIdentity(db, [base]);
  let row = db.prepare('SELECT * FROM session_identity WHERE session_id = ?').get('s1') as Record<string, unknown>;
  assert.equal(row.binding_evidence, 'ambient');
  assert.equal(row.plan, 'team');
  // A session line UPGRADES the binding but never rewrites the stored plan.
  upsertSessionIdentity(db, [{ ...base, binding_evidence: 'session_proved', plan: null, account_class: 'team_seat' }]);
  row = db.prepare('SELECT * FROM session_identity WHERE session_id = ?').get('s1') as Record<string, unknown>;
  assert.equal(row.binding_evidence, 'session_proved');
  assert.equal(row.plan, 'team', 'NULL never overwrites a stored fact');
  assert.equal(row.account_class, 'team_seat');
  // Rank is monotone: an ambient copy cannot demote a proved binding.
  upsertSessionIdentity(db, [{ ...base, binding_evidence: 'ambient', account_class: null }]);
  row = db.prepare('SELECT * FROM session_identity WHERE session_id = ?').get('s1') as Record<string, unknown>;
  assert.equal(row.binding_evidence, 'session_proved');
  assert.equal(row.account_class, 'team_seat');
  // Idempotent re-run stores nothing new.
  const n = (db.prepare('SELECT COUNT(*) AS n FROM session_identity').get() as { n: number }).n;
  upsertSessionIdentity(db, [{ ...base, binding_evidence: 'session_proved' }]);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM session_identity').get() as { n: number }).n, n);
});

test('account_switched: fires on transition, keyed on the observed session bucket, idempotent', () => {
  const { db } = freshDb();
  const t1 = Date.parse('2026-05-01T00:00:00Z');
  const t2 = Date.parse('2026-06-01T00:00:00Z');
  upsertSessionIdentity(db, [
    { session_id: 'a', tool: 'codex', device_key: 'dev1', plan: 'team', first_seen: t1, last_seen: t1 },
    { session_id: 'b', tool: 'codex', device_key: 'dev1', plan: 'free', first_seen: t2, last_seen: t2 },
    { session_id: 'c', tool: 'codex', device_key: 'dev1', plan: 'free', first_seen: t2 + 1000, last_seen: t2 + 1000 },
  ]);
  const a = detectAccountSwitched(db, t2 + 5000);
  assert.equal(a.length, 1, 'one transition, not one per session');
  assert.equal(a[0]!.rule, 'account_switched');
  assert.ok(a[0]!.anomaly_key.startsWith('live:identity:account_switch:codex:dev1:team:free:'));
  assert.ok(a[0]!.anomaly_key.endsWith(String(Math.floor(t2 / 86_400_000))), 'anchored on the observed session bucket');
  // Re-running detection over the same rows cannot produce a second incident.
  assert.equal(detectAccountSwitched(db, t2 + 999_999).length, 1);
});

test('recordIdentity: hostname history per (device, hostname), never overwritten', () => {
  const { db } = freshDb();
  recordIdentity(db, 'shiva', 'Marys-MacBook-Pro.local');
  recordIdentity(db, 'shiva', 'Marys-MacBook-Pro-2.local');
  recordIdentity(db, 'shiva', 'Marys-MacBook-Pro-2.local');
  const rows = db.prepare('SELECT hostname FROM hostname_history ORDER BY first_seen').all() as { hostname: string }[];
  assert.deepEqual(rows.map((r) => r.hostname), ['Marys-MacBook-Pro.local', 'Marys-MacBook-Pro-2.local']);
  assert.equal((db.prepare('SELECT hostname FROM devices').get() as { hostname: string }).hostname, 'Marys-MacBook-Pro-2.local');
});

test('resolvePrincipal: precedence env > identity file > os username, with source recorded', () => {
  const home = mkdtempSync(join(tmpdir(), 'vole-home-'));
  assert.equal(resolvePrincipal('floor-user').source, 'os_username');
  mkdirSync(join(home, '.vole'), { recursive: true });
  writeFileSync(join(home, '.vole', 'identity.json'), JSON.stringify({ principal: 'declared-user' }));
  process.env.VOLE_HOME_OVERRIDE = home;
  const fromFile = resolvePrincipal('floor-user');
  assert.equal(fromFile.source, 'identity_file');
  assert.equal(fromFile.username, 'declared-user');
  process.env.VOLE_USER = 'env-user';
  const fromEnv = resolvePrincipal('floor-user');
  assert.equal(fromEnv.source, 'env_vole_user');
  assert.equal(fromEnv.username, 'env-user');
  delete process.env.VOLE_USER;
  delete process.env.VOLE_HOME_OVERRIDE;
});

test('recordPrincipal: source transitions land in scope_history and validity windows', () => {
  const { db } = freshDb();
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const pk = recordPrincipal(db, { username: 'shiva', source: 'os_username', evidence: 'os', declared: false }, t0);
  let row = db.prepare('SELECT principal_source, valid_from, valid_to FROM principals WHERE principal_key = ?').get(pk) as Record<string, unknown>;
  assert.equal(row.principal_source, 'os_username');
  assert.equal(row.valid_to, null);
  const t1 = t0 + 1000;
  recordPrincipal(db, { username: 'shiva', source: 'env_vole_user', evidence: '$VOLE_USER', declared: true }, t1);
  row = db.prepare('SELECT principal_source, valid_from, valid_to FROM principals WHERE principal_key = ?').get(pk) as Record<string, unknown>;
  assert.equal(row.principal_source, 'env_vole_user');
  assert.equal(row.valid_from, t1);
  const scope = db.prepare('SELECT diff FROM scope_history').all() as { diff: string }[];
  assert.equal(scope.length, 1);
  assert.deepEqual(JSON.parse(scope[0]!.diff), { field: 'principal_source', from: 'os_username', to: 'env_vole_user' });
});

test('principalRows: read-time join with the bound/ambient/unbound triple and origin-unknown bucket', () => {
  const { db } = freshDb();
  const t = Date.parse('2026-01-01T00:00:00Z');
  db.prepare(`INSERT INTO usage_events (event_key, tool, ts, confidence, source, session_id, user, machine, total_tokens, cost_usd)
              VALUES ('k1', 'codex', ?, 'exact', 'live', 's1', 'shiva', 'm1', 100, 1.5)`).run(t);
  db.prepare(`INSERT INTO usage_events (event_key, tool, ts, confidence, source, session_id, user, machine, total_tokens, cost_usd)
              VALUES ('k2', 'opencode', ?, 'exact', 'live', 's2', NULL, NULL, 50, NULL)`).run(t);
  db.prepare(`INSERT INTO anomalies (anomaly_key, rule, severity, tool, window_start, window_end, title, detail, observed, confidence, source, detected_at, user, machine)
              VALUES ('ak1', 'repeat_call_loop', 'warn', 'codex', ?, ?, 't', 'd', 1, 'exact', 'live', ?, 'shiva', 'm1')`).run(t, t, t);
  recordIdentity(db, 'shiva', 'm1');
  upsertSessionIdentity(db, [
    { session_id: 's1', tool: 'codex', binding_evidence: 'session_proved', account_class: 'team_seat', plan: 'team', principal_key: (db.prepare('SELECT principal_key FROM principals').get() as { principal_key: string }).principal_key },
    { session_id: 'sX', tool: 'claude_code', binding_evidence: 'ambient', principal_key: (db.prepare('SELECT principal_key FROM principals').get() as { principal_key: string }).principal_key },
  ]);
  const { principals, originUnknown } = principalRows(db, false);
  assert.equal(principals.length, 1);
  const p = principals[0]!;
  assert.equal(p.calls, 1);
  assert.equal(p.tokens, 100);
  assert.equal(p.cost_usd, 1.5);
  assert.equal(p.incidents.warn, 1);
  assert.deepEqual([p.binding.session_proved, p.binding.ambient], [1, 1]);
  assert.equal(originUnknown.calls, 1, 'NULL-user rows land in the origin-unknown bucket, never in a person');
});

test('principal_conflict: one machine under two users, one user under two machines', () => {
  const { db } = freshDb();
  const t = Date.parse('2026-01-01T00:00:00Z');
  const ins = db.prepare(`INSERT INTO usage_events (event_key, tool, ts, confidence, source, user, machine) VALUES (?, 'codex', ?, 'exact', 'live', ?, ?)`);
  ins.run('k1', t, 'alice', 'mac1');
  ins.run('k2', t, 'bob', 'mac1');
  ins.run('k3', t, 'carol', 'mac2');
  ins.run('k4', t, 'carol', 'mac3');
  const a = detectPrincipalConflicts(db, t + 1000);
  assert.equal(a.length, 2);
  assert.ok(a.every((x) => x.rule === 'principal_conflict' && x.severity === 'info'));
  assert.ok(a.some((x) => x.anomaly_key.includes('mac1:alice|bob')));
  assert.ok(a.some((x) => x.anomaly_key.includes('carol:mac2|mac3')));
  assert.equal(detectPrincipalConflicts(db, t + 2000).length, 2, 'same utc day: no duplicate incidents');
});

test('tenancy: anchor precedence, quarantine and pre-tenancy count', () => {
  const home = mkdtempSync(join(tmpdir(), 'vole-tenancy-'));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ firstStartTime: Date.parse('2026-03-01T00:00:00Z') }));
  const anchor = tenancyAnchor(home)!;
  assert.equal(anchor.basis, 'claude_first_start');
  assert.equal(anchor.ts, Date.parse('2026-03-01T00:00:00Z'));

  const { db } = freshDb();
  const ins = db.prepare(`INSERT INTO usage_events (event_key, tool, ts, confidence, source) VALUES (?, 'codex', ?, 'exact', 'live')`);
  ins.run('old', Date.parse('2026-02-01T00:00:00Z')); // predecessor's row
  ins.run('new', Date.parse('2026-04-01T00:00:00Z')); // this principal's
  assert.equal(preTenancyCount(db, anchor), 1);
  const kept = quarantinePreTenancy(
    [
      { ts: Date.parse('2026-02-01T00:00:00Z') },
      { ts: Date.parse('2026-04-01T00:00:00Z') },
    ],
    anchor,
  );
  assert.equal(kept.length, 1);
  assert.equal(preTenancyCount(db, null), null, 'no anchor: inert and visible, never defaulted');
});

test('pilot mode: hard expiry auto-reverts every pilot-only path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-pilot-'));
  const file = join(dir, 'basis.json');
  const until = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const rec = pilotStart({ until, partner: 'Acme' }, file);
  assert.equal(rec.partner, 'Acme');
  let s = pilotStatus(Date.now(), file);
  assert.equal(s.active, true);
  assert.equal(s.gates.content_scanners, true);
  assert.ok(s.days_remaining! <= 5);
  s = pilotStatus(rec.until + 1, file);
  assert.equal(s.active, false);
  assert.equal(s.gates.content_scanners, false, 'expired: reverted automatically');
  assert.equal(pilotGate('sync', rec.until + 1, file), false);
  // Append-only: a second record never rewrites the first.
  pilotStart({ until: new Date(rec.until + 86_400_000).toISOString(), partner: 'Beta' }, file);
  const basis = JSON.parse(readFileSync(file, 'utf8')) as { pilot: { partner: string }[] };
  assert.equal(basis.pilot.length, 2);
  assert.equal(basis.pilot[0]!.partner, 'Acme', 'the first record is never rewritten');
});

test('identity policy: load with hash, propose from observed data, people_view gate', () => {
  const home = mkdtempSync(join(tmpdir(), 'vole-policy-'));
  mkdirSync(join(home, '.vole', 'policy'), { recursive: true });
  const policyFile = join(home, '.vole', 'policy', 'identity.json');
  const policyBody = {
    corporate_org_uuids: ['org-1'],
    corporate_repo_owners: ['corp-org'],
    sanctioned_account_classes: ['org_oauth'],
    people_view: { enabled: false },
  };
  writeFileSync(policyFile, JSON.stringify(policyBody));
  process.env.VOLE_HOME_OVERRIDE = home;
  const policy = loadIdentityPolicy();
  assert.ok(policy);
  assert.equal(policy!.corporate_repo_owners[0], 'corp-org');
  assert.equal(policy!.sha256.length, 64);
  assert.equal(peopleViewGranted(policy), false, 'absent/disabled people_view block is a hard off');

  const { db } = freshDb();
  upsertSessionIdentity(db, [{ session_id: 's1', tool: 'codex', org_id: 'observed-org', binding_evidence: 'session_proved', first_seen: 1, last_seen: 1 }]);
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ githubRepoPaths: { '/work/repo': { owner: 'acme', repo: 'thing' } } }));
  const proposed = JSON.parse(identityPropose(db, home)) as { corporate_org_uuids: string[]; corporate_repo_owners: string[] };
  assert.deepEqual(proposed.corporate_org_uuids, ['observed-org']);
  assert.deepEqual(proposed.corporate_repo_owners, ['acme']);
  assert.ok(!existsSync(join(home, '.vole', 'policy', 'identity.json.proposed')), 'propose writes nothing');
  delete process.env.VOLE_HOME_OVERRIDE;
});

test('shadow_account_on_corporate_repo: inert without policy, fires with session-proved class on a corporate remote', () => {
  const { db, dir } = freshDb();
  const inert = detectShadowAccountOnCorporateRepo(db, null);
  assert.equal(inert.anomalies.length, 0);
  assert.ok(inert.inertReason);

  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/corp-org/secrets.git\n');
  assert.equal(repoRemoteOrigin(repo), 'https://github.com/corp-org/secrets.git');
  assert.deepEqual(parseRemote('git@github.com:corp-org/secrets.git'), { host: 'github.com', owner: 'corp-org', repo: 'secrets' });

  const t = Date.parse('2026-05-01T00:00:00Z');
  db.prepare(`INSERT INTO usage_events (event_key, tool, ts, confidence, source, session_id, project) VALUES ('k1', 'codex', ?, 'exact', 'live', 's1', ?)`).run(t, repo);
  upsertSessionIdentity(db, [
    { session_id: 's1', tool: 'codex', account_class: 'personal_oauth', class_evidence: 'rate_limits.plan_type=free', binding_evidence: 'session_proved', first_seen: t, last_seen: t },
    // Ambient-only class: must render NULL, not a pass.
    { session_id: 's2', tool: 'codex', account_class: 'personal_oauth', binding_evidence: 'ambient', first_seen: t, last_seen: t },
  ]);
  const policy = { corporate_repo_owners: ['corp-org'], sanctioned_account_classes: ['org_oauth'], sha256: 'abc' };
  const { anomalies } = detectShadowAccountOnCorporateRepo(db, policy, t + 1000);
  assert.equal(anomalies.length, 1, 'only the session-proved row fires');
  assert.equal(anomalies[0]!.rule, 'shadow_account_on_corporate_repo');
  assert.ok(anomalies[0]!.anomaly_key.includes('s1'));
  assert.ok(anomalies[0]!.detail.includes('corp-org/secrets'));
  assert.ok(anomalies[0]!.detail.includes('abc'), 'the incident names the policy hash that judged it');
});

test('seat inventory: three named buckets against the seats_purchased block', () => {
  const { db } = freshDb();
  const t = Date.parse('2026-05-01T00:00:00Z');
  upsertSessionIdentity(db, [
    { session_id: 's1', tool: 'claude_code', plan: 'claude_max', principal_key: 'p1', first_seen: t, last_seen: t },
    { session_id: 's2', tool: 'claude_code', plan: 'claude_max', principal_key: 'p2', first_seen: t, last_seen: t },
    { session_id: 's3', tool: 'codex', plan: 'team', principal_key: 'p1', first_seen: t, last_seen: t },
  ]);
  const buckets = seatInventory(db, {
    claude_code: { plan: 'claude_max', seats: 5, price_usd: 100 },
    grok: { plan: 'x', seats: 2 },
  });
  const cc = buckets.find((b) => b.tool === 'claude_code')!;
  assert.equal(cc.no_usage_observed, 3, '5 seats, 2 principals observed — labelled no-usage-observed, never unused');
  assert.equal(cc.matched, true);
  assert.equal(cc.shadow_sessions, 0);
  const codex = buckets.find((b) => b.tool === 'codex')!;
  assert.equal(codex.shadow_sessions, 1, 'usage on a plan the company never bought');
  const grok = buckets.find((b) => b.tool === 'grok')!;
  assert.equal(grok.no_usage_observed, 2);
});

test('shell-history scanner: default off, byte prefilter, counters only, one-click erase', () => {
  const { db, dir } = freshDb();
  assert.equal(shellHistoryEnabled(), false, 'default OFF in every mode');
  const histFile = join(dir, 'zsh_history');
  writeFileSync(histFile, ['ls -la', 'claude --resume', 'export OPENAI_API_KEY=sk-nope', 'curl https://api.anthropic.com/v1', 'echo done', 'git status'].join('\n'));
  assert.deepEqual(matchingWindows(Buffer.from('nothing to see here at all\n'.repeat(100))), [], 'a clean window is never decoded');
  assert.equal(matchingWindows(readFileSync(histFile)).length, 1);
  const receipt = runShellHistoryScan(db, [{ key: 'zsh', path: histFile }], true);
  assert.equal(receipt.windows_matched, 1);
  assert.ok(receipt.rows_stored >= 2);
  const rows = db.prepare("SELECT counter_kind, counter FROM surface_activity WHERE surface_key = 'shell_history:zsh'").all() as { counter_kind: string; counter: number }[];
  assert.ok(rows.some((r) => r.counter_kind === 'ai_cli_lines' && r.counter === 1));
  assert.ok(rows.some((r) => r.counter_kind === 'api_key_name_lines'));
  // No command body ever lands anywhere: only counter rows exist for the sink.
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM surface_activity WHERE surface_key LIKE 'shell_history:%'").get() as { n: number }).n, rows.length);
  assert.ok(eraseShellHistoryRows(db) >= rows.length);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM surface_activity WHERE surface_key LIKE 'shell_history:%'").get() as { n: number }).n, 0);
});

test('mcp gates: master off switch, access log, caller restriction', () => {
  const { db } = freshDb();
  assert.equal(mcpEnabled().enabled, true);
  process.env.VOLE_MCP_OFF = '1';
  assert.equal(mcpEnabled().enabled, false);
  delete process.env.VOLE_MCP_OFF;

  logAccess(db, 'mcp:ppid=1:user=x:cwd=/tmp', 'mcp_query', 'vole_summary');
  const log = db.prepare('SELECT accessor, purpose, view FROM access_log').all() as { accessor: string; purpose: string; view: string }[];
  assert.equal(log.length, 1);
  assert.equal(log[0]!.view, 'vole_summary');

  recordIdentity(db, 'alice', 'm1');
  assert.equal(restrictToCallerPrincipal(db, null), false, 'one principal: unrestricted');
  recordIdentity(db, 'bob', 'm1');
  assert.equal(restrictToCallerPrincipal(db, null), true, 'two principals: hard off without the policy grant');
  assert.equal(restrictToCallerPrincipal(db, { corporate_org_uuids: [], corporate_email_domains: [], corporate_repo_owners: [], sanctioned_account_classes: [], source: '', sha256: '', people_view: { enabled: true } }), false);
});

test('verify --identity: fails on an email or name in any identity column, passes clean', () => {
  const home = mkdtempSync(join(tmpdir(), 'vole-verify-'));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'dev@corp.com', fullName: 'Dev Person', displayName: 'Dev' } }));
  const { db } = freshDb();
  let r = verifyIdentity(db, home);
  assert.equal(r.ok, true);
  db.prepare(`INSERT INTO usage_events (event_key, tool, ts, confidence, source, user) VALUES ('k1', 'codex', 1, 'exact', 'live', 'dev@corp.com')`).run();
  r = verifyIdentity(db, home);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.includes('email-shaped token')));
  db.prepare("DELETE FROM usage_events WHERE event_key = 'k1'").run();
  db.prepare(`INSERT INTO principals (principal_key, display, first_seen, last_seen) VALUES ('p:notadigest', 'Dev Person', 1, 1)`).run();
  r = verifyIdentity(db, home);
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.includes('name field')));
  assert.ok(r.findings.some((f) => f.includes('non-digest')));
});

test('surface_principal: uid/mtime evidence and git-identity domain+HMAC only', () => {
  const { dir } = freshDb();
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'config'), '[user]\n\temail = dev@corp.com\n');
  const f = join(repo, 'config.json');
  writeFileSync(f, '{}');
  const sp = surfacePrincipal(f, repo)!;
  assert.equal(sp.binding_evidence, 'file_owner');
  assert.equal(sp.git_email_domain, 'corp.com');
  assert.ok(/^[0-9a-f]{64}$/.test(sp.git_email_hmac!));
  assert.ok(!JSON.stringify(sp).includes('dev@corp.com'), 'the address itself is never in the attribution');
  assert.ok(outranks('ambient', 'file_owner'), 'file_owner sits below every session-derived rank');
  assert.equal(surfacePrincipal(join(dir, 'missing')), null);
});
