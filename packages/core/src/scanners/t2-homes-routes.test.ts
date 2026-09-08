import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../sqlite';
import { openDb, insertEvents, insertAnomalies } from '../db';
import type { UsageEvent } from '../types';
import { agentHomes, editorRoots, shellRcAgentHomes, policyExtraRoots } from '../paths';
import {
  censusRoots, checkAgentHomeMoved, liveSessionFiles, parsePsEnv, probeRoot,
  transcriptRootFor, upsertAgentRoots, recordScanAccess,
} from './homes';
import {
  collectRoutes, customKeyLabels, parseAiderConf, parseCCRConfig, parseContinueConfig,
  parseLiteLLMYaml, transportClass, upsertModelRoutes, routesScanner,
} from './routes';
import { enumerateContexts, localPathOf, sshContexts, stampExecutionContexts, workspaceContexts } from './contexts';
import {
  browserAssistants, classifyContributes, extractModelSelections, installedExtensions,
  parseLanguageModelAccess, parseLanguageModelStats, vscodeStateScanner, workspaceActivation,
} from './vscode-state';
import { agentHostDeletedSessions, kiroDeletedSessions, deletedSessionsScanner } from './deleted-sessions';
import { parseCloudSubscriptionOptIn, parseGenerativePartnerSettings, osIntelligenceScanner } from './os-intelligence';

let tmp = '';
let home = '';
const savedEnv: Record<string, string | undefined> = {};

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vole-t2-'));
  home = join(tmp, 'home');
  for (const k of ['VOLE_HOME_OVERRIDE', 'VOLE_DB', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_HOME']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.VOLE_HOME_OVERRIDE = home;
  process.env.VOLE_DB = join(tmp, 'vole.db');
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const mkdir = (...p: string[]) => mkdirSync(join(...p), { recursive: true });
const wf = (p: string, content: string) => {
  mkdir(join(p, '..'));
  writeFileSync(p, content);
};

/** A minimal valid UsageEvent for stamping tests. */
function ev(event_key: string, project: string, session: string): UsageEvent {
  return {
    event_key, tool: 'claude_code', model: 'claude-sonnet-5', session_id: session,
    project, git_branch: null, ts: 1700000000000, input_tokens: 1, output_tokens: 2,
    cache_write_5m_tokens: null, cache_write_1h_tokens: null, cache_read_tokens: null,
    reasoning_tokens: null, total_tokens: 3, cost_usd: null, confidence: 'exact',
    is_error: 0, stop_reason: null, source: 'live', raw_ref: null, tools: null,
    agent_id: null, context_window: null, duration_ms: null, duration_kind: null,
  };
}

function makeVscdb(p: string, rows: [string, string][]) {
  mkdir(join(p, '..'));
  const db = new Database(p);
  db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  const stmt = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
  for (const [k, v] of rows) stmt.run(k, v);
  db.close();
}

// ── paths.ts resolvers ───────────────────────────────────────────────────────

test('editorRoots: marker test, not a name list', () => {
  mkdir(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage');
  wf(join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'storage.json'), '{}');
  mkdir(home, 'Library', 'Application Support', 'ZCode', 'User'); // lookalike, no marker
  mkdir(home, 'Library', 'Application Support', 'Antigravity'); // lookalike, no User tree
  const roots = editorRoots();
  assert.ok(roots.some((r) => r.app === 'Code'));
  assert.ok(!roots.some((r) => r.app === 'ZCode'));
  assert.ok(!roots.some((r) => r.app === 'Antigravity'));
});

test('shellRcAgentHomes finds exported redirects, skips comments', () => {
  wf(join(home, '.zshrc'), [
    '# export CODEX_HOME=/ignored/path',
    'export CLAUDE_CONFIG_DIR=' + join(tmp, 'alt-claude'),
    'CODEX_HOME=' + join(tmp, 'alt-codex'),
    'export UNRELATED=x',
  ].join('\n'));
  const rc = shellRcAgentHomes();
  assert.deepEqual(
    rc.map((r) => r['envVar' as never]).sort(),
    ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'],
  );
  assert.ok(agentHomes().some((h) => h.path === join(tmp, 'alt-claude') && h.granted_by.startsWith('rc:')));
  assert.ok(agentHomes().some((h) => h.path === join(tmp, 'alt-codex')));
});

test('policyExtraRoots reads extra_roots[] from policy.json', () => {
  mkdir(home, '.vole', 'policy');
  wf(join(home, '.vole', 'policy', 'policy.json'), JSON.stringify({ extra_roots: [{ root: join(tmp, 'admin-root'), tool: 'claude_code' }] }));
  assert.deepEqual(policyExtraRoots(), [{ root: join(tmp, 'admin-root'), tool: 'claude_code' }]);
  assert.ok(agentHomes().some((h) => h.path === join(tmp, 'admin-root') && h.granted_by === 'policy'));
});

// ── homes scanner ────────────────────────────────────────────────────────────

test('probeRoot four states and agent_roots upsert idempotency', () => {
  assert.equal(probeRoot(join(tmp, 'not-there')).state, 'absent');
  const okDir = join(tmp, 'okdir');
  mkdir(okDir);
  const probed = probeRoot(okDir);
  assert.equal(probed.state, 'ok');
  assert.equal(probed.entries, 0);

  const db = openDb();
  const rows = censusRoots();
  upsertAgentRoots(db, rows, 1000);
  upsertAgentRoots(db, rows, 2000); // idempotent
  const stored = db.prepare('SELECT * FROM agent_roots').all() as { root_path: string; first_seen: number; last_seen: number }[];
  assert.equal(stored.length, rows.length);
  for (const r of stored) assert.equal(r.first_seen, 1000);
  assert.equal(recordScanAccess(db, rows, 2000).ok > 0, true);
  const sa = db.prepare("SELECT * FROM scan_access WHERE launch_context = 'scanner:homes'").all() as { root: string; state: string }[];
  assert.ok(sa.length >= rows.length);
  assert.ok(sa.every((r) => ['ok', 'absent', 'eperm', 'error'].includes(r.state)));
});

test('agent_home_moved fires on a live session outside every known root', () => {
  const known = '22222222-2222-2222-2222-222222222222';
  const missing = '33333333-3333-3333-3333-333333333333';
  mkdir(home, '.claude', 'projects', 'slug-a');
  wf(join(home, '.claude', 'projects', 'slug-a', `${known}.jsonl`), '{}');
  mkdir(home, '.claude', 'sessions');
  wf(join(home, '.claude', 'sessions', '123.json'), JSON.stringify({ pid: -1, sessionId: known }));
  wf(join(home, '.claude', 'sessions', '456.json'), JSON.stringify({ pid: -1, sessionId: missing }));

  assert.ok(liveSessionFiles(join(home, '.claude')).length === 2);
  const roots = [join(home, '.claude', 'projects')];
  assert.equal(transcriptRootFor(known, roots), roots[0]);
  assert.equal(transcriptRootFor(missing, roots), null);
  assert.deepEqual(parsePsEnv('claude CLAUDE_CONFIG_DIR=/x/y ANTHROPIC_BASE_URL=http://1.2.3.4'), {
    CLAUDE_CONFIG_DIR: '/x/y',
    ANTHROPIC_BASE_URL: 'http://1.2.3.4',
  });

  const db = openDb();
  upsertAgentRoots(db, censusRoots(), Date.now());
  const anomalies = checkAgentHomeMoved(db, Date.now());
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0]!.rule, 'agent_home_moved');
  assert.equal(anomalies[0]!.anomaly_key, `agent_home_moved:session:${missing}`);
  const again = checkAgentHomeMoved(db, Date.now());
  assert.equal(again.length, 1); // stable key, not now()-derived
});

// ── routes scanner ───────────────────────────────────────────────────────────

test('parseLiteLLMYaml: alias map with api_base and key presence', () => {
  const yaml = [
    'model_list:',
    '  - model_name: claude-sonnet-5',
    '    litellm_params:',
    '      model: qwen/qwen3.8-27b-fp8',
    '      api_base: http://89.169.113.254:4000',
    '      api_key: os.environ/SET_KEY',
    '  - model_name: "gpt-5"',
    '    litellm_params:',
    '      model: openai/gpt-5',
    '      api_base: https://api.openai.com/v1',
    '      api_key: sk-not-stored',
    'litellm_settings:',
    '  drop_params: true',
  ].join('\n');
  process.env.SET_KEY = 'present-but-never-read';
  const routes = parseLiteLLMYaml(yaml);
  assert.equal(routes.length, 2);
  assert.deepEqual(routes[0], {
    alias: 'claude-sonnet-5', target_model: 'qwen/qwen3.8-27b-fp8',
    api_base: 'http://89.169.113.254:4000', api_key_present: 1, source: '',
  });
  assert.equal(routes[1]!.alias, 'gpt-5');
  assert.equal(routes[1]!.api_key_present, 1);
  delete process.env.SET_KEY;
  assert.equal(parseLiteLLMYaml(yaml)[0]!.api_key_present, 0); // env name absent → 0, never a guess
});

test('parseCCRConfig and parseContinueConfig and parseAiderConf', () => {
  const ccr = parseCCRConfig(JSON.stringify({
    Providers: [
      { name: 'qwen', api_base_url: 'http://127.0.0.1:4000', api_key: 'x', models: ['qwen3.8'] },
    ],
    Router: { default: 'qwen,qwen3.8', 'sonnet-proxy': 'qwen,qwen3.8' },
  }));
  assert.equal(ccr.length, 2);
  assert.equal(ccr[0]!.alias, 'default');
  assert.equal(ccr[1]!.target_model, 'qwen3.8');
  assert.equal(ccr[1]!.api_base, 'http://127.0.0.1:4000');
  assert.equal(ccr[1]!.api_key_present, 1);

  const cont = parseContinueConfig(JSON.stringify({
    models: [{ title: 'local-qwen', provider: 'ollama', model: 'qwen3.8', apiBase: 'http://localhost:11434' }],
  }));
  assert.equal(cont[0]!.alias, 'local-qwen');
  assert.equal(cont[0]!.api_key_present, null);

  const aider = parseAiderConf('model: gpt-5\nopenai-api-base: https://gw.internal/v1\n');
  assert.equal(aider[0]!.alias, 'gpt-5');
  assert.equal(aider[0]!.api_base, 'https://gw.internal/v1');
});

test('transportClass flags plaintext and bare-IP upstreams', () => {
  assert.equal(transportClass('http://89.169.113.254:4000'), 'http');
  assert.equal(transportClass('https://89.169.113.254/v1'), 'bare_ip');
  assert.equal(transportClass('https://api.anthropic.com'), 'https');
  assert.equal(transportClass(null), null);
});

test('customKeyLabels: approved and rejected labels, never values', () => {
  const labels = customKeyLabels(JSON.stringify({
    customApiKeyResponses: { approved: ['not-needed'], rejected: ['sk-litellm-local'] },
  }));
  assert.deepEqual(labels, [
    { key_name: 'not-needed', verdict: 'approved' },
    { key_name: 'sk-litellm-local', verdict: 'rejected' },
  ]);
});

test('model_routes upsert: idempotent, api_key_present never demoted to unknown', () => {
  const db = openDb();
  const route = { alias: 'a', target_model: 'm', api_base: 'http://x', api_key_present: 1 as number | null, source: 'src:a' };
  upsertModelRoutes(db, [route], 1000);
  upsertModelRoutes(db, [{ ...route, api_key_present: null }], 2000);
  let row = db.prepare('SELECT * FROM model_routes').get() as { api_key_present: number; last_seen: number };
  assert.equal(row.api_key_present, 1);
  assert.equal(row.last_seen, 2000);
  upsertModelRoutes(db, [{ ...route, api_key_present: 0 }], 3000);
  row = db.prepare('SELECT * FROM model_routes').get() as { api_key_present: number; last_seen: number };
  assert.equal(row.api_key_present, 0); // a measured change is a change, an unknown is not
});

test('routesScanner end-to-end against fixture configs', () => {
  mkdir(home, '.config', 'litellm');
  wf(join(home, '.config', 'litellm', 'config.yaml'), [
    'model_list:',
    '  - model_name: claude-sonnet-5',
    '    litellm_params:',
    '      model: qwen/qwen3.8-27b-fp8',
    '      api_base: http://89.169.113.254:4000',
    '      api_key: sk-x',
  ].join('\n'));
  wf(join(home, '.claude.json'), JSON.stringify({ customApiKeyResponses: { rejected: ['sk-litellm-local'] } }));
  mkdir(home, '.claude');
  wf(join(home, '.claude', 'settings.json.ccr-20250101'), '{}');
  wf(join(home, '.zshrc'), 'export ANTHROPIC_BASE_URL=https://my-gw.example.com\n');

  const routes = collectRoutes();
  assert.equal(routes.length, 1);
  assert.equal(routes[0]!.source, 'litellm:config.yaml:claude-sonnet-5');

  const result = routesScanner.run();
  assert.equal(result.ok, true);
  const db = openDb();
  const mr = db.prepare('SELECT * FROM model_routes').all() as { route_key: string; alias: string; api_base: string; api_key_present: number }[];
  assert.ok(mr.some((r) => r.alias === 'claude-sonnet-5' && r.api_base === 'http://89.169.113.254:4000' && r.api_key_present === 1));
  const pk = db.prepare('SELECT * FROM provider_keys').all() as { key_name: string; shape: string }[];
  assert.ok(pk.some((r) => r.key_name === 'sk-litellm-local' && r.shape === 'custom-api-key-label:rejected'));
  const surfaces = (db.prepare("SELECT surface_key FROM ai_surfaces WHERE scanner = 'routes'").all() as { surface_key: string }[]).map((r) => r.surface_key);
  assert.ok(surfaces.includes('ccr-backup:settings.json.ccr-20250101'));
  assert.ok(surfaces.includes('env-route:ANTHROPIC_BASE_URL'));
});

// ── contexts scanner ─────────────────────────────────────────────────────────

test('workspace/ssh/docker context enumeration and execution_context_id stamping', () => {
  const codeRoot = join(home, 'Library', 'Application Support', 'Code');
  mkdir(codeRoot, 'User', 'globalStorage');
  wf(join(codeRoot, 'User', 'globalStorage', 'storage.json'), JSON.stringify({
    profileAssociations: { workspaces: { 'file:///repoC': 'default' } },
    backupWorkspaces: { folders: [{ folderUri: 'file:///repoD' }] },
    windowsState: { lastActiveWindow: { folder: 'file:///repoE' } },
  }));
  mkdir(codeRoot, 'User', 'workspaceStorage', 'hash1');
  wf(join(codeRoot, 'User', 'workspaceStorage', 'hash1', 'workspace.json'), JSON.stringify({ folder: 'file:///repoA' }));
  makeVscdb(join(codeRoot, 'User', 'globalStorage', 'state.vscdb'), [
    ['history.recentlyOpenedPathsList', JSON.stringify({ entries: [{ folderUri: 'file:///repoB' }, { folderUri: 'vscode-remote://ssh-remote+b300/workspace' }] })],
  ]);
  wf(join(home, '.ssh', 'config'), 'Host b300\n  HostName h.internal\nHost *\n  User x\n');

  const ws = workspaceContexts(codeRoot, 'Code');
  const uris = ws.map((c) => c.detail).sort();
  assert.deepEqual(uris, ['file:///repoA', 'file:///repoB', 'file:///repoC', 'file:///repoD', 'file:///repoE'].concat(['vscode-remote://ssh-remote+b300/workspace']).sort());
  const remote = ws.find((c) => c.kind === 'remote_workspace');
  assert.equal(remote?.label, 'ssh-remote+b300 (remote workspace)');
  assert.equal(localPathOf('file:///repoA'), '/repoA');
  assert.equal(localPathOf('vscode-remote://x/y'), null);
  assert.ok(sshContexts().some((c) => c.context_key === 'ssh:b300'));

  mkdir(home, '.docker', 'contexts', 'meta', 'abc');
  wf(join(home, '.docker', 'config.json'), JSON.stringify({ currentContext: 'colima' }));
  wf(join(home, '.docker', 'contexts', 'meta', 'abc', 'meta.json'), JSON.stringify({ Name: 'colima', Endpoints: { docker: { Host: 'unix:///x' } } }));

  const all = enumerateContexts();
  assert.ok(all.some((c) => c.kind === 'docker' && c.context_key === 'docker:colima'));
  const ctxKeys = new Set(all.map((c) => c.context_key));
  assert.equal(ctxKeys.size, all.length); // deduped, stable

  const db = openDb();
  insertEvents(db, [ev('k1', '/repoA', 'sess-1'), ev('k2', '/nowhere', 'sess-1')]);
  insertAnomalies(db, [{
    anomaly_key: 'anom-1', rule: 'repeat_call_loop', severity: 'warn', tool: 'claude_code',
    session_id: 'sess-1', model: null, window_start: 1, window_end: 2, title: 't', detail: 'd',
    observed: 1, baseline: null, threshold: null, confidence: 'exact', source: 'live', detected_at: 3,
  }]);
  const stamped = stampExecutionContexts(db, all);
  assert.equal(stamped.events, 1); // only /repoA matched a workspace folder
  const row = db.prepare("SELECT execution_context_id FROM usage_events WHERE event_key = 'k1'").get() as { execution_context_id: string };
  assert.match(row.execution_context_id, /^ws:[0-9a-f]{12}$/);
  const unmatched = db.prepare("SELECT execution_context_id FROM usage_events WHERE event_key = 'k2'").get() as { execution_context_id: string | null };
  assert.equal(unmatched.execution_context_id, null); // unknown stays NULL, never guessed
  const anom = db.prepare('SELECT execution_context_id FROM anomalies').get() as { execution_context_id: string };
  assert.equal(anom.execution_context_id, row.execution_context_id); // anomaly stamped via its session
});

// ── vscode-state scanner ─────────────────────────────────────────────────────

test('languageModelStats: the documented {"extensions":[…]} shape, not the wrong one', () => {
  const stats = parseLanguageModelStats(
    'languageModelStats.claude-3.5-sonnet',
    JSON.stringify({ extensions: [{ extensionId: 'GitHub.copilot-chat', requestCount: 6, tokenCount: 66383, participants: [] }] }),
  );
  assert.deepEqual(stats, [{ model: 'claude-3.5-sonnet', extensionId: 'GitHub.copilot-chat', requestCount: 6, tokenCount: 66383 }]);
  // The old {model:{tokenCount}} shape carries no per-extension split: yields nothing.
  assert.deepEqual(parseLanguageModelStats('languageModelStats.m', JSON.stringify({ 'gpt-5': { tokenCount: 5 } })), []);
  // Sync-blob wrapping {version, value}.
  const wrapped = parseLanguageModelStats('languageModelStats.m', { version: 1, value: JSON.stringify({ extensions: [{ extensionId: 'e' }] }) });
  assert.equal(wrapped[0]!.extensionId, 'e');

  const access = parseLanguageModelAccess('languageModelAccess.claude-3.5-sonnet', JSON.stringify(['GitHub.copilot-chat']));
  assert.deepEqual(access, { model: 'claude-3.5-sonnet', granted: ['GitHub.copilot-chat'] });
});

test('editor model selections from every key shape', () => {
  const sels = extractModelSelections([
    { key: 'chatModelRecentlyUsed', value: JSON.stringify(['claude-3-5-sonnet', 'openai/gpt-5']) },
    { key: 'chatModelPinned', value: JSON.stringify(['claude-3-5-sonnet']) },
    { key: 'chat.currentLanguageModel.panel', value: 'anthropic/claude-sonnet-5' },
    { key: 'chat.modelConfiguration.panel', value: JSON.stringify({ 'anthropic/claude-sonnet-5': { reasoningEffort: 'high', contextSize: '200k' } }) },
    { key: 'unrelated', value: 'x' },
  ]);
  const byModel = new Map(sels.map((s) => [s.model, s]));
  assert.equal(sels.length, 3);
  assert.equal(byModel.get('claude-3-5-sonnet')!.pinned, true);
  assert.equal(byModel.get('anthropic/claude-sonnet-5')!.reasoningEffort, 'high');
  assert.deepEqual(byModel.get('anthropic/claude-sonnet-5')!.selected_on, ['chat.currentLanguageModel.panel', 'chat.modelConfiguration.panel']);
});

test('classifyContributes: AI surface declared, no name list', () => {
  const caps = classifyContributes({
    contributes: { chatParticipants: [{ name: 'a' }, { name: 'b' }], languageModelTools: [{ name: 't' }] },
    capabilities: { untrustedWorkspaces: { supported: 'limited' } },
    extensionKind: ['ui', 'workspace'],
    enabledApiProposals: ['chatProviderAdditions'],
  });
  assert.deepEqual(caps.contributions, ['chatParticipants', 'languageModelTools']);
  assert.equal(caps.chatParticipants, 2);
  assert.equal(caps.untrustedWorkspaces, 'limited');
  assert.equal(caps.extensionKind, 'ui,workspace');
  const none = classifyContributes({});
  assert.deepEqual(none.contributions, []);
});

test('vscodeStateScanner end-to-end: usage rows, activation rows, model rows', () => {
  const codeRoot = join(home, 'Library', 'Application Support', 'Code');
  makeVscdb(join(codeRoot, 'User', 'globalStorage', 'state.vscdb'), [
    ['languageModelStats.claude-3.5-sonnet', JSON.stringify({ extensions: [{ extensionId: 'GitHub.copilot-chat', requestCount: 6, tokenCount: 66383 }] })],
    ['languageModelAccess.claude-3.5-sonnet', JSON.stringify(['GitHub.copilot-chat'])],
    ['chat.currentLanguageModel.panel', 'claude-3-5-sonnet'],
  ]);
  mkdir(codeRoot, 'User', 'sync', 'globalState');
  wf(join(codeRoot, 'User', 'sync', 'globalState', 'lastSyncglobalState.json'), JSON.stringify({
    storage: { chatModelRecentlyUsed: { version: 1, value: JSON.stringify(['openai/gpt-5']) } },
  }));
  makeVscdb(join(codeRoot, 'User', 'workspaceStorage', 'hash1', 'state.vscdb'), [
    ['github.copilot-chat/memento', '1'],
    ['workbench.activity.pinned', '1'],
  ]);
  // Extensions live in ~/.vscode, not App Support.
  wf(join(home, '.vscode', 'extensions', 'extensions.json'), JSON.stringify([
    { identifier: { id: 'Publisher.aiext' }, version: '1.0.0' },
  ]));
  wf(join(home, '.vscode', 'extensions', 'publisher.aiext-1.0.0', 'package.json'), JSON.stringify({
    name: 'aiext', publisher: 'Publisher', version: '1.0.0',
    contributes: { languageModelChatProviders: [{ name: 'x' }] },
  }));

  const activation = workspaceActivation(codeRoot);
  assert.equal(activation.length, 1);
  assert.equal(activation[0]!.uri, 'file:///repoA');
  assert.deepEqual(activation[0]!.extensions, ['github.copilot-chat']);

  assert.equal(installedExtensions(join(home, '.vscode', 'extensions')).length, 1);
  assert.equal(browserAssistants().length, 0); // no Chrome in the fixture home

  const result = vscodeStateScanner.run();
  assert.equal(result.ok, true);
  const db = openDb();
  const keys = (db.prepare("SELECT surface_key, extra FROM ai_surfaces WHERE scanner = 'vscode-state'").all() as { surface_key: string; extra: string }[]);
  const usage = keys.find((k) => k.surface_key === 'ide-ext-usage:code:GitHub.copilot-chat'); // extensionId verbatim
  assert.ok(usage, 'per-extension usage row exists');
  const parsed = JSON.parse(usage!.extra) as { models: { model: string; tokens: number }[]; access_granted: string[] };
  assert.equal(parsed.models[0]!.tokens, 66383);
  assert.deepEqual(parsed.access_granted, ['claude-3.5-sonnet']);
  assert.ok(keys.some((k) => k.surface_key === 'ws-activation:code:github.copilot-chat'));
  assert.ok(keys.some((k) => k.surface_key === 'editor-model:code:claude-3-5-sonnet'));
  assert.ok(keys.some((k) => k.surface_key === 'editor-model:code:openai/gpt-5'));
  const contrib = keys.find((k) => k.surface_key === 'ext-contrib:code:publisher.aiext');
  assert.ok(contrib, 'contribution-point row exists');
  assert.ok(JSON.parse(contrib!.extra).contributions.includes('languageModelChatProviders'));
});

// ── deleted sessions ─────────────────────────────────────────────────────────

test('kiroDeletedSessions: remove-ops whose session dir is gone', () => {
  mkdir(home, '.kiro', 'session-index');
  wf(join(home, '.kiro', 'session-index', 'abc.jsonl'), [
    JSON.stringify({ op: 'add', sessionPath: 'h1/sess_aaaa', at: 1 }),
    JSON.stringify({ op: 'remove', sessionPath: 'h1/sess_aaaa', at: 2 }),
    JSON.stringify({ op: 'remove', sessionPath: 'h1/sess_live', at: 3 }),
    'not json',
  ].join('\n'));
  mkdir(home, '.kiro', 'h1', 'sess_live');
  wf(join(home, '.kiro', 'h1', 'sess_live', 'keep.json'), '{}');
  const deleted = kiroDeletedSessions(join(home, '.kiro'));
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0]!.sessionId, 'sess_aaaa');
  assert.equal(deleted[0]!.removedAt, 2);
  assert.equal(deleted[0]!.stillOnDisk, false);
});

test('agentHostDeletedSessions: tombstones and the live external count', () => {
  const dbPath = join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'agent-host.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)');
  db.exec('CREATE TABLE sessions (session_uri TEXT, provider TEXT, external INTEGER)');
  db.prepare('INSERT INTO metadata VALUES (?, ?)').run('sessionTombstone:claude:/44444444-4444-4444-4444-444444444444', '1');
  db.prepare('INSERT INTO metadata VALUES (?, ?)').run('sessionRegistryBackfilled:claude', '1');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('claude:/x', 'claude', 1);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('claude:/y', 'claude', 1);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('local/z', 'xcode', 0);
  db.close();

  const { deleted, liveExternal } = agentHostDeletedSessions(dbPath);
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0]!.sessionId, '44444444-4444-4444-4444-444444444444');
  assert.equal(liveExternal, 2);
  const none = agentHostDeletedSessions(join(tmp, 'absent.db'));
  assert.equal(none.deleted.length, 0);

  const result = deletedSessionsScanner.run();
  assert.equal(result.ok, true);
  const rows = openDb().prepare("SELECT surface_key FROM ai_surfaces WHERE kind = 'deleted_session'").all() as { surface_key: string }[];
  assert.ok(rows.some((r) => r.surface_key === 'deleted-session:kiro:sess_aaaa'));
  assert.ok(rows.some((r) => r.surface_key === 'deleted-session:agent-host:44444444-4444-4444-4444-444444444444'));
});

// ── os intelligence ──────────────────────────────────────────────────────────

test('parseGenerativePartnerSettings and parseCloudSubscriptionOptIn', () => {
  const { partners, gatMigrationComplete2 } = parseGenerativePartnerSettings([
    '{',
    '    AllLLMUISettings =     {',
    '        "com.apple.openai.chatgpt" =         {',
    '            enablementCount = 0;',
    '            unavailable = 1;',
    '        };',
    '    };',
    '    gatMigrationComplete2 = 1;',
    '}',
  ].join('\n'));
  assert.deepEqual(partners, [{ partner: 'com.apple.openai.chatgpt', enablementCount: 0, unavailable: 1 }]);
  assert.equal(gatMigrationComplete2, 1);
  assert.deepEqual(parseGenerativePartnerSettings('{}'), { partners: [], gatMigrationComplete2: null });

  const opt = parseCloudSubscriptionOptIn('{ opted_out_buddy = 0; "opted_change_os_version" = "26.4.0"; }');
  assert.deepEqual(opt, { optedOutBuddy: 0, optedChangeOsVersion: '26.4.0' });
});

test('osIntelligenceScanner runs and writes os rows', () => {
  const result = osIntelligenceScanner.run();
  assert.equal(result.ok, true);
  assert.ok(typeof result.notes === 'string' && result.notes.includes('OS partner'));
});
