import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache } from '../db';
import { insertToolCalls } from './bind';
import {
  classifyPath,
  classifySql,
  commandSegments,
  emitNetLedgers,
  parseDbActions,
  parseGitOperation,
  parsePackageExecs,
  parseContextEdges,
  parseRemoteExec,
  parseSshConfigText,
  parseSegmentCrossing,
  parseSensitiveAccess,
  pathPrecedenceFacts,
  resolveCallScope,
  resolveTargetScope,
  shellTokens,
  writeNetLedgers,
} from './net-ledgers';

const TS = 1_700_000_000_000;

test('shellTokens honours quotes; commandSegments splits the chain', () => {
  assert.deepEqual(shellTokens('psql -c "DROP TABLE users"'), ['psql', '-c', 'DROP TABLE users']);
  assert.deepEqual(commandSegments('cd /tmp && rm -rf build; git push | cat'), ['cd /tmp', 'rm -rf build', 'git push', 'cat']);
});

test('crossings: scp/rsync direction comes from the remote side position', () => {
  const push = parseSegmentCrossing('k1', 'scp -r ./build h200:/srv/app', TS);
  assert.equal(push?.transport, 'scp');
  assert.equal(push?.direction, 'push');
  assert.equal(push?.destination, 'h200');

  const pull = parseSegmentCrossing('k2', 'rsync -a h200:/srv/app ./app', TS);
  assert.equal(pull?.direction, 'pull');

  // local-to-local copy never left the device: no row, never a fictional one
  assert.equal(parseSegmentCrossing('k3', 'rsync -a a/ b/', TS), null);
});

test('crossings: docker cp and kubectl cp carry direction; ssh carries a host', () => {
  const dcp = parseSegmentCrossing('k4', 'docker cp ./dump pgdb:/var/backups', TS);
  assert.equal(dcp?.direction, 'push');
  assert.equal(dcp?.destination, 'pgdb');
  const kcp = parseSegmentCrossing('k5', 'kubectl cp ./y.yaml web-0:/etc/y.yaml', TS);
  assert.equal(kcp?.transport, 'kubectl_cp');
  assert.equal(kcp?.destination, 'web-0');
  const ssh = parseSegmentCrossing('k6', 'ssh -p 2222 deploy@bastion.internal reboot', TS);
  assert.equal(ssh?.destination, 'bastion.internal');
  assert.equal(ssh?.direction, 'out');
});

test('ssh_config aliases collapse to the canonical host', () => {
  const cfg = parseSshConfigText('Host h200\n  HostName 195.242.30.141\n  User ops\nHost *\n  Compression yes');
  assert.equal(cfg.get('h200')?.host, '195.242.30.141');
  assert.equal(cfg.get('h200')?.user, 'ops');
  const hops = parseRemoteExec('k7', 'Bash', 'ssh h200 sudo systemctl restart app', TS, cfg);
  assert.equal(hops.length, 1);
  assert.equal(hops[0]?.host, '195.242.30.141');
  assert.equal(hops[0]?.user, 'ops');
  assert.match(hops[0]?.inner_pattern ?? '', /sudo/);
});

test('remote_exec: nested ssh records one row per hop', () => {
  const rows = parseRemoteExec('k8', 'Bash', 'ssh a.example ssh b.example tail -f /var/log/x', TS);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.hop, 1);
  assert.equal(rows[0]?.host, 'a.example');
  assert.equal(rows[1]?.hop, 2);
  assert.equal(rows[1]?.host, 'b.example');
});

test('db_actions: statement class and object names, never the SQL', () => {
  const drop = parseDbActions('k9', 'Bash', { command: `psql -c "DROP TABLE IF EXISTS audit_log"` }, TS);
  assert.equal(drop.length, 1);
  assert.equal(drop[0]?.statement_class, 'drop');
  assert.equal(drop[0]?.object_names, 'audit_log');

  const read = parseDbActions('k10', 'Bash', { command: 'mysql -e "SELECT * FROM users"' }, TS);
  assert.equal(read[0]?.statement_class, 'read');

  const reset = parseDbActions('k11', 'Bash', { command: 'npx prisma migrate reset --force' }, TS);
  assert.equal(reset[0]?.statement_class, 'migrate_reset');

  const push = parseDbActions('k12', 'Bash', { command: 'npx drizzle-kit push' }, TS);
  assert.equal(push[0]?.statement_class, 'ddl');

  // unclassifiable SQL yields no row rather than an invented class
  assert.equal(parseDbActions('k13', 'Bash', { command: 'psql -c "EXPLAIN ANALYZE SELECT"' }, TS).length, 0);
});

test('gitOperation: structured records with escape_state and evidence', () => {
  const rows = parseGitOperation('k14', { push: { branch: 'main' } }, TS, null);
  assert.equal(rows[0]?.verb, 'push');
  assert.equal(rows[0]?.escape_state, 'pushed');
  assert.match(rows[0]?.push_evidence ?? '', /structured/);
  assert.match(rows[0]?.push_evidence ?? '', /main/);

  const commit = parseGitOperation('k15', { commit: { branch: 'dev', kind: 'committed', sha: '33326fc' } }, TS, null);
  assert.equal(commit[0]?.escape_state, 'committed');
});

test('package_execs: installs and fetch-and-run, with registry provenance', () => {
  const rows = parsePackageExecs('k16', 'Bash', { command: 'npm install left-pad express' }, TS);
  assert.deepEqual(
    rows.map((r) => r.package_name).sort(),
    ['express', 'left-pad'],
  );
  assert.equal(rows[0]?.registry, 'npm');
  assert.equal(rows[0]?.fetch_and_run, 0);

  const npx = parsePackageExecs('k17', 'Bash', { command: 'npx -y steal-token@latest' }, TS);
  assert.equal(npx[0]?.fetch_and_run, 1);
  assert.equal(npx[0]?.package_name, 'steal-token');
});

test('target scope: cwd-relative blast radius, unresolved when unexpandable', () => {
  assert.equal(resolveTargetScope('rm -rf build', '/work/app').scope, 'inside_cwd');
  assert.equal(resolveTargetScope('rm -rf ../sibling', '/work/app').scope, 'outside_cwd');
  assert.equal(resolveTargetScope('rm -rf ~/.ssh', '/work/app').scope, 'home');
  assert.equal(resolveTargetScope('rm -rf /etc/paths.d/x', '/work/app').scope, 'root');
  assert.equal(resolveTargetScope('rm -rf $TARGET_DIR', '/work/app').scope, 'unresolved');
  assert.equal(resolveTargetScope('rm -rf $(pwd)', '/work/app').scope, 'unresolved');
  // git clean counts as destructive too
  assert.equal(resolveTargetScope('git clean -fd', '/work/app').scope, 'inside_cwd');
});

test('path classes: the directory is the signal', () => {
  assert.equal(classifyPath('/Users/x/.ssh/id_rsa')?.class, 'ssh_private_key');
  assert.equal(classifyPath('repo/.env.production')?.class, 'dotenv');
  assert.equal(classifyPath('/Users/x/.kube/config')?.class, 'kube_config');
  assert.equal(classifyPath('/Users/x/.npmrc')?.class, 'npm_token');
  assert.equal(classifyPath('/Users/x/notes.txt'), null);
});

test('PATH precedence: prepend vs append from the pre/post diff', () => {
  const facts = pathPrecedenceFacts('export PATH="/usr/bin:/bin"', 'export PATH="/Users/x/.local/bin:/usr/bin:/bin"');
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.entry, '/Users/x/.local/bin');
  assert.equal(facts[0]?.position, 'prepend');

  const append = pathPrecedenceFacts('export PATH="/usr/bin"', 'export PATH="/usr/bin:/opt/x/bin"');
  assert.equal(append[0]?.position, 'append');
});

test('call scopes resolve from MCP argument names, or not at all', () => {
  assert.equal(resolveCallScope('mcp__github__get_file_contents', { owner: 'acme', repo: 'billing' }, null), 'acme/billing');
  assert.equal(resolveCallScope('mcp__github__create_pr', { url: 'https://github.com/acme/billing/pull/1' }, null), 'github.com/acme/billing');
  assert.equal(resolveCallScope('mcp__weird__tool', { q: 'x' }, null), null);
});

test('sensitive access reduces to class + hash, never the path', () => {
  const rows = parseSensitiveAccess('k18', 'Read', { file_path: '/Users/x/proj/.env' }, null, TS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.path_class, 'dotenv');
  assert.match(rows[0]?.path_hash ?? '', /^[0-9a-f]{32}$/);
  assert.ok(!(rows[0] as unknown as Record<string, unknown>).file_path);
});

test('writeNetLedgers + emitNetLedgers: idempotent, incremental from the store', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'vole-nl-')), 't.db'));
  try {
    // rich rows at "bind time"
    const n1 = writeNetLedgers(db, {
      contextEdges: [{ call_key: 'c-ssh', transport: 'ssh', verb: 'ssh', destination: 'h200', direction: 'out', ts: TS }],
      dbActions: [{ call_key: 'c-db', statement_class: 'drop', object_names: 'users', target_key: 'mydb', ts: TS }],
      vcsActions: [{ call_key: 'c-git', verb: 'push', repo: null, escape_state: 'pushed', push_evidence: null, ts: TS }],
    });
    assert.ok(n1 >= 3);
    // replay is a no-op
    assert.equal(
      writeNetLedgers(db, {
        contextEdges: [{ call_key: 'c-ssh', transport: 'ssh', verb: 'ssh', destination: 'h200', direction: 'out', ts: TS }],
      }),
      0,
    );

    // from-store emission over stored shapes
    insertToolCalls(db, [
      { tool_call_key: 'c-ssh', tool: 'claude_code', name: 'Bash', ts: TS, shape: 'ssh -t' },
      { tool_call_key: 'c-scp', tool: 'claude_code', name: 'Bash', ts: TS + 1, shape: 'scp -r' },
      { tool_call_key: 'c-npm', tool: 'claude_code', name: 'Bash', ts: TS + 2, shape: 'npm install' },
      { tool_call_key: 'c-docker', tool: 'claude_code', name: 'Bash', ts: TS + 3, shape: 'docker exec' },
    ]);
    const before = db.prepare('SELECT COUNT(*) AS n FROM context_edges').get() as { n: number };
    const r1 = emitNetLedgers(db);
    // docker exec proves a crossing from the verb alone — coarse row, destination NULL;
    // scp -r proves nothing (local-to-local is possible) — no row, never a guess.
    assert.ok(r1.context_edges >= 1, 'docker exec gains a coarse crossing row');
    assert.ok(r1.package_execs >= 1, 'npm install gains a coarse package row');
    const coarse = db.prepare(`SELECT destination FROM context_edges WHERE call_key = 'c-docker'`).get() as { destination: string | null };
    assert.equal(coarse.destination, null, "the stored shape carries no host: 'not recorded', never guessed");
    // c-ssh already has a rich row: not reprocessed; the rest were coarse-processed
    const r2 = emitNetLedgers(db);
    assert.equal(r2.context_edges, 0, 'a call with a ledger row is never reprocessed');
    assert.equal(r2.package_execs, 0);
    const after = db.prepare('SELECT COUNT(*) AS n FROM context_edges').get() as { n: number };
    assert.equal(after.n, before.n + r1.context_edges);
  } finally {
    resetDbCache();
  }
});
