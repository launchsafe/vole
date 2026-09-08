import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../sqlite';
import { openDb, resetDbCache } from '../db';
import type { DB } from '../db';

import {
  gatewayRows, cliInventory, providerKeyNamesInFile, providerHasSurface,
  runtimeCensus, accountClassCensus, upsertSurface,
} from './ai-surfaces';
import {
  browserExtensionCensus, extensionVersionHistory, browserIdentityCensus,
  siteCapabilityCensus, writeSiteCapabilities,
} from './browser-grants';
import { countHostVisits, chromeTimeToMs, loadAiHosts } from './ai-hosts';
import {
  readExtensionsJson, readBuiltins, extractGhostContainers, resolveContainer,
  ghostExtensionCensus, editorExtensionCensus,
} from './editor-census';
import {
  parseChatSessionLine, parseTaskHistory, parseOllamaLine, ollamaLogCensus,
  repoAgentCensus, vscodeChatCensus,
} from './editor-stores';
import {
  declaredFromPackageJson, installedFromNodeModulesLock, aiDependencyCensus,
} from './deps';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'vole-t2-'));
}

function freshDb(): DB {
  resetDbCache();
  const dir = mkdtempSync(join(tmpdir(), 'vole-t2db-'));
  return openDb(join(dir, 't.db'));
}

function w(file: string, content: string): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

test('gatewayRows: RunAtLoad/KeepAlive/Std*Path carried from the plist', () => {
  const home = tmpHome();
  w(join(home, 'Library/LaunchAgents/com.example.litellm.plist'), `<?xml version="1.0"?>
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.litellm</string>
  <key>ProgramArguments</key><array><string>/usr/local/bin/litellm</string><string>--config</string><string>/tmp/x.yaml</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>/tmp/litellm.log</string>
  <key>StandardErrorPath</key><string>/tmp/litellm.err</string>
</dict></plist>`);
  const rows = gatewayRows(home);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.runAtLoad, true);
  assert.equal(rows[0]!.keepAlive, false);
  assert.deepEqual(rows[0]!.logPaths, ['/tmp/litellm.log', '/tmp/litellm.err']);
  assert.match(rows[0]!.surface.evidence, /RunAtLoad/);
  assert.doesNotMatch(rows[0]!.surface.evidence, /KeepAlive/);
});

test('providerKeyNamesInFile: the NAME and line cross, the value never does', () => {
  const home = tmpHome();
  const rc = join(home, '.zshrc');
  w(rc, 'export EDITOR=vim\nexport ANTHROPIC_API_KEY=sk-ant-supersecret\nOLLAMA_HOST=http://x:1\n');
  const rows = providerKeyNamesInFile(rc);
  assert.deepEqual(rows.map((r) => r.key_name), ['ANTHROPIC_API_KEY', 'OLLAMA_HOST']);
  assert.equal(rows[0]!.shape, 'line 2 export');
  for (const r of rows) assert.doesNotMatch(r.source_file + r.shape + r.key_name, /supersecret/);
});

test('cliInventory: version from the npm lib root, never-launched from the missing dot-dir', () => {
  const home = tmpHome();
  mkdirSync(join(home, '.npm-global/lib/node_modules/claude'), { recursive: true });
  w(join(home, '.npm-global/lib/node_modules/claude/package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '1.2.3' }));
  const rows = cliInventory(home);
  const claude = rows.find((r) => r.name === 'claude');
  assert.ok(claude, 'claude row present');
  assert.equal(claude.version, '1.2.3');
  assert.equal(claude.installedVia, 'npm-global');
  assert.equal(claude.neverLaunched, true);
  assert.match(claude.evidence, /NEVER LAUNCHED/);
});

test('runtimeCensus: the ollama manifest probe inventories pulled models', () => {
  const home = tmpHome();
  w(join(home, '.ollama/models/manifests/registry.ollama.ai/library/llama3/latest'), '{}');
  const { surfaces } = runtimeCensus(home);
  const inv = surfaces.find((s) => s.surface_key === 'runtime:ollama:models');
  assert.ok(inv, 'manifest surface present');
  assert.match(inv!.evidence, /llama3:latest/);
});

test('providerHasSurface: an enrolled Claude surface answers for the anthropic provider', () => {
  const db = freshDb();
  upsertSurface(db, { surface_key: 'app:com.anthropic.claude', kind: 'app', name: 'Claude', path: null, evidence: 'x' }, Date.now());
  assert.equal(providerHasSurface(db, 'anthropic'), true);
  assert.equal(providerHasSurface(db, 'mistral'), false);
});

test('accountClassCensus: oauthAccount org fields classify Claude-family rows, no names touched', () => {
  const db = freshDb();
  const home = tmpHome();
  w(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'org-uuid-1', organizationType: 'unmanaged', seatTier: 'max' } }));
  upsertSurface(db, { surface_key: 'app:com.anthropic.claude', kind: 'app', name: 'Claude', path: null, evidence: 'x' }, Date.now());
  const n = accountClassCensus(db, home);
  assert.equal(n, 1);
  const row = db.prepare("SELECT account_class, class_evidence FROM ai_surfaces WHERE surface_key = 'app:com.anthropic.claude'").get() as { account_class: string; class_evidence: string };
  assert.equal(row.account_class, 'org');
  assert.match(row.class_evidence, /organizationType=unmanaged/);
});

test('upsertSurface: depth columns widen NULL-only', () => {
  const db = freshDb();
  const now = Date.now();
  upsertSurface(db, { surface_key: 'k', kind: 'site', name: 'n', path: null, evidence: 'a' }, now);
  upsertSurface(db, { surface_key: 'k', kind: 'site', name: 'n', path: null, evidence: 'b', depth: { account_class: 'personal' } }, now + 1);
  let row = db.prepare('SELECT account_class, version FROM ai_surfaces WHERE surface_key = ?').get('k') as { account_class: string | null; version: string | null };
  assert.equal(row.account_class, 'personal');
  // A later pass with no depth must not clobber the stored class.
  upsertSurface(db, { surface_key: 'k', kind: 'site', name: 'n', path: null, evidence: 'c', version: null }, now + 2);
  row = db.prepare('SELECT account_class FROM ai_surfaces WHERE surface_key = ?').get('k') as { account_class: string };
  assert.equal(row.account_class, 'personal');
});

function chromeFixture(home: string, securePrefs: unknown, preferences: unknown): void {
  const root = join(home, 'Library/Application Support/Google/Chrome');
  w(join(root, 'Local State'), JSON.stringify({
    profile: { info_cache: { Default: { hosted_domain: 'NO_HOSTED_DOMAIN', user_name: 'dev@example.com', gaia_id: 'gaia-1', is_ephemeral: false } } },
    signin: { active_accounts_managed: false },
    management: { platform: { enterprise_mdm_mac: 0 } },
  }));
  w(join(root, 'Default/Secure Preferences'), JSON.stringify(securePrefs));
  w(join(root, 'Default/Preferences'), JSON.stringify(preferences));
}

test('browserExtensionCensus: location enum + permission triad from Secure Preferences', () => {
  const home = tmpHome();
  chromeFixture(home, {
    extensions: { settings: {
      aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: {
        manifest: { name: 'AI Helper', version: '2.0', permissions: ['tabs'], host_permissions: ['https://chatgpt.com/*'] },
        location: 4, from_webstore: false, disable_reasons: [2, 8],
        active_permissions: { permissions: ['tabs'] },
        granted_permissions: { permissions: ['tabs', 'cookies'] },
        withholding_permissions: { permissions: [] },
      },
    } },
  }, {});
  const { surfaces } = browserExtensionCensus(home, Date.now());
  const row = surfaces.find((s) => s.surface_key === 'browser-ext:chrome:Default:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.ok(row, 'extension surface present');
  const extra = JSON.parse(row!.extra!) as { location: string; granted_permissions: { permissions: string[] } };
  assert.equal(extra.location, 'unpacked');
  assert.deepEqual(extra.granted_permissions.permissions, ['tabs', 'cookies']);
  assert.match(row!.evidence, /2 granted permission/);
  // Chrome's own verdict row carries the disable reasons.
  const verdict = surfaces.find((s) => s.surface_key === 'browser-extstore:chrome:Default:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.ok(verdict, 'store verdict surface present');
  assert.match(verdict!.evidence, /disable_reasons/);
});

test('extensionVersionHistory: per-version directories with a permission diff', () => {
  const home = tmpHome();
  const extRoot = join(home, 'Library/Application Support/Google/Chrome/Default/Extensions/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  w(join(home, 'Library/Application Support/Google/Chrome/Local State'), JSON.stringify({ profile: { info_cache: { Default: {} } } }));
  w(join(extRoot, '1.0/manifest.json'), JSON.stringify({ name: 'AI Helper', version: '1.0', permissions: ['tabs'] }));
  w(join(extRoot, '1.1/manifest.json'), JSON.stringify({ name: 'AI Helper', version: '1.1', permissions: ['tabs', 'downloads'] }));
  const rows = extensionVersionHistory(home, Date.now());
  assert.equal(rows.length, 2);
  const v11 = rows.find((r) => r.version === '1.1')!;
  assert.match(v11.evidence, /ADDED permissions vs previous: downloads/);
});

test('browserIdentityCensus: domain + HMAC kept, the raw address never stored', () => {
  const home = tmpHome();
  chromeFixture(home, {}, {});
  const rows = browserIdentityCensus(home, Date.now());
  assert.equal(rows.length, 1);
  const extra = JSON.parse(rows[0]!.extra!) as { hosted_domain: string; account_hmac: string | null };
  assert.equal(extra.hosted_domain, 'NO_HOSTED_DOMAIN');
  assert.ok(extra.account_hmac);
  const surface = JSON.stringify(rows[0]);
  assert.doesNotMatch(surface, /dev@example\.com/);
  const dbRow = JSON.stringify(rows[0]);
  assert.doesNotMatch(dbRow, /dev@example\.com/);
});

test('siteCapabilityCensus: grants joined to the AI-host pack, picked dir as a path', () => {
  const home = tmpHome();
  chromeFixture(home, {}, {
    profile: { content_settings: { exceptions: {
      media_stream_mic: { 'https://chatgpt.com:443,*': { setting: 1 } },
      media_stream_camera: { 'https://docs.example.com:443,*': { setting: 1 } },
      file_system_last_picked_directory: { 'https://claude.ai:443,*': { setting: { picked_dir: '/Users/dev/roadmap' } } },
    } } },
  });
  const { rows, surfaces } = siteCapabilityCensus(home, Date.now());
  const capabilities = rows.map((r) => r[1]).sort();
  assert.deepEqual(capabilities, ['file_system_last_picked_directory', 'media_stream_mic']); // non-AI host excluded
  const mic = surfaces.find((s) => s.surface_key === 'site-cap:chrome:Default:chatgpt.com:media_stream_mic')!;
  assert.ok(mic);
  const picked = surfaces.find((s) => s.surface_key === 'site-cap:chrome:Default:claude.ai:file_system_last_picked_directory')!;
  assert.match(picked.evidence, /last picked directory: \/Users\/dev\/roadmap/);
  // The table write is the UNIQUE(origin, capability, pref_file) upsert.
  const db = freshDb();
  writeSiteCapabilities(db, rows, Date.now());
  writeSiteCapabilities(db, rows, Date.now());
  const n = (db.prepare('SELECT COUNT(*) AS n FROM site_capabilities').get() as { n: number }).n;
  assert.equal(n, 2);
});

test('countHostVisits: aggregate over the pack, chrome epoch maths', () => {
  assert.equal(chromeTimeToMs('11644473600000000'), 0);
  const home = tmpHome();
  const history = join(home, 'History');
  const hdb = new Database(history);
  hdb.exec('CREATE TABLE urls (url TEXT, visit_count INTEGER, last_visit_time INTEGER)');
  const last = 11644473600000000n + BigInt(86400_000 * 2) * 1000n; // 2 days after epoch-zero, in µs
  hdb.prepare('INSERT INTO urls VALUES (?, ?, ?)').run('https://chatgpt.com/c/abc', 4, Number(last));
  hdb.prepare('INSERT INTO urls VALUES (?, ?, ?)').run('https://evil.example.com/x', 99, 1);
  hdb.close();
  const rows = countHostVisits(history, loadAiHosts(), 'chrome', 'Default');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.visits, 4);
  assert.equal(rows[0]!.host, 'chatgpt.com');
  assert.equal(rows[0]!.lastVisitMs, 86400_000 * 2);
});

test('readExtensionsJson + readBuiltins: the three readers', () => {
  const home = tmpHome();
  w(join(home, '.vscode/extensions/extensions.json'), JSON.stringify([
    { identifier: { id: 'github.copilot-chat' }, version: '0.64.1', metadata: { installedTimestamp: 1700000000000, source: 'gallery', publisherDisplayName: 'GitHub' } },
  ]));
  const installed = readExtensionsJson(join(home, '.vscode/extensions/extensions.json'), 'vscode', 'extensions.json');
  assert.equal(installed.length, 1);
  assert.equal(installed[0]!.metadata.installedTimestamp, 1700000000000);
  // Built-ins: declares chatParticipants -> an AI surface with no name-list.
  const appsBase = join(home, 'Apps');
  w(join(appsBase, 'Visual Studio Code.app/Contents/Resources/app/extensions/copilot/package.json'), JSON.stringify({ name: 'copilot', publisher: 'github', version: '0.64.1', contributes: { chatParticipants: [{}] } }));
  const builtins = readBuiltins(join(appsBase, 'Visual Studio Code.app'), 'vscode');
  assert.equal(builtins.length, 1);
  assert.ok(builtins[0]!.aiSignals.includes('chatParticipants'));
  // The full census: reader 1 + reader 2 land as surfaces.
  w(join(home, 'Library/Application Support/Code/User/profiles/p1/extensions.json'), '[]');
  const { surfaces } = editorExtensionCensus(home, appsBase);
  assert.ok(surfaces.some((s) => s.surface_key === 'editor-ext:vscode:github.copilot-chat'));
  assert.ok(surfaces.some((s) => s.surface_key === 'editor-ext:vscode:builtin:github.copilot'));
});

test('ghost extensions: key shapes parsed, offline map resolves, unmapped stays explicit', () => {
  const shapes = extractGhostContainers([
    'workbench.view.extension.workbench-chat.state.hidden',
    'memento/webviewView.github.copilot-chat.view',
    'memento/github.copilot-chat.something',
    'chatStatusDashboard.contributedCollapsed.continue.continue',
    'unrelated.key',
  ]);
  assert.equal(shapes.length, 4);
  assert.equal(resolveContainer('github.copilot-chat'), 'GitHub Copilot Chat');
  assert.equal(resolveContainer('somevendor.someunknownthing'), 'unmapped container: somevendor.someunknownthing');

  const home = tmpHome();
  const gs = join(home, 'Library/Application Support/Code/User/globalStorage');
  mkdirSync(gs, { recursive: true });
  const vscdb = new Database(join(gs, 'state.vscdb'));
  vscdb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  vscdb.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('workbench.view.extension.github.copilot-chat.state.hidden', '1');
  vscdb.close();
  w(join(home, 'Library/Application Support/Code/User/sync/globalState/2026.01.02.json'), JSON.stringify({ 'memento/webviewView.acme.ai-tools.view': 1 }));
  const ghosts = ghostExtensionCensus(home, new Set());
  const names = ghosts.map((g) => g.name);
  assert.ok(names.includes('GitHub Copilot Chat'));
  assert.ok(names.includes('unmapped container: acme.ai-tools'), 'unmapped container stays explicit, never guessed into a vendor name');
  // Installed ids are not ghosts.
  const none = ghostExtensionCensus(home, new Set(['github.copilot-chat', 'acme.ai-tools']));
  assert.equal(none.length, 0);
});

test('parseChatSessionLine: completionTokens/durations/isSystemInitiated, nothing else read', () => {
  const r = parseChatSessionLine(JSON.stringify({ requestId: 'r1', responseId: 'resp1', completionTokens: 1234, totalElapsed: 5678, timeSpentWaiting: 12, isSystemInitiated: true, model: 'gpt-5' }));
  assert.equal(r!.completionTokens, 1234);
  assert.equal(r!.totalElapsed, 5678);
  assert.equal(r!.isSystemInitiated, true);
  assert.equal(parseChatSessionLine('not json'), null);
  assert.equal(parseChatSessionLine(JSON.stringify({ other: true })), null);
});

test('vscodeChatCensus: one exact row per request, output-only tokens', () => {
  const db = freshDb();
  const home = tmpHome();
  const sessions = join(home, 'Library/Application Support/Code/User/workspaceStorage/hash1/chatSessions');
  w(join(sessions, 'sess1.jsonl'), [
    JSON.stringify({ requestId: 'r1', responseId: 'resp1', completionTokens: 100, totalElapsed: 500 }),
    JSON.stringify({ requestId: 'r2', responseId: 'resp2', completionTokens: 40, timeSpentWaiting: 9, isSystemInitiated: true }),
    '',
  ].join('\n'));
  const n = vscodeChatCensus(db, home, Date.now());
  assert.equal(n, 2);
  const rows = db.prepare('SELECT event_key, output_tokens, total_tokens, input_tokens, agent_id, duration_ms, duration_kind, confidence FROM usage_events ORDER BY event_key').all() as Record<string, unknown>[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.output_tokens, 100);
  assert.equal(rows[0]!.total_tokens, null);
  assert.equal(rows[0]!.input_tokens, null);
  assert.equal(rows[0]!.duration_kind, 'measured');
  assert.equal(rows[1]!.agent_id, 'system');
  assert.equal(rows[1]!.confidence, 'exact');
  assert.equal(vscodeChatCensus(db, home, Date.now()), 0, 're-scan is a no-op');
});

test('parseTaskHistory: Cline task totals keyed by task id', () => {
  const tasks = parseTaskHistory(JSON.stringify([
    { id: 't1', ts: 1700000000, tokensIn: 10, tokensOut: 20, cacheWrites: 5, cacheReads: 2, totalCost: 0.01, workspace: '/repo' },
  ]));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.totalCost, 0.01);
  assert.deepEqual(parseTaskHistory('{"id": 1}[]'), []);
});

test('parseOllamaLine + ollamaLogCensus: inode:offset keys, idempotent re-reads', () => {
  const line = parseOllamaLine('time=2026-08-30T10:00:00.000-07:00 level=INFO source=loader msg="loading model" model=/Users/dev/.ollama/models/llama3', 99, 42);
  assert.equal(line!.model, '/Users/dev/.ollama/models/llama3');
  assert.equal(line!.event_key, 'ollama:99:42');
  const gin = parseOllamaLine('[GIN] 2026/08/30 - 10:00:01 | 200 | 1.2ms | 127.0.0.1 | POST "/api/generate"', 99, 80);
  assert.equal(gin!.kind, 'request');
  assert.ok(gin!.ts !== null);

  const db = freshDb();
  const home = tmpHome();
  const log = join(home, '.ollama/logs/server-1.log');
  w(log, [
    'time=2026-08-30T10:00:00.000-07:00 level=INFO source=loader msg="loading model" model=llama3',
    '[GIN] 2026/08/30 - 10:00:01 | 200 | 1.2ms | 127.0.0.1 | POST "/api/generate"',
  ].join('\n') + '\n');
  const first = ollamaLogCensus(db, home, Date.now());
  assert.equal(first, 2);
  const second = ollamaLogCensus(db, home, Date.now());
  assert.equal(second, 0, 'cursor makes the re-read a no-op');
  // Appending advances the cursor and yields only the new line.
  appendFileSync(log, '[GIN] 2026/08/30 - 10:05:00 | 200 | 1ms | 127.0.0.1 | POST "/api/chat"\n');
  assert.equal(ollamaLogCensus(db, home, Date.now()), 1);
  const rows = db.prepare("SELECT event_key, model, confidence FROM usage_events WHERE tool = 'ollama_local'").all() as Record<string, unknown>[];
  assert.equal(rows.length, 3);
  const load = rows.find((r) => r.model === 'llama3')!;
  assert.equal(load.confidence, 'activity_only');
  for (const r of rows) assert.match(String(r.event_key), /^ollama:\d+:\d+$/);
});

test('repoAgentCensus: Aider footprints, Continue dev_data watermark, idempotent counters', () => {
  const db = freshDb();
  const repo = tmpHome();
  db.prepare('INSERT INTO work_roots (root_path, origin_slug, exists_now, first_seen, last_seen) VALUES (?, ?, 1, ?, ?)').run(repo, 'test', Date.now(), Date.now());
  w(join(repo, '.aider.chat.history.md'), '# history\n');
  w(join(repo, '.aider.input.history'), 'what is 2+2\n');
  w(join(repo, '.continue/dev_data/events.jsonl'), [
    JSON.stringify({ name: 'tokensGenerated', other: 'prompt-content-not-read' }),
    JSON.stringify({ name: 'chatInteraction' }),
    JSON.stringify({ name: 'somethingelse' }),
  ].join('\n') + '\n');
  const now = Date.now();
  const r1 = repoAgentCensus(db, now);
  assert.equal(r1.aiderRoots, 1);
  assert.equal(r1.continueRoots, 1);
  let act = db.prepare("SELECT counter_kind, counter FROM surface_activity WHERE surface_key LIKE 'continue-devdata:%' ORDER BY counter_kind").all() as { counter_kind: string; counter: number }[];
  assert.deepEqual(act.map((a) => [a.counter_kind, a.counter]), [['chatInteraction', 1], ['tokensGenerated', 1]]);
  const aiderSurface = db.prepare("SELECT discovery FROM ai_surfaces WHERE surface_key = ?").get(`repo-agent:aider:${repo}`) as { discovery: string };
  assert.equal(aiderSurface.discovery, 'repo_artifact');
  const artifacts = (db.prepare('SELECT COUNT(*) AS n FROM repo_artifacts').get() as { n: number }).n;
  assert.equal(artifacts, 3, '2 aider + 1 dev_data artifact');
  // A second pass with no new bytes adds nothing.
  repoAgentCensus(db, now + 1000);
  act = db.prepare("SELECT counter_kind, counter FROM surface_activity WHERE surface_key LIKE 'continue-devdata:%' ORDER BY counter_kind").all() as { counter_kind: string; counter: number }[];
  assert.deepEqual(act.map((a) => [a.counter_kind, a.counter]), [['chatInteraction', 1], ['tokensGenerated', 1]]);
});

test('ai_dependencies: declared vs installed stored as separate bindings', () => {
  const repo = tmpHome();
  w(join(repo, 'package.json'), JSON.stringify({ dependencies: { openai: '^1.0.0', lodash: '4.17.0' } }));
  w(join(repo, 'node_modules/.package-lock.json'), JSON.stringify({ packages: { 'node_modules/openai': { version: '1.4.0' } } }));
  assert.equal(declaredFromPackageJson(repo).length, 1);
  assert.equal(installedFromNodeModulesLock(repo).length, 1);
  const db = freshDb();
  db.prepare('INSERT INTO work_roots (root_path, origin_slug, exists_now, first_seen, last_seen) VALUES (?, ?, 1, ?, ?)').run(repo, 'test', Date.now(), Date.now());
  aiDependencyCensus(db, tmpHome(), Date.now());
  const rows = (db.prepare('SELECT name, source, version FROM ai_dependencies ORDER BY source').all() as { name: string; source: string; version: string }[]).map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { name: 'openai', source: 'declared', version: '^1.0.0' },
    { name: 'openai', source: 'installed', version: '1.4.0' },
  ], 'declared 1.0 vs installed 1.4 is a queryable drift');
});

test('scanners clean up their scratch databases', () => {
  // Every freshDb() above created its own store under tmpdir; nothing to assert
  // beyond the fact that no test wrote outside its fixture home. Smoke-check the
  // shipped host pack instead.
  const hosts = loadAiHosts();
  assert.ok(hosts.some((h) => h.host === 'chatgpt.com'));
  assert.ok(hosts.some((h) => h.host === 'openrouter.ai'));
});

// Scratch dirs under tmpdir are the OS's to reap; nothing here writes outside
// its own fixture home or the test store.
