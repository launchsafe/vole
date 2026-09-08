import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp: string;
let home: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vole-grants-'));
  home = join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  process.env.VOLE_HOME_OVERRIDE = home;
  process.env.VOLE_DB = join(tmp, 'vole.db');
});

let dbMod: typeof import('../db');
const dbFor = async (name: string) => {
  dbMod ??= await import('../db');
  dbMod.resetDbCache();
  return dbMod.openDb(join(tmp, name));
};
const closeDb = () => dbMod!.resetDbCache();

test('entry classification: the four blanket classes', async () => {
  const { classifyGrantEntry } = await import('./grants');
  assert.equal(classifyGrantEntry('Bash(git *)'), 'prefix_wildcard');
  assert.equal(classifyGrantEntry('Bash(*)'), 'tool_wildcard');
  assert.equal(classifyGrantEntry('Bash'), 'tool_wildcard');
  assert.equal(classifyGrantEntry('Read(~/.zshenv)'), 'exact');
  assert.equal(classifyGrantEntry('mcp__github'), 'mcp_server_wildcard');
  assert.equal(classifyGrantEntry('mcp__github__*'), 'mcp_server_wildcard');
});

test('the matcher: prefix wildcards match command shape, exact entries stay tool-level', async () => {
  const { entryMatchesCall } = await import('./grants');
  assert.ok(entryMatchesCall('Bash(git *)', 'Bash', 'git push'));
  assert.ok(!entryMatchesCall('Bash(git *)', 'Bash', 'rm -rf'));
  assert.ok(entryMatchesCall('Bash(*)', 'Bash', 'rm -rf'));
  assert.ok(!entryMatchesCall('Bash(*)', 'Read', null));
  assert.ok(entryMatchesCall('mcp__github', 'mcp__github__search_issues', null));
  assert.ok(!entryMatchesCall('mcp__github', 'mcp__ghost__x', null));
  assert.ok(entryMatchesCall('Read', 'Read', null));
});

test('path classes follow the precedence chain, not the file name', async () => {
  const { pathClassOf } = await import('./grants');
  assert.equal(pathClassOf('/Library/Application Support/ClaudeCode/managed-settings.json'), 'managed');
  assert.equal(pathClassOf(join(home, '.claude', 'settings.json')), 'user');
  assert.equal(pathClassOf(join(home, '.claude.json')), 'user');
  assert.equal(pathClassOf(join(tmp, 'repo', '.claude', 'settings.local.json')), 'repo_controlled');
  assert.equal(pathClassOf(join(tmp, 'repo', '.mcp.json')), 'repo_controlled');
  assert.equal(pathClassOf(join(home, '.codex', 'requirements.toml')), 'managed');
});

test('widening is NULL-only and never overwrites a stored precedence', async () => {
  const { openDb } = await import('../db');
  const { widenGrantPrecedence } = await import('./grants');
  const db = await dbFor('a.db');
  const now = Date.parse('2026-09-07T00:00:00Z');
  const g = db.prepare(`
    INSERT INTO grants (grant_key, agent, source_file, kind, entry, granted_by, first_seen, last_seen)
    VALUES (?, 'claude_code', ?, 'allow', 'Bash(git *)', 'someone', ?, ?)`);
  g.run('k1', join(home, '.claude', 'settings.json'), now, now);
  db.prepare(`INSERT INTO grants (grant_key, agent, source_file, kind, entry, first_seen, last_seen) VALUES ('k2', 'claude_code', ?, 'allow', 'Read', ?, ?)`)
    .run(join(home, '.claude', 'settings.json'), now, now);
  widenGrantPrecedence(db, now + 1);
  const r1 = db.prepare('SELECT granted_by, path_class, entry_class FROM grants WHERE grant_key = ?').get('k1') as Record<string, unknown>;
  assert.equal(r1.granted_by, 'someone'); // stored fact survives
  assert.equal(r1.path_class, 'user');
  assert.equal(r1.entry_class, 'prefix_wildcard'); // NULL was filled
  const r2 = db.prepare('SELECT granted_by, path_class, origin, scope, entry_class FROM grants WHERE grant_key = ?').get('k2') as Record<string, unknown>;
  assert.equal(r2.granted_by, join(home, '.claude', 'settings.json'));
  assert.equal(r2.path_class, 'user');
  assert.equal(r2.origin, 'file');
  assert.equal(r2.scope, 'global');
  assert.equal(r2.entry_class, 'tool_wildcard');
  closeDb();
});

test('blanket inventory: wildcard rules get their authorised calls, unmatched go to posture', async () => {
  const { openDb } = await import('../db');
  const { insertToolCalls } = await import('../toolcalls/bind');
  const { blanketInventory } = await import('./grants');
  const db = await dbFor('b.db');
  const now = Date.parse('2026-09-07T00:00:00Z');
  db.prepare(`INSERT INTO grants (grant_key, agent, source_file, kind, entry, entry_class, first_seen, last_seen) VALUES ('g1', 'claude_code', '/s', 'allow', 'Bash(git *)', 'prefix_wildcard', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO grants (grant_key, agent, source_file, kind, entry, entry_class, first_seen, last_seen) VALUES ('g2', 'claude_code', '/s', 'allow', 'Read', 'tool_wildcard', ?, ?)`).run(now, now);
  insertToolCalls(db, [
    { tool_call_key: 'c1', tool: 'claude_code', name: 'Bash', shape: 'git push', session_id: 's', ts: now },
    { tool_call_key: 'c2', tool: 'claude_code', name: 'Bash', shape: 'git status', session_id: 's', ts: now },
    { tool_call_key: 'c3', tool: 'claude_code', name: 'Bash', shape: 'rm -rf', session_id: 's', ts: now }, // covered tool, uncovered shape
    { tool_call_key: 'c4', tool: 'claude_code', name: 'Read', session_id: 's', ts: now },
    { tool_call_key: 'c5', tool: 'claude_code', name: 'WebFetch', session_id: 's', ts: now }, // no entry at all
  ]);
  const r = blanketInventory(db, now);
  assert.equal(r.wildcardCalls, 3); // 2 git + 1 Read
  // posture-attributed: rm -rf (Bash not authorised by THIS entry) + WebFetch
  assert.equal(r.postureCalls, 2);
  closeDb();
});

test('kiro log: the always-accept click persists a wildcard rule with rule-count delta', async () => {
  const { parseKiroLog, parseKiroPermissionsYaml } = await import('./grants');
  const log = `
[2026-08-20 10:00:00.123] [ACP ToolApproval] Got response: {'optionId':'always-accept'}
[2026-08-20 10:00:00.253] [PolicySession] Persisted allow rule for shell matching 'echo *' at scope=workspace
[2026-08-20 10:00:00.900] [PolicySession] rebuild() complete: 17 rules parsed
[ACP ToolApproval] Got response: {'optionId':'allow-once'}
[PolicySession] Persisted allow rule for shell matching 'git *' at scope=user
[PolicySession] rebuild() complete: 18 rules parsed
[GovernanceService] Resolved {'enterprise':true,'autonomousAgentsDisabled':true,'mcpDisabled':false}
[KiroAgent] agent_controller.triggered {autonomyMode:'Autopilot'}
`;
  const parsed = parseKiroLog(log, 12345);
  assert.equal(parsed.rules.length, 2);
  const echo = parsed.rules[0]!;
  assert.ok(echo.by_click); // within 130 ms of the always-accept response
  assert.equal(echo.scope, 'workspace');
  assert.equal(echo.rule_count, null); // the 17-rules line arrives after
  const git = parsed.rules[1]!;
  assert.ok(!git.by_click); // an allow-once preceded it
  assert.equal(parsed.governance?.autonomousAgentsDisabled, true);
  assert.ok(parsed.autopilot);
  const yaml = parseKiroPermissionsYaml(`
capability: shell
effect: allow
match: [git *]
`);
  assert.equal(yaml.length, 1);
  assert.deepEqual(yaml[0]!.match, ['git *']);
});

test('injection matrix: names and hosts only, credential shape flagged', async () => {
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'config.toml'), `
[shell_environment_policy]
inherit = "core"
[shell_environment_policy.set]
ANTHROPIC_AUTH_TOKEN = "sk-ant-value-never-stored"
ANTHROPIC_BASE_URL = "http://localhost:4141"
ANTHROPIC_MODEL = "claude-opus-4.6"
`);
  const { parseCodexShellEnvironment, injectionMatrix, affectsAgent, parseHost } = await import('./grants');
  const parsed = parseCodexShellEnvironment(`
[shell_environment_policy]
inherit = "core"
[shell_environment_policy.set]
ANTHROPIC_AUTH_TOKEN = "sk-ant-value"
ANTHROPIC_BASE_URL = "http://localhost:4141"
`);
  assert.equal(parsed.inherit, 'core');
  assert.deepEqual(Object.keys(parsed.set).sort(), ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
  assert.equal(affectsAgent('ANTHROPIC_BASE_URL'), 'claude_code');
  assert.equal(affectsAgent('OPENAI_API_KEY'), 'codex');
  assert.equal(parseHost('http://localhost:4141'), 'localhost:4141');
  assert.equal(parseHost('not a url'), null);
  const cells = injectionMatrix();
  assert.equal(cells.length, 3);
  const base = cells.find((c) => c.varName === 'ANTHROPIC_BASE_URL')!;
  assert.equal(base.setBy, 'codex');
  assert.equal(base.affects, 'claude_code');
  assert.equal(base.host, 'localhost:4141');
  assert.ok(base.credentialShaped === false);
  const token = cells.find((c) => c.varName === 'ANTHROPIC_AUTH_TOKEN')!;
  assert.ok(token.credentialShaped);
  assert.equal(token.host, null); // not a URL: no host, and the value never leaves memory
});

test('workspace trust: untrusted cwd with live activity fires untrusted_execution', async () => {
  const { openDb, insertEvents } = await import('../db');
  const { sweepWorkspaceTrust } = await import('./grants');
  const { loadState } = await import('./shared');
  const db = await dbFor('c.db');
  const now = Date.parse('2026-09-07T00:00:00Z');
  const untrusted = join(tmp, 'untrusted-repo');
  mkdirSync(untrusted, { recursive: true });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    projects: {
      [untrusted]: { hasTrustDialogAccepted: false },
      [join(tmp, 'trusted-repo')]: { hasTrustDialogAccepted: true },
    },
  }));
  insertEvents(db, [{
    event_key: 'e1', tool: 'claude_code', model: null, session_id: 's1', project: untrusted,
    git_branch: null, ts: now, input_tokens: null, output_tokens: null, cache_write_5m_tokens: null,
    cache_write_1h_tokens: null, cache_read_tokens: null, reasoning_tokens: null, total_tokens: null,
    cost_usd: null, confidence: 'activity_only', is_error: 0, stop_reason: null, source: 'live',
    raw_ref: null, tools: null, agent_id: null, context_window: null, duration_ms: null, duration_kind: null,
  }]);
  const state = loadState();
  const r = sweepWorkspaceTrust(db, state, now);
  assert.equal(r.untrusted, 1);
  assert.equal(r.incidents, 1);
  const row = db.prepare("SELECT severity, rule FROM anomalies").get() as { severity: string; rule: string };
  assert.equal(row.rule, 'untrusted_execution');
  assert.equal(row.severity, 'warn');
  const again = sweepWorkspaceTrust(db, state, now + 1);
  assert.equal(again.incidents, 1); // idempotent keying: still one incident
  closeDb();
});

test('overrides: the guardrail-weakening keys, with the file that said them', async () => {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
    skipDangerousModePermissionPrompt: true,
    remoteControlAtStartup: false,
    env: { ANTHROPIC_API_KEY: 'never-stored' },
  }));
  const { openDb } = await import('../db');
  const { sweepOverrides } = await import('./grants');
  const db = await dbFor('d.db');
  const now = Date.parse('2026-09-07T00:00:00Z');
  const n = sweepOverrides(db, now);
  assert.equal(n, 3);
  const entries = db.prepare('SELECT kind, entry FROM overrides ORDER BY kind').all() as { kind: string; entry: string }[];
  assert.deepEqual(entries.map((e) => e.kind).sort(), ['env:ANTHROPIC_API_KEY', 'remoteControlAtStartup', 'skipDangerousModePermissionPrompt']);
  const env = entries.find((e) => e.kind === 'env:ANTHROPIC_API_KEY')!;
  assert.ok(env.entry.includes('value not stored'));
  closeDb();
});
