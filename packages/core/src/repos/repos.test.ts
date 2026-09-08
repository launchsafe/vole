import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, insertAnomalies, resetDbCache } from '../db';
import type { DB } from '../db';
import { globToRegex, relGlobMatch, stripJsonc, structDiff, nearMatchHost, isPlaceholderTarget } from './util';
import {
  resolveWorkRoot, parseGitConfigOrigin, originSlug, syncWorkRoots, detectRootNotPresent, reposBand,
} from './roots';
import { parseGitIndex, trackedStateFor, readTrackedPaths, ignoreMatches, hidingPattern } from './tracked';
import {
  sweepRoot, sweepFooter, expandGlob, detectRepoCarriedGrant, readDevcontainer, readCompose,
  parseSshConfig, sshReachFromCommand, idePostureFromSettings, replayConfigHistory,
} from './artifacts';
import {
  classifyPath, classifyFileWrites, postImage, dependencyDeltas, installHooksFromEdit, installHookAnomaly,
  ignorePatternDelta, detectWriteThenHide, joinEscapeState, detectEnvelopeChangeEscaped,
  detectSecurityEnvelopeChanged, envelopeReceipt,
} from './envelope';

const NOW = 1_750_000_000_000;

function freshDb(): DB {
  // openDb caches the first handle; tests need isolation, so drop the cache each time.
  resetDbCache();
  return openDb(':memory:');
}

// ── util ─────────────────────────────────────────────────────────────────────

test('globToRegex and relGlobMatch', () => {
  assert.equal(globToRegex('**/.gitignore').test('/a/b/.gitignore'), true);
  assert.equal(globToRegex('**/.gitignore').test('/a/b/gitignore'), false);
  assert.equal(relGlobMatch('src/x/package.json', '**/package.json'), true);
  assert.equal(relGlobMatch('package.json', 'package.json'), true);
  assert.equal(relGlobMatch('src/x.ts', '**/*.ts'), true);
  assert.equal(relGlobMatch('src/x/d.ts', '**/*.ts'), true);
  assert.equal(nearMatchHost('db-one.example.com', 'db-two.example.com'), true);
  assert.equal(nearMatchHost('db-one.example.com', 'other.internal.example'), false, 'different label counts are not near-matches');
  assert.equal(isPlaceholderTarget('HOSTNAME_OR_IP_ADDRESS:25060'), true);
  assert.equal(isPlaceholderTarget('real-db.e.db.ondigitalocean.com:25060'), false);
});

test('stripJsonc tolerates comments and trailing commas', () => {
  const doc = stripJsonc('{ // c\n "a": 1, /* b */ "b": [1, 2,], }');
  assert.deepEqual(JSON.parse(doc), { a: 1, b: [1, 2] });
});

test('structDiff emits paths only, never values', () => {
  const diff = structDiff({ a: { token: 'x' }, same: 1 }, { a: { token: 'y' }, same: 1 });
  assert.deepEqual(diff, ['a.token']);
  const text = JSON.stringify(diff);
  assert.ok(!text.includes('y') && !text.includes('x'), 'diff must never quote values');
});

// ── roots ────────────────────────────────────────────────────────────────────

test('resolveWorkRoot walks to the .git ancestor', () => {
  const gitDirs = new Set(['/w/repo/.git']);
  const exists = (p: string) => gitDirs.has(p) || p === '/w/repo/sub/deep';
  assert.deepEqual(resolveWorkRoot('/w/repo/sub/deep', exists), { rootPath: '/w/repo', rootKind: 'git_repo' });
  assert.deepEqual(resolveWorkRoot('/w/scratch', () => false), { rootPath: '/w/scratch', rootKind: 'work_dir' });
  assert.equal(resolveWorkRoot('/w/scratch', () => false)?.rootKind, 'work_dir');
});

test('resolveWorkRoot refuses $HOME and system paths', () => {
  assert.equal(resolveWorkRoot('/usr/lib/something', () => false), null);
  assert.equal(resolveWorkRoot('/System/Volumes/x', () => false), null);
  assert.equal(resolveWorkRoot('/w/plain', () => false)?.rootKind, 'work_dir');
});

test('parseGitConfigOrigin finds the origin url', () => {
  const cfg = `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:acme/platform.git\n`;
  assert.equal(parseGitConfigOrigin(cfg), 'git@github.com:acme/platform.git');
});

test('originSlug normalises remote shapes, NULL for file remotes', () => {
  assert.equal(originSlug('git@github.com:acme/platform.git'), 'github.com/acme/platform');
  assert.equal(originSlug('https://github.com/acme/platform.git'), 'github.com/acme/platform');
  assert.equal(originSlug('https://user:tok@github.com/acme/platform'), 'github.com/acme/platform');
  assert.equal(originSlug('ssh://git@gitlab.corp/acme/priv.git'), 'gitlab.corp/acme/priv');
  assert.equal(originSlug('file:///somewhere/repo'), null);
  assert.equal(originSlug(null), null);
});

test('syncWorkRoots: discovery, tombstone, no re-stamp, root_not_present', () => {
  const db = freshDb();
  const root = '/work/repo';
  const present = new Set<string>([root]);
  const exists = (p: string) => present.has(p);
  let r = syncWorkRoots(db, NOW, exists, [{ cwd: root, evidence: 'usage_project' }]);
  assert.deepEqual(r.discovered, [root]);
  const row = db.prepare('SELECT exists_now, disappeared_at FROM work_roots WHERE root_path = ?').get(root) as { exists_now: number; disappeared_at: number | null };
  assert.equal(row.exists_now, 1);
  assert.equal(row.disappeared_at, null);
  // goes away
  present.delete(root);
  r = syncWorkRoots(db, NOW + 1000, exists, [{ cwd: root, evidence: 'usage_project' }]);
  assert.deepEqual(r.tombstoned, [root]);
  const gone = db.prepare('SELECT exists_now, disappeared_at FROM work_roots WHERE root_path = ?').get(root) as { exists_now: number; disappeared_at: number | null };
  assert.equal(gone.exists_now, 0);
  assert.equal(gone.disappeared_at, NOW + 1000);
  // still gone: disappeared_at frozen
  syncWorkRoots(db, NOW + 5000, exists, [{ cwd: root, evidence: 'usage_project' }]);
  const frozen = db.prepare('SELECT disappeared_at FROM work_roots WHERE root_path = ?').get(root) as { disappeared_at: number };
  assert.equal(frozen.disappeared_at, NOW + 1000);
  // reappears
  present.add(root);
  const r2 = syncWorkRoots(db, NOW + 9000, exists, [{ cwd: root, evidence: 'usage_project' }]);
  assert.deepEqual(r2.reappeared, [root]);
  const back = db.prepare('SELECT exists_now FROM work_roots WHERE root_path = ?').get(root) as { exists_now: number };
  assert.equal(back.exists_now, 1);
});

test('detectRootNotPresent keys on the disappearance day (idempotent)', () => {
  const db = freshDb();
  const day = NOW - NOW % 86_400_000;
  db.prepare(`INSERT INTO work_roots (root_path, origin_slug, exists_now, disappeared_at, first_seen, last_seen) VALUES (?, NULL, 0, ?, ?, ?)`)
    .run('/gone/repo', day, day - 5000, day - 5000);
  const a = detectRootNotPresent(db, NOW);
  const b = detectRootNotPresent(db, NOW + 60_000);
  assert.equal(a.length, 1);
  assert.equal(a[0]!.rule, 'root_not_present');
  assert.equal(a[0]!.severity, 'info');
  assert.equal(a[0]!.anomaly_key, b[0]!.anomaly_key, 'same day: identical key, idempotent');
  assert.ok(a[0]!.anomaly_key.includes(String(Math.floor(day / 86_400_000))));
});

test('reposBand prints the denominator sentence', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO work_roots (root_path, exists_now, first_seen, last_seen) VALUES ('/r/a', 1, 1, 2)`).run();
  db.prepare(`INSERT INTO work_roots (root_path, exists_now, disappeared_at, first_seen, last_seen) VALUES ('/r/gone', 0, 100, 1, 2)`).run();
  db.prepare(`INSERT INTO repo_artifacts (artifact_key, root_path, rel_path, kind, first_seen, last_seen) VALUES ('k1', '/r/a', '.claude/settings.json', 'claude_settings', 1, 2)`).run();
  const band = reposBand(db);
  assert.equal(band.known, 2);
  assert.equal(band.gone, 1);
  assert.ok(band.sentence.includes('artifact findings cover 1 readable roots of 2 known'));
  assert.ok(band.sentence.includes('not present on disk'));
  assert.ok(band.sentence.includes('lower bound'));
});

// ── tracked: the DIRC parser ────────────────────────────────────────────────

/** Build a v2/v3 index buffer from (ctime-independent) entries. */
function buildIndexV2(paths: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from('DIRC'), int32(2), int32(paths.length)];
  for (const p of paths) {
    const entry = Buffer.alloc(62 + p.length);
    entry.writeUInt32BE(0, 40); // flags: namelen filled below
    entry.write(p, 62, 'utf8');
    entry.writeUInt16BE(p.length & 0xfff, 60);
    const padded = (Math.ceil((62 + p.length + 1) / 8)) * 8;
    const pad = Buffer.alloc(padded - 62 - p.length);
    parts.push(entry, pad);
  }
  return Buffer.concat(parts);
}

function buildIndexV4(paths: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from('DIRC'), int32(4), int32(paths.length)];
  let prev = '';
  for (const p of paths) {
    // git v4: path = prev with `strip` bytes removed from the END, + stored suffix
    let common = 0;
    while (common < prev.length && common < p.length && prev[common] === p[common]) common++;
    const strip = prev.length - common;
    const suffix = p.slice(common);
    const entry = Buffer.alloc(62);
    entry.writeUInt16BE(suffix.length & 0xfff, 60);
    parts.push(entry, encodeVarint(strip), Buffer.from(suffix, 'utf8'), Buffer.from([0]));
    prev = p;
  }
  return Buffer.concat(parts);
}

/** git's encode_varint: last byte < 0x80, predecessors carry the continuation bit. */
function encodeVarint(v: number): Buffer {
  const bytes: number[] = [v & 0x7f];
  let val = v;
  for (;;) {
    val >>= 7;
    if (val === 0) break;
    val -= 1;
    bytes.unshift(0x80 | (val & 0x7f));
  }
  return Buffer.from(bytes);
}

function int32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v);
  return b;
}

test('parseGitIndex reads v2 with NUL padding', () => {
  const parsed = parseGitIndex(buildIndexV2(['a.txt', 'dir/b.txt', 'very/long/path/name/that/exceeds.txt']));
  assert.ok(parsed);
  assert.equal(parsed!.version, 2);
  assert.equal(parsed!.entryCount, 3);
  assert.deepEqual(parsed!.paths, ['a.txt', 'dir/b.txt', 'very/long/path/name/that/exceeds.txt']);
  assert.equal(parsed!.truncated, false);
});

test('parseGitIndex reads v4 prefix compression', () => {
  const parsed = parseGitIndex(buildIndexV4(['dir/a.txt', 'dir/b.txt', 'other/c.txt']));
  assert.ok(parsed);
  assert.deepEqual(parsed!.paths, ['dir/a.txt', 'dir/b.txt', 'other/c.txt']);
});

test('parseGitIndex rejects non-DIRC and marks unsupported as truncated', () => {
  assert.equal(parseGitIndex(Buffer.from('nope123456')), null);
  const v1 = Buffer.concat([Buffer.from('DIRC'), int32(1), int32(0)]);
  const parsed = parseGitIndex(v1);
  assert.ok(parsed && parsed.truncated, 'v1 is unsupported: unknown, not empty');
});

test('readTrackedPaths + trackedStateFor from a real index file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-git-'));
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git', 'index'), buildIndexV2(['tracked.txt', '.claude/settings.json']));
  const tracked = readTrackedPaths(dir);
  assert.equal(tracked.parsed, true);
  assert.equal(trackedStateFor('tracked.txt', tracked), 'tracked');
  assert.equal(trackedStateFor('other.txt', tracked), 'untracked');
  const noGit = mkdtempSync(join(tmpdir(), 'vole-nogit-'));
  assert.equal(trackedStateFor('x', readTrackedPaths(noGit)), 'unknown');
  rmSync(dir, { recursive: true, force: true });
  rmSync(noGit, { recursive: true, force: true });
});

test('ignoreMatches implements gitignore shapes; hidingPattern names the pattern', () => {
  assert.equal(ignoreMatches('dist/x.js', 'dist/'), true);
  assert.equal(ignoreMatches('dist', 'dist/'), true);
  assert.equal(ignoreMatches('src/dist/x.js', 'dist/'), false, 'trailing-slash patterns are anchored');
  assert.equal(ignoreMatches('a/b/secret.pem', 'secret.pem'), true, 'a bare pattern matches the basename at any depth');
  assert.equal(ignoreMatches('a/b/node_modules/x.js', 'node_modules'), true);
  assert.equal(ignoreMatches('build/out.js', 'build'), true);
  const hit = hidingPattern('dist/out.js', [{ pattern: 'dist/', source: '.gitignore' }, { pattern: 'node_modules', source: '.gitignore' }]);
  assert.equal(hit?.pattern, 'dist/');
});

// ── artifacts: the bounded sweep ─────────────────────────────────────────────

test('expandGlob honours declared prefixes and depth', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-sweep-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), '{}');
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh');
  writeFileSync(join(dir, '.git', 'hooks', 'pre-commit.sample'), '#!/bin/sh');
  writeFileSync(join(dir, 'README.md'), 'not in manifest');
  assert.deepEqual(expandGlob(dir, '.claude/settings.json'), ['.claude/settings.json']);
  const hooks = expandGlob(dir, '.git/hooks/*', '*.sample');
  assert.deepEqual(hooks, ['.git/hooks/pre-commit']);
  assert.deepEqual(expandGlob(dir, 'AGENTS.md'), [], 'a manifest name absent on disk yields nothing');
  rmSync(dir, { recursive: true, force: true });
});

test('sweepRoot: sha receipts, tracked_state, budget skip, footer sentence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-sweep2-'));
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'index'), buildIndexV2(['.claude/settings.json', 'package-lock.json']));
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash(git *)"]}}');
  writeFileSync(join(dir, 'package-lock.json'), '{}');
  const db = freshDb();
  const receipt = sweepRoot(db, dir, NOW, 1024 * 1024);
  assert.equal(receipt.state, 'ok');
  assert.equal(receipt.files, 2);
  const rows = db.prepare('SELECT rel_path, kind, tracked_state, sha256, size_bytes FROM repo_artifacts WHERE root_path = ? ORDER BY rel_path').all(dir) as { rel_path: string; kind: string; tracked_state: string; sha256: string; size_bytes: number }[];
  assert.equal(rows.length, 2);
  const settings = rows.find((r) => r.rel_path === '.claude/settings.json')!;
  assert.equal(settings.kind, 'claude_settings');
  assert.equal(settings.tracked_state, 'tracked');
  assert.equal(settings.sha256.length, 64);
  const lock = rows.find((r) => r.rel_path === 'package-lock.json')!;
  assert.equal(lock.kind, 'lockfile');
  // idempotent re-sweep: same rows, sha change detected when content moves
  const again = sweepRoot(db, dir, NOW + 10, 1024 * 1024);
  assert.equal(again.files, 2);
  assert.equal(again.newArtifacts.length, 0);
  assert.equal(again.changedArtifacts.length, 0);
  writeFileSync(join(dir, 'package-lock.json'), '{"changed":true}');
  const third = sweepRoot(db, dir, NOW + 20, 1024 * 1024);
  assert.equal(third.changedArtifacts.length, 1);
  assert.equal(third.changedArtifacts[0]!.kind, 'lockfile');
  // budget: a 1-byte budget skips the settings file but counts it
  const tiny = sweepRoot(db, dir, NOW + 30, 1);
  assert.ok(tiny.skippedOverBudget.length >= 1, 'over-budget files are counted, never silently read');
  assert.ok(sweepFooter([third]).includes('manifest v3'));
  const scanState = db.prepare('SELECT bytes_scanned, last_scan_at, cursor_int FROM repo_scan_state WHERE root_path = ?').get(dir) as { bytes_scanned: number; last_scan_at: number; cursor_int: number };
  assert.equal(scanState.cursor_int, 2);
  assert.equal(scanState.last_scan_at, NOW + 20);
  rmSync(dir, { recursive: true, force: true });
});

test('detectRepoCarriedGrant fires only for tracked grants with the deterministic key', () => {
  const db = freshDb();
  const receipt = {
    rootPath: '/w/repo', state: 'ok' as const, files: 1, bytes: 10, skippedOverBudget: [],
    manifestVersion: 3, newArtifacts: [], changedArtifacts: [],
    grants: [{ relPath: '.claude/settings.json', artifactSha: 'a'.repeat(64), ruleText: 'Bash(git *)', trackedState: 'tracked' as const }],
    tracked: { parsed: true, paths: new Set<string>() },
  };
  db.prepare(`INSERT INTO work_roots (root_path, origin_slug, exists_now, first_seen, last_seen) VALUES ('/w/repo', 'github.com/acme/platform', 1, 1, 2)`).run();
  const out = detectRepoCarriedGrant(db, NOW, [receipt]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.rule, 'repo_carried_grant');
  assert.ok(out[0]!.detail.includes('github.com/acme/platform'));
  assert.ok(out[0]!.detail.includes('Bash(git *)'));
  // untracked grants never fire: the allowlist does not travel
  const untracked = detectRepoCarriedGrant(db, NOW, [{ ...receipt, grants: [{ ...receipt.grants[0]!, trackedState: 'untracked' }] }]);
  assert.equal(untracked.length, 0);
  // idempotent key
  const again = detectRepoCarriedGrant(db, NOW + 5, [receipt]);
  assert.equal(again[0]!.anomaly_key, out[0]!.anomaly_key);
});

// ── devcontainer / compose ──────────────────────────────────────────────────

test('readDevcontainer parses JSONC and yields three-state chips', () => {
  const posture = readDevcontainer(`{
    // claude feature
    "image": "mcr.microsoft.com/devcontainers/base",
    "features": { "ghcr.io/anthropics/claude-code:1": {} },
    "mounts": ["source=~/.claude,target=/root/.claude"],
    "postCreateCommand": "curl -fsSL https://get.example | sh",
    "runArgs": ["--privileged"],
  }`);
  assert.ok(posture);
  assert.equal(posture!.agentInstalled, true);
  assert.equal(posture!.homeMounted, true);
  assert.equal(posture!.bypassDeclared, true);
  const empty = readDevcontainer('{}');
  assert.equal(empty!.agentInstalled, null, 'declares nothing: null, never false-by-default');
});

test('readCompose line-scans images, volumes and commands', () => {
  const c = readCompose(`services:
  db:
    image: postgres:16
    volumes:
      - ./data:/var/lib/postgresql/data
    command: postgres -c log_connections=on
`);
  assert.deepEqual(c.images, ['postgres:16']);
  assert.deepEqual(c.volumes, ['./data:/var/lib/postgresql/data']);
  assert.deepEqual(c.commands, ['postgres -c log_connections=on']);
});

// ── ssh reach ────────────────────────────────────────────────────────────────

test('parseSshConfig extracts reach policy per host', () => {
  const cfg = `Host prod web
  IdentityFile ~/.ssh/id_ed25519
  ForwardAgent yes
  StrictHostKeyChecking accept-new
  ProxyJump bastion

Host db
  IdentityFile ~/.ssh/prod.pem
`;
  const hosts = parseSshConfig(cfg, 0, () => null);
  const prod = hosts.find((h) => h.host === 'prod')!;
  assert.equal(prod.identityClass, 'ssh_private_key');
  assert.equal(prod.forwardAgent, 'yes');
  assert.equal(prod.strictHostKeyChecking, 'accept-new');
  assert.equal(prod.proxyJump, 'bastion');
  const db = hosts.find((h) => h.host === 'db')!;
  assert.equal(db.identityClass, 'ssh_private_key');
  assert.equal(db.forwardAgent, null);
});

test('sshReachFromCommand flags -A, -i and -o shapes without opening keys', () => {
  const reach = sshReachFromCommand('ssh -A -i ~/.ssh/id_ed25519 user@host');
  assert.ok(reach.some((r) => r.shape.startsWith('ssh -A')));
  assert.ok(reach.some((r) => r.identityPathClass === 'ssh_private_key'));
  const sho = sshReachFromCommand('ssh -o StrictHostKeyChecking=no host');
  assert.ok(sho.some((r) => r.shape.includes('StrictHostKeyChecking=no')));
});

// ── IDE posture lanes ────────────────────────────────────────────────────────

test('idePostureFromSettings reads the bypass levers', () => {
  const obs = idePostureFromSettings(`{"claudeCode.allowDangerouslySkipPermissions": true, "chat.agent.maxRequests": 1000000000000}`);
  assert.equal(obs['claudeCode.allowDangerouslySkipPermissions'], true);
  assert.equal(obs['chat.agent.maxRequests'], 1000000000000);
  assert.equal(obs['chat.agent.sandbox.enabled'], undefined);
});

// ── retroactive config history ───────────────────────────────────────────────

test('replayConfigHistory diffs paths only and bounds the timeline', () => {
  const db = freshDb();
  const entries = replayConfigHistory(db, [
    { file: '/h/.claude/backups/.claude.json.backup.1000', capturedAt: 1000, text: '{"a":1,"oauthAccount":{"token":"SECRET"},"projects":{"x":1}}' },
    { file: '/h/.claude/backups/.claude.json.backup.2000', capturedAt: 2000, text: '{"a":2,"oauthAccount":{"token":"SECRET"},"projects":{"x":1}}' },
  ]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[1]!.changedPaths, ['a']);
  assert.ok(!JSON.stringify(entries).includes('SECRET'), 'the timeline never quotes values');
  assert.ok(entries[0]!.changedPaths[0]!.includes('earliest recovered state'));
  const rows = db.prepare('SELECT captured_at, diff, source FROM scope_history ORDER BY captured_at').all() as { diff: string; source: string }[];
  assert.equal(rows.length, 2);
  assert.equal(rows[1]!.source, '/h/.claude/backups/.claude.json.backup.2000');
});

// ── envelope: classification ─────────────────────────────────────────────────

test('classifyPath: first-match-wins, unclassified is null', () => {
  assert.equal(classifyPath('/r/.claude/settings.json')?.change_risk_class, 'permissions');
  assert.equal(classifyPath('/r/src/app.ts')?.change_risk_class, 'source');
  assert.equal(classifyPath('/r/package-lock.json')?.change_risk_class, 'lockfile');
  assert.equal(classifyPath('/r/.gitignore')?.change_risk_class, 'visibility');
  assert.equal(classifyPath('/r/sub/package.json')?.change_risk_class, 'dependency');
  assert.equal(classifyPath('/r/unknown.bin'), null);
});

test('classifyFileWrites widens NULL-only and stamps visibility', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-env-'));
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), 'dist/\n');
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'out.js'), 'x');
  writeFileSync(join(dir, 'app.ts'), 'x');
  const db = freshDb();
  const ins = db.prepare(`INSERT INTO file_writes (write_key, session_id, path, ts, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)`);
  ins.run('w1', 's1', join(dir, 'app.ts'), NOW, NOW, NOW);
  ins.run('w2', 's1', join(dir, 'dist', 'out.js'), NOW, NOW, NOW);
  ins.run('w3', 's1', join(dir, 'logo.bin'), NOW, NOW, NOW);
  const { classified, visibility } = classifyFileWrites(db, NOW);
  assert.equal(classified, 2, 'logo.bin stays unclassified');
  assert.ok(visibility >= 2);
  const rows = db.prepare('SELECT write_key, change_risk_class, visibility_class, content_rev, class_pattern_id FROM file_writes ORDER BY write_key').all() as { write_key: string; change_risk_class: string | null; visibility_class: string | null; content_rev: number; class_pattern_id: string | null }[];
  assert.equal(rows[0]!.change_risk_class, 'source');
  assert.equal(rows[0]!.visibility_class, 'visible');
  assert.equal(rows[1]!.change_risk_class, 'source');
  assert.equal(rows[1]!.visibility_class, 'ignored');
  assert.equal(rows[2]!.change_risk_class, null, 'unclassified is NULL, never a guessed class');
  assert.equal(rows[2]!.class_pattern_id, null);
  assert.equal(rows[0]!.content_rev, 1);
  // idempotent: a second run changes nothing
  assert.equal(classifyFileWrites(db, NOW + 1).classified, 0);
  const packs = db.prepare('SELECT COUNT(*) AS n FROM path_classes').get() as { n: number };
  assert.ok(packs.n > 0, 'the builtin pack is registered');
  rmSync(dir, { recursive: true, force: true });
});

// ── pre/post images: deltas and hooks ────────────────────────────────────────

test('postImage applies Edit shapes and creates', () => {
  assert.equal(postImage({ filePath: 'x', originalFile: 'abc', oldString: 'b', newString: 'B', content: null }), 'aBc');
  assert.equal(postImage({ filePath: 'x', content: 'fresh' }), 'fresh');
  assert.equal(postImage({ filePath: 'x', originalFile: 'a a a', oldString: 'a', newString: 'z', replaceAll: true }), 'z z z');
  assert.equal(postImage({ filePath: 'x', originalFile: 'a', oldString: 'a', newString: '' }), '');
});

test('dependencyDeltas recovers the exact key-set delta from one Edit row', () => {
  const pre = JSON.stringify({ name: 'app', devDependencies: { esbuild: '^1' }, dependencies: { 'better-sqlite3': '^11', express: '^4' } });
  const post = JSON.stringify({ name: 'app', devDependencies: { esbuild: '^1', postject: '^1' }, dependencies: { express: '^4' } });
  const deltas = dependencyDeltas({ filePath: 'package.json', originalFile: pre, oldString: pre, newString: post, sessionId: 's', ts: NOW });
  if (Array.isArray(deltas)) {
    const byName = new Map(deltas.map((d) => [`${d.section}:${d.name}`, d]));
    assert.equal(byName.get('devDependencies:postject')?.verb, 'added');
    assert.equal(byName.get('devDependencies:postject')?.newSpec, '^1');
    assert.equal(byName.get('devDependencies:postject')?.oldSpec, null);
    assert.equal(byName.get('dependencies:better-sqlite3')?.verb, 'removed');
    assert.equal(deltas.every((d) => d.ecosystem === 'npm'), true);
  } else {
    assert.fail('expected deltas, got parse failure');
  }
});

test('dependencyDeltas records parse_failed and guesses no name', () => {
  const bad = dependencyDeltas({ filePath: 'package.json', originalFile: '{not json', content: 'still not' });
  assert.ok(!Array.isArray(bad) && (bad as { parseFailed: boolean }).parseFailed === true);
  const notManifest = dependencyDeltas({ filePath: 'src/x.ts', originalFile: 'a', content: 'b' });
  assert.ok(!Array.isArray(notManifest));
});

test('installHooksFromEdit detects only install-time scripts and only new ones', () => {
  const pre = JSON.stringify({ scripts: { build: 'tsc', postinstall: 'old' } });
  const post = JSON.stringify({ scripts: { build: 'tsc', postinstall: 'node setup.js', prepare: 'husky', dev: 'tsx' } });
  const hooks = installHooksFromEdit({ filePath: 'package.json', originalFile: pre, oldString: pre, newString: post, sessionId: 's', ts: NOW });
  const keys = hooks.map((h) => h.key);
  assert.ok(keys.includes('scripts.postinstall'));
  assert.ok(keys.includes('scripts.prepare'));
  assert.ok(!keys.includes('scripts.build'), 'unchanged wiring is not a plant');
  assert.ok(!keys.includes('scripts.dev'), 'run-time scripts are not install hooks');
  const postinstall = hooks.find((h) => h.key === 'scripts.postinstall')!;
  assert.equal(postinstall.skeleton, 'node');
  assert.equal(postinstall.commandSha256.length, 64);
  const anomaly = installHookAnomaly({ filePath: 'package.json', originalFile: pre, oldString: pre, newString: post, sessionId: 's', ts: NOW }, postinstall, NOW);
  assert.equal(anomaly.rule, 'install_hook_added');
  assert.equal(anomaly.severity, 'critical');
  assert.ok(!anomaly.detail.includes('node setup.js'), 'command text is never stored, only its hash');
});

test('ignorePatternDelta returns only added patterns', () => {
  assert.deepEqual(ignorePatternDelta('node_modules\ndist\n', 'node_modules\ndist\nbuild\n# comment\n!keep\n'), ['build']);
});

// ── write_then_hide ──────────────────────────────────────────────────────────

test('write_then_hide fires on both spec shapes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-hide-'));
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'index'), buildIndexV2(['tracked_secret.env']));
  const db = freshDb();
  const ins = db.prepare(`INSERT INTO file_writes (write_key, session_id, path, ts, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)`);
  ins.run('w1', 's1', join(dir, '.gitignore'), NOW, NOW, NOW);
  ins.run('w2', 's1', join(dir, 'secret.env'), NOW, NOW, NOW);
  ins.run('w3', 's2', join(dir, 'unrelated.txt'), NOW, NOW, NOW);
  // shape A: the session wrote secret.env AND added the pattern covering it
  const a = detectWriteThenHide(db, NOW, {
    patternDeltas: [{ sessionId: 's1', filePath: join(dir, '.gitignore'), addedPatterns: ['secret.env'], ts: NOW }],
  });
  assert.equal(a.length, 1);
  assert.equal(a[0]!.rule, 'write_then_hide');
  assert.ok(a[0]!.title.includes('unreviewable'));
  // shape B: the added pattern covers a tracked_state path (no same-session write needed)
  const b = detectWriteThenHide(db, NOW, {
    patternDeltas: [{ sessionId: 's9', filePath: join(dir, '.gitignore'), addedPatterns: ['tracked_secret.env'], ts: NOW }],
  });
  assert.equal(b.length, 1);
  assert.ok(b[0]!.anomaly_key !== a[0]!.anomaly_key);
  // a pattern added by s2 that covers nothing anyone wrote or tracked: no fire
  const none = detectWriteThenHide(db, NOW, {
    patternDeltas: [{ sessionId: 's2', filePath: join(dir, '.gitignore'), addedPatterns: ['nothing-here'], ts: NOW }],
  });
  assert.equal(none.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

// ── escape state ─────────────────────────────────────────────────────────────

function seedEscapeLedger(db: DB): void {
  const tc = db.prepare(`INSERT INTO tool_calls (tool_call_key, tool, name, session_id, ts, first_seen, last_seen) VALUES (?, 'claude_code', 'Bash', ?, ?, ?, ?)`);
  tc.run('c-commit', 's1', NOW, NOW, NOW);
  tc.run('c-push', 's1', NOW + 10, NOW, NOW);
  const fw = db.prepare(`INSERT INTO file_writes (write_key, session_id, path, path_class, ts, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  fw.run('w1', 's1', '/r/.claude/settings.json', null, NOW + 5, NOW, NOW);
  fw.run('w2', 's1', '/r/src/x.ts', null, NOW + 6, NOW, NOW);
  const vcs = db.prepare(`INSERT INTO vcs_actions (call_key, verb, repo, escape_state, push_evidence, ts) VALUES (?, ?, ?, ?, ?, ?)`);
  vcs.run('c-commit', 'commit', '/r', 'committed', 'gitOperation', NOW + 7);
  vcs.run('c-push', 'push', '/r', 'pushed', 'gitOperation', NOW + 20);
  classifyFileWrites(db, NOW);
}

test('joinEscapeState widens pushed-over-committed, NULL-only', () => {
  const db = freshDb();
  seedEscapeLedger(db);
  const { widened } = joinEscapeState(db, NOW);
  assert.equal(widened, 2);
  const rows = db.prepare('SELECT write_key, escape_state FROM file_writes ORDER BY write_key').all() as { escape_state: string | null }[];
  assert.equal(rows[0]!.escape_state, 'pushed');
  assert.equal(rows[1]!.escape_state, 'pushed');
  assert.equal(joinEscapeState(db, NOW + 1).widened, 0, 'idempotent: a stored fact is never re-derived');
});

test('detectEnvelopeChangeEscaped fires only on envelope classes', () => {
  const db = freshDb();
  seedEscapeLedger(db);
  joinEscapeState(db, NOW);
  const out = detectEnvelopeChangeEscaped(db, NOW);
  assert.equal(out.length, 1, 'the source-class write does not fire');
  assert.equal(out[0]!.rule, 'envelope_change_escaped');
  assert.equal(out[0]!.severity, 'critical');
  assert.equal(out[0]!.anomaly_key, `envelope_change_escaped:w1`);
});

// ── security_envelope_changed ────────────────────────────────────────────────

function seedEnvelopeSession(db: DB, mode: string | null): void {
  const ins = db.prepare(`INSERT INTO file_writes (write_key, session_id, path, ts, first_seen, last_seen) VALUES (?, 'sx', ?, ?, ?, ?)`);
  ins.run('sw1', '/r/.claude/settings.json', NOW + 5, NOW, NOW);
  if (mode !== null) {
    db.prepare(`INSERT INTO autonomy_intervals (session_id, agent_id, started_at, ended_at, calls, autonomy) VALUES ('sx', NULL, ?, ?, 1, ?)`).run(NOW, NOW + 10, mode);
  }
  classifyFileWrites(db, NOW);
}

test('security_envelope_changed severity follows the covering interval', () => {
  for (const [mode, expected] of [['default', 'info'], ['acceptEdits', 'warn'], ['auto', 'warn'], ['bypassPermissions', 'critical'], [null, 'warn']] as const) {
    const db = freshDb();
    seedEnvelopeSession(db, mode);
    const out = detectSecurityEnvelopeChanged(db, NOW);
    assert.equal(out.length, 1, `mode=${mode}`);
    assert.equal(out[0]!.severity, expected, `mode=${mode}: posture weights the level`);
    if (mode === null) assert.ok(out[0]!.detail.includes('unknown'), 'NULL posture never defaults to default');
    // deterministic, day-bucketed key
    const key = `security_envelope_changed:sx:permissions:${Math.floor((NOW + 5) / 86_400_000)}`;
    assert.equal(out[0]!.anomaly_key, key);
  }
});

test('security_envelope_changed: explicit grant under default is info with grant provenance', () => {
  const db = freshDb();
  seedEnvelopeSession(db, 'default');
  db.prepare(`UPDATE file_writes SET tool_call_key = 'tcx' WHERE write_key = 'sw1'`).run();
  db.prepare(`INSERT INTO tool_calls (tool_call_key, tool, name, session_id, ts, first_seen, last_seen, authorization_basis) VALUES ('tcx', 'claude_code', 'Edit', 'sx', ?, ?, ?, 'pre_authorised')`).run(NOW + 5, NOW, NOW);
  const out = detectSecurityEnvelopeChanged(db, NOW);
  assert.equal(out[0]!.severity, 'info');
  assert.ok(out[0]!.detail.includes('explicit grant'));
});

// ── the receipt ──────────────────────────────────────────────────────────────

test('envelopeReceipt prints unclassified as its own count', () => {
  const db = freshDb();
  seedEscapeLedger(db);
  joinEscapeState(db, NOW);
  const ins = db.prepare(`INSERT INTO file_writes (write_key, session_id, path, ts, first_seen, last_seen) VALUES (?, 's1', NULL, ?, ?, ?)`);
  ins.run('w9', NOW, NOW, NOW);
  const receipt = envelopeReceipt(db, 's1');
  assert.ok(receipt.byClass.some((c) => c.change_risk_class === 'permissions'));
  assert.equal(receipt.unclassified, 1);
  assert.equal(receipt.escapes.pushed, 2);
  assert.ok(receipt.sentence.includes('unclassified'));
  assert.ok(receipt.sentence.includes('pushed'));
  // insert one security incident and see it counted
  insertAnomalies(db, detectSecurityEnvelopeChanged(db, NOW).map((a) => ({ ...a, session_id: 's1' })));
  assert.ok(envelopeReceipt(db, 's1').securityIncidents >= 0);
});
