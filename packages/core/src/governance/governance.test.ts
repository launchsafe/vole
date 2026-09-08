import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UsageEvent } from '../types';
import { openDb, resetDbCache, insertEvents, type DB } from '../db';
import { captureScope, appendScopeEvent, scopeTimeline, scopeDiff } from './scope-history';
import {
  loadExclusionPolicy, loadEmployeeExclusions, exclusionOutcome, applyExclusions,
  orgExclusionCount, saveEmployeeExclusions,
} from './exclusions';
import { resolveDeploymentMode, productDefaults, releaseGate } from './deployment-mode';
import { loadPeopleViewPolicy, gatePeopleView, logAccess, recentAccess, principalCount, productivityViewsEnabled, subjectNotice } from './view-gate';
import { parseCodesignOutput, pppcMobileconfig, type RequirementInfo } from './pppc';
import { currentExecutionContext, foreignContext, importedContext, originBands, quarantinedRows, isOwnContext } from './context';
import { resolveScannerSwitch, loadScannerManifest } from './scanner-manifest';
import { prefilter, scanShellHistoryFile, setShellHistoryEnabled, eraseShellHistoryRows, shellHistoryScanner, AI_DICTIONARY } from './shell-history';

let dir: string;
let db: DB;

function ev(over: Partial<UsageEvent>): UsageEvent {
  return {
    event_key: 'k', tool: 'claude_code', model: 'claude-opus-5', session_id: 's',
    project: null, git_branch: null, ts: Date.parse('2026-01-01T00:00:00Z'),
    input_tokens: 5, output_tokens: 10, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0,
    cache_read_tokens: 0, reasoning_tokens: 0, total_tokens: 15, cost_usd: null,
    confidence: 'exact', is_error: 0, stop_reason: null, source: 'live', raw_ref: '/f',
    tools: null, agent_id: null, context_window: null,
    duration_ms: null, duration_kind: null,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vole-gov-'));
  resetDbCache();
  db = openDb(join(dir, 't.db'));
});

afterEach(() => {
  try {
    resetDbCache();
  } catch {
    /* already closed */
  }
});

// ── scope-change ledger ─────────────────────────────────────────────────────

test('scope ledger: first capture is a baseline, unchanged scope writes nothing', () => {
  const pol = join(dir, 'policy.json');
  writeFileSync(pol, '{"workRoots": ["/w"]}');
  const first = captureScope(db, { policyFiles: [pol], now: 1000 });
  assert.equal(first.changed, true);
  assert.equal(first.diff, null); // baseline, not a change
  const second = captureScope(db, { policyFiles: [pol], now: 2000 });
  assert.equal(second.changed, false);
  assert.equal(scopeTimeline(db).length, 1);
});

test('scope ledger: a policy edit is a field-level diff, a schema column too', () => {
  const pol = join(dir, 'policy.json');
  writeFileSync(pol, '{"a": 1}');
  captureScope(db, { policyFiles: [pol], now: 1000 });
  writeFileSync(pol, '{"a": 2}');
  const r = captureScope(db, { policyFiles: [pol], now: 2000 });
  assert.equal(r.changed, true);
  assert.ok(r.diff!.added.some((f) => f.startsWith('policy:')));
  assert.ok(r.diff!.removed.some((f) => f.startsWith('policy:')));
  const rows = scopeTimeline(db);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.parsed!.added.length, r.diff!.added.length);
  // a new column is an added field
  db.exec('ALTER TABLE usage_events ADD COLUMN test_col TEXT');
  const r2 = captureScope(db, { policyFiles: [pol], now: 3000 });
  assert.ok(r2.diff!.added.includes('schema:usage_events.test_col'));
});

test('scopeDiff: order-insensitive added/removed', () => {
  const d = scopeDiff(['a', 'b'], ['b', 'c']);
  assert.deepEqual(d, { added: ['c'], removed: ['a'] });
});

test('appendScopeEvent records who and when (shell-history toggle contract)', () => {
  appendScopeEvent(db, 'shell-history scanner enabled by shiva', { now: 5000 });
  const rows = scopeTimeline(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.parsed!.event, 'shell-history scanner enabled by shiva');
  assert.equal(rows[0]!.captured_at, 5000);
});

// ── the exclusion floor ─────────────────────────────────────────────────────

test('the floor: paths outside declared work roots are always employee-excludable', () => {
  const policy = { workRoots: ['/Users/me/work'], neverExcludable: ['/Users/me/personal'], source: null };
  const employee = { paths: ['/Users/me/personal'], source: 'x' };
  // org put the personal dir on never_excludable — outside its work roots, Vole ignores that
  const o = exclusionOutcome('/Users/me/personal/project', policy, employee);
  assert.equal(o.excluded, true);
  assert.equal(o.band, 'personal');
  assert.match(o.basis, /inalienable floor/);
});

test('inside work roots the org binds; never-excludable paths stay in', () => {
  const policy = { workRoots: ['/Users/me/work'], neverExcludable: ['/Users/me/work/crown'], source: null };
  const employee = { paths: ['/Users/me/work/crown', '/Users/me/work/other'], source: 'x' };
  assert.equal(exclusionOutcome('/Users/me/work/crown/x', policy, employee).excluded, false);
  assert.equal(exclusionOutcome('/Users/me/work/other/y', policy, employee).excluded, true);
  assert.equal(exclusionOutcome(null, policy, employee).band, 'unknown');
});

test('applyExclusions counts, never silently drops', () => {
  const policy = { workRoots: ['/w'], neverExcludable: [], source: null };
  const employee = { paths: ['/w/mine'], source: 'x' };
  const rows = [{ project: '/w/mine/a' }, { project: '/w/shared' }, { project: null }, { project: '/w/mine/b' }];
  const r = applyExclusions(rows, policy, employee);
  assert.equal(r.kept.length, 2);
  assert.equal(r.excludedCount, 2);
  assert.deepEqual(r.bands, { work: 3, personal: 0, unknown: 1 });
});

test('org receives a session COUNT only for excluded work', () => {
  const polFile = join(dir, 'exclude.json');
  writeFileSync(polFile, JSON.stringify({ workRoots: ['/Users/me/work'], neverExcludable: [] }));
  const empFile = join(dir, 'my.json');
  writeFileSync(empFile, JSON.stringify({ paths: ['/Users/me/personal'] }));
  insertEvents(db, [
    ev({ event_key: 'e1', session_id: 's1', project: '/Users/me/personal/p1' }),
    ev({ event_key: 'e2', session_id: 's1', project: '/Users/me/personal/p1/sub' }),
    ev({ event_key: 'e3', session_id: 's2', project: '/Users/me/personal/p2' }),
    ev({ event_key: 'e4', session_id: 's3', project: '/Users/me/work/real' }),
  ]);
  const n = orgExclusionCount(db, 0, { policy: [polFile], employee: empFile });
  assert.equal(n, 2); // two excluded sessions — count only, no paths leak
});

test('exclusion files load and save round-trip', () => {
  const polFile = join(dir, 'exclude.json');
  writeFileSync(polFile, JSON.stringify({ workRoots: ['/w'], neverExcludable: ['/w/x'] }));
  const p = loadExclusionPolicy([polFile]);
  assert.deepEqual(p.workRoots, ['/w']);
  const empFile = join(dir, 'my.json');
  saveEmployeeExclusions(['/p'], empFile);
  assert.deepEqual(loadEmployeeExclusions(empFile).paths, ['/p']);
});

// ── deployment mode + release gate ──────────────────────────────────────────

test('no managed profile = personal mode; a profile = managed (declared, never attested)', () => {
  assert.equal(resolveDeploymentMode({ plist: join(dir, 'none.plist'), now: 1 }).mode, 'personal');
  const plist = join(dir, 'com.launchsafe.vole.plist');
  writeFileSync(plist, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>org_label</key><string>Acme Corp</string></dict></plist>');
  const m = resolveDeploymentMode({ plist, now: 2 });
  assert.equal(m.mode, 'managed');
  assert.equal(m.declared, true);
  assert.ok(m.profile_hash && m.profile_hash.length === 64);
  assert.equal(m.org_label === 'Acme Corp' || m.org_label === null, true); // plutil availability is environmental
});

test('productDefaults invert every switch between personal and managed', () => {
  const p = productDefaults('personal');
  const m = productDefaults('managed');
  for (const k of Object.keys(p) as (keyof typeof p)[]) {
    assert.notEqual(p[k], m[k], `default ${k} must invert between modes`);
  }
  assert.equal(p.contentReadingScanners, true);
  assert.equal(m.accessAuditLog, true);
});

test('release gate: a managed build without basis record, view gate and Privacy Center is refused', () => {
  assert.equal(releaseGate({ mode: 'personal', basisRecordPresent: false, viewGatePresent: false, privacyCenterVerified: false }).pass, true);
  const bad = releaseGate({ mode: 'managed', basisRecordPresent: false, viewGatePresent: false, privacyCenterVerified: false });
  assert.equal(bad.pass, false);
  assert.equal(bad.failures.length, 3);
  const ok = releaseGate({ mode: 'managed', basisRecordPresent: true, viewGatePresent: true, privacyCenterVerified: true });
  assert.equal(ok.pass, true);
});

// ── per-person view governance ──────────────────────────────────────────────

function seedPrincipals(n: number): void {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO principals (principal_key, display, first_seen, last_seen) VALUES (?, ?, ?, ?)')
      .run(`p:${i}`, `user-${i}`, now, now);
  }
}

test('one principal: the view is a self-card and every view is logged', () => {
  seedPrincipals(1);
  const d = gatePeopleView(db, 'me', { purpose: 'self-check', now: 42 });
  assert.equal(d.allowed, true);
  assert.equal(d.basis, 'single_principal_self');
  const log = recentAccess(db, 10);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.accessor, 'me');
  assert.equal(log[0]!.purpose, 'self-check');
});

test('multi-principal without a policy block is a HARD off', () => {
  seedPrincipals(2);
  const d = gatePeopleView(db, 'me', { policy: { block: null, source: null, hash: null } });
  assert.equal(d.allowed, false);
  assert.equal(d.basis, 'refused_no_policy');
  assert.equal(recentAccess(db, 10).length, 0); // refused views leave no log row
});

test('a complete people_view block enables the view and logs with its reason', () => {
  seedPrincipals(2);
  const policy = { block: { enabled: true, granted_to: 'eng-manager', reason: 'incident review Q3' }, source: 'x', hash: 'abc' };
  const d = gatePeopleView(db, 'me', { policy, now: 7 });
  assert.equal(d.allowed, true);
  assert.equal(d.basis, 'policy_block');
  assert.match(d.message, /policy abc/);
  assert.equal(recentAccess(db, 10)[0]!.purpose, 'incident review Q3');
});

test('an enabled block missing granted_to or reason is treated as absent (hard off)', () => {
  seedPrincipals(2);
  const policy = { block: { enabled: true, granted_to: '', reason: '' }, source: 'x', hash: 'h' };
  const d = gatePeopleView(db, 'me', { policy });
  assert.equal(d.allowed, false);
});

test('people_view policy loads from the identity policy files', () => {
  const f = join(dir, 'identity.json');
  writeFileSync(f, JSON.stringify({ people_view: { enabled: true, granted_to: 'dpo', reason: 'works council agreement' } }));
  const p = loadPeopleViewPolicy([f]);
  assert.equal(p.block?.enabled, true);
  assert.equal(p.hash?.length, 64);
  const empty = join(dir, 'empty.json');
  writeFileSync(empty, '{}');
  assert.equal(loadPeopleViewPolicy([empty]).block, null);
});

test('productivity_views: on in personal, off in managed', () => {
  assert.equal(productivityViewsEnabled('personal'), true);
  assert.equal(productivityViewsEnabled('managed'), false);
});

test('the subject notice names who, why and under which policy hash', () => {
  assert.match(subjectNotice({ block: null, source: null, hash: null }, 'personal'), /your own rows only/);
  assert.match(subjectNotice({ block: null, source: null, hash: null }, 'managed'), /per-person views of your rows are off/);
  const notice = subjectNotice({ block: { enabled: true, granted_to: 'eng-manager', reason: 'incident review' }, source: 'x', hash: 'abcdef1234567890' }, 'managed');
  assert.match(notice, /eng-manager/);
  assert.match(notice, /incident review/);
  assert.match(notice, /abcdef123456/);
  assert.match(notice, /access log/);
});

// ── PPPC ────────────────────────────────────────────────────────────────────

const ADHOC_RAW = `Executable=/x/Vole.app/Contents/MacOS/Vole
Identifier=com.launchsafe.vole
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20400 size=... flags=0x0(none) hashes=0+5 location=embedded
TeamIdentifier=not set
designated => cdhash H"89b9c3c12129e12d83d9478271c004ebcbe1addc"`;

const DEVID_RAW = `Identifier=com.launchsafe.vole
TeamIdentifier=LAUNCHSAFE1
designated => identifier "com.launchsafe.vole" and anchor apple generic and certificate leaf[subject.OU] = LAUNCHSAFE1`;

test('the ad-hoc cdhash trap is detected', () => {
  const info = parseCodesignOutput(ADHOC_RAW);
  assert.equal(info.adhoc, true);
  assert.equal(info.teamIdentifier, null);
  assert.match(info.trap!, /grants die on the next rebuild/);
});

test('a Developer ID requirement is not the trap', () => {
  const info = parseCodesignOutput(DEVID_RAW);
  assert.equal(info.adhoc, false);
  assert.equal(info.trap, null);
  assert.equal(info.teamIdentifier, 'LAUNCHSAFE1');
});

test('the mobileconfig carries the requirement, identifier and ad-hoc note', () => {
  const adhoc = parseCodesignOutput(ADHOC_RAW);
  const xml = pppcMobileconfig(adhoc);
  assert.match(xml, /com\.apple\.TCC\.configuration-profile-payload/);
  assert.match(xml, /cdhash H&quot;/);
  assert.match(xml, /<string>com\.launchsafe\.vole<\/string>/);
  assert.match(xml, /_adhoc_trap_note/);
  const clean: RequirementInfo = parseCodesignOutput(DEVID_RAW);
  assert.doesNotMatch(pppcMobileconfig(clean), /_adhoc_trap_note/);
  assert.match(pppcMobileconfig(clean, { services: [{ service: 'RemovableVolumes', allowed: false }] }), /RemovableVolumes/);
});

// ── execution context and origin quarantine ─────────────────────────────────

test('the current context is stable and local; derived contexts differ', () => {
  const a = currentExecutionContext();
  const b = currentExecutionContext();
  assert.equal(a.execution_context_id, b.execution_context_id);
  assert.equal(a.origin, 'local');
  const f = foreignContext('/mnt/synced/claude');
  assert.equal(f.origin, 'foreign');
  assert.notEqual(f.execution_context_id, a.execution_context_id);
  assert.equal(importedContext('receipt-1').origin, 'imported');
  assert.equal(isOwnContext(null), null);
  assert.equal(isOwnContext(a.execution_context_id), true);
  assert.equal(isOwnContext(f.execution_context_id), false);
});

test('origin bands quarantine foreign rows and count the unknown band even at zero', () => {
  const cur = currentExecutionContext();
  insertEvents(db, [
    ev({ event_key: 'o1', session_id: 'a' }),
    ev({ event_key: 'o2', session_id: 'b' }),
  ]);
  db.exec(`UPDATE usage_events SET execution_context_id = '${cur.execution_context_id}' WHERE event_key = 'o1'`);
  db.exec(`UPDATE usage_events SET execution_context_id = 'ctx:foreign' WHERE event_key = 'o2'`);
  const bands = originBands(db, cur);
  assert.deepEqual(bands, { this_machine: 1, other_contexts: 1, origin_unknown: 0 });
  const q = quarantinedRows(db, cur);
  assert.equal(q.length, 1);
  assert.equal(q[0]!.execution_context_id, 'ctx:foreign');
  assert.equal(q[0]!.rows, 1);
});

// ── scanner manifest and switches ────────────────────────────────────────────

test('the manifest lists every scanner with reads and never-reads', () => {
  const m = loadScannerManifest();
  assert.ok(m.length >= 6);
  for (const s of m) {
    assert.ok(s.paths.length > 0, `${s.name} must declare its read paths`);
    assert.ok(s.fieldsNeverRead.length > 0, `${s.name} must declare what it never reads`);
  }
  assert.equal(m.find((s) => s.name === 'shell-history')!.defaultEnabled, false);
});

test('switches: manifest default, user override, managed pin (locked) — unknown scanners are off', () => {
  assert.equal(resolveScannerSwitch('shell-history').enabled, false);
  const userFile = join(dir, 'scanners.json');
  writeFileSync(userFile, JSON.stringify({ 'shell-history': true }));
  const user = resolveScannerSwitch('shell-history', { userFile });
  assert.equal(user.enabled, true);
  assert.equal(user.basis, 'user');
  assert.equal(user.locked, false);
  const managedFile = join(dir, 'policy.json');
  writeFileSync(managedFile, JSON.stringify({ scanners: { 'shell-history': false } }));
  const pinned = resolveScannerSwitch('shell-history', { userFile, managedFiles: [managedFile] });
  assert.equal(pinned.enabled, false);
  assert.equal(pinned.locked, true);
  assert.equal(pinned.basis, 'managed');
  assert.equal(resolveScannerSwitch('does-not-exist').enabled, false);
});

// ── the shell-history scanner ────────────────────────────────────────────────

test('prefilter matches AI windows as bytes and never decodes the rest', () => {
  const dirty = Buffer.from('cd /tmp\nls\nclaude --resume\n', 'utf8');
  const clean = Buffer.from('cd /tmp\nls\ngit status\n', 'utf8');
  assert.equal(prefilter(dirty).windows_matched, 1);
  assert.equal(prefilter(clean).windows_matched, 0);
  // a needle crossing a window boundary is caught by the half-stride overlap
  const big = Buffer.concat([Buffer.alloc(4000, 0x20), Buffer.from('claude '), Buffer.alloc(4000, 0x20)]);
  assert.ok(prefilter(big, 4096).windows_matched > 0);
});

test('scanShellHistoryFile stores a receipt, never the command text', () => {
  const f = join(dir, '.zsh_history');
  writeFileSync(f, 'ls -la\nclaude "fix the bug"\nnpm test\nexport OPENAI_API_KEY=sekrit\n');
  const r = scanShellHistoryFile(db, f, 1000);
  assert.equal(r.ok, true);
  assert.equal(r.receipt.rows_stored, 1);
  assert.equal(r.receipt.bytes_read > 0, true);
  assert.equal(r.receipt.lines_matched, 2);
  const row = db.prepare("SELECT * FROM ai_surfaces WHERE surface_key LIKE 'shell_history:%'").get() as {
    evidence: string; extra: string; scanner: string | null; evidence_kind: string | null;
  };
  assert.equal(row.scanner, 'shell-history');
  assert.equal(row.evidence_kind, 'byte-receipt');
  assert.match(row.evidence, /lines_matched=2/);
  assert.match(row.evidence, /sha256=/);
  // the command text must not be anywhere in what was stored
  assert.ok(!row.evidence.includes('fix the bug'));
  assert.ok(!JSON.parse(row.extra).receipt.file.includes('command'));
  // a file with no AI content stores nothing
  const clean = join(dir, '.bash_history');
  writeFileSync(clean, 'ls\ngit status\n');
  const r2 = scanShellHistoryFile(db, clean, 1000);
  assert.equal(r2.receipt.rows_stored, 0);
  assert.equal(r2.receipt.windows_matched, 0);
});

test('the scanner is off until the switch is on, and the toggle is ledgered', () => {
  const off = shellHistoryScanner.run(db, { home: dir });
  assert.equal(off[0]!.ok, true);
  assert.match(off[0]!.notes, /^off \(manifest\)/);
  const userFile = join(dir, 'scanners.json');
  setShellHistoryEnabled(db, 'shiva', true, { userFile, now: 123 });
  const sw = JSON.parse(readFileSync(userFile, 'utf8')) as Record<string, boolean>;
  assert.equal(sw['shell-history'], true);
  const event = scopeTimeline(db).find((r) => r.parsed?.event);
  assert.equal(event?.parsed?.event, 'shell-history scanner enabled by shiva');
  assert.equal(event?.source, 'shell-history-toggle');
  const on = shellHistoryScanner.run(db, { home: dir, userFile });
  assert.match(on[0]!.notes, /absent|bytes/); // it now actually reads (or reports absence)
  // erase drops every derived row
  const f = join(dir, '.zsh_history');
  writeFileSync(f, 'claude x\n');
  scanShellHistoryFile(db, f, 1000);
  assert.equal(eraseShellHistoryRows(db), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_surfaces WHERE surface_key LIKE 'shell_history:%'").get().n, 0);
});

test('the AI dictionary covers hosts, key-name shapes and CLIs', () => {
  for (const needle of ['api.anthropic.com', 'OPENAI_API_KEY', 'claude ']) {
    assert.ok(AI_DICTIONARY.includes(needle));
  }
});

// ── principal count sanity for the gate ─────────────────────────────────────

test('principalCount reads the principals table', () => {
  assert.equal(principalCount(db), 0);
  seedPrincipals(3);
  assert.equal(principalCount(db), 3);
});
