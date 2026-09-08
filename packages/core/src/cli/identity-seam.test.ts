/**
 * The identity seam end-to-end: the People view's session_identity join
 * (queries.ts getByPrincipal), the collect identity pass's session-class fill
 * (identity/accounts.ts recordSessionIdentityClasses) and the whoami NULL-tool
 * guard. Seeded against the live-store defect: principals are keyed p:<HMAC>
 * while usage_events.user is cleartext, so any join that matches them
 * directly returns zero rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDb, resetDbCache, type DB } from '../db';
import { recordIdentity, principalKey } from '../identity';
import { upsertSessionIdentity, recordSessionIdentityClasses } from '../identity/accounts';
import { getByPrincipal } from '../queries';

function freshDb(): { db: DB; dir: string } {
  resetDbCache();
  const dir = mkdtempSync(join(tmpdir(), 'vole-identity-seam-'));
  const db = openDb(join(dir, 't.db'));
  return { db, dir };
}

const T = Date.parse('2026-01-01T00:00:00Z');

function seedEvent(db: DB, key: string, session: string | null, user: string | null, tokens: number): void {
  db.prepare(`INSERT INTO usage_events (event_key, tool, ts, confidence, source, session_id, user, machine, total_tokens, cost_usd)
              VALUES (?, 'claude_code', ?, 'exact', 'live', ?, ?, 'm1', ?, 1.0)`).run(key, T, session, user, tokens);
}

test('getByPrincipal: joins usage_events -> session_identity.principal_key -> principals, never the cleartext user', () => {
  const { db } = freshDb();
  recordIdentity(db, 'shiva', 'm1');
  const pk = principalKey('shiva');
  seedEvent(db, 'k1', 's1', 'shiva', 100);
  seedEvent(db, 'k2', 's2', 'shiva', 50);
  seedEvent(db, 'k3', null, null, 10); // no session, no user: origin unknown
  upsertSessionIdentity(db, [
    { session_id: 's1', tool: 'claude_code', principal_key: pk, binding_evidence: 'store_origin', first_seen: T, last_seen: T },
    { session_id: 's2', tool: 'claude_code', principal_key: pk, binding_evidence: 'session_proved', account_class: 'org_oauth', first_seen: T, last_seen: T },
  ]);
  db.prepare(`INSERT INTO anomalies (anomaly_key, rule, severity, tool, session_id, window_start, window_end, title, detail, observed, confidence, source, detected_at)
              VALUES ('ak1', 'repeat_call_loop', 'warn', 'claude_code', 's1', ?, ?, 't', 'd', 1, 'exact', 'live', ?)`).run(T, T, T);
  const { principals, originUnknown } = getByPrincipal(db, 'all', false);
  assert.equal(principals.length, 1, 'the keyed principal is found through the session join');
  const p = principals[0]!;
  assert.equal(p.principal_key, pk);
  assert.equal(p.calls, 2);
  assert.equal(p.tokens, 150);
  assert.equal(p.incidents.warn, 1, 'incidents join through session_identity too');
  assert.deepEqual([p.binding.session_proved, p.binding.no_identity_row], [1, 0]);
  assert.equal(originUnknown.calls, 1, 'events with no identity row fall to the origin-unknown bucket');
});

test('recordSessionIdentityClasses: codex plan proves the class, bridge-session proves org_oauth, the snapshot stamps ambient', () => {
  const { db, dir } = freshDb();
  const home = join(dir, 'home');
  mkdirSync(home);
  // The current-account snapshot: a personal Max subscription.
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    oauthAccount: { organizationType: 'claude_max', seatTier: null, organizationUuid: null },
  }));
  const pk = principalKey('shiva');
  // A codex session whose own rollout recorded plan_type 'team' (recordSessionPlan shape).
  upsertSessionIdentity(db, [{ session_id: 'sx', tool: 'codex', plan: 'team', binding_evidence: 'session_proved', first_seen: T, last_seen: T }]);
  // A claude session with a bridge-session ownerOrganizationUuid in event_links.
  db.prepare(`INSERT INTO event_links (event_key, vendor, link_kind, link_id, first_seen)
              VALUES ('claude_code:session:sy', 'claude_code', 'owner_organization_uuid', 'org-uuid-1', ?)`).run(T);
  // Two ambient candidates: one classless store_origin session, one already proved.
  seedEvent(db, 'k1', 's1', 'shiva', 100);
  seedEvent(db, 'k2', 's2', 'shiva', 100);
  upsertSessionIdentity(db, [
    { session_id: 's1', principal_key: pk, binding_evidence: 'store_origin', first_seen: T, last_seen: T },
    { session_id: 's2', principal_key: pk, binding_evidence: 'session_proved', account_class: 'team_seat', first_seen: T, last_seen: T },
  ]);
  const n = recordSessionIdentityClasses(db, pk, 'd:x', T, home);
  assert.ok(n >= 3);
  const row = (sid: string) => db.prepare('SELECT * FROM session_identity WHERE session_id = ?').get(sid) as Record<string, unknown>;
  assert.equal(row('sx').account_class, 'team_seat');
  assert.equal(row('sx').binding_evidence, 'session_proved');
  assert.equal(row('sx').class_evidence, 'rate_limits.plan_type=team');
  assert.equal(row('sy').account_class, 'org_oauth');
  assert.equal(row('sy').org_id, 'org-uuid-1');
  assert.equal(row('sy').binding_evidence, 'session_proved');
  assert.equal(row('s1').account_class, 'personal_oauth', 'the snapshot stamps the classless session');
  assert.equal(row('s1').binding_evidence, 'store_origin', 'ambient never downgrades a stronger binding');
  assert.equal(row('s2').account_class, 'team_seat', 'a stored fact is never re-derived away');
});

test('recordSessionIdentityClasses: unknown is never stamped — class stays NULL', () => {
  const { db, dir } = freshDb();
  const home = join(dir, 'home'); // empty: no identity-bearing file at all
  mkdirSync(home);
  const pk = principalKey('shiva');
  seedEvent(db, 'k1', 's1', 'shiva', 100);
  upsertSessionIdentity(db, [{ session_id: 's1', principal_key: pk, binding_evidence: 'store_origin', first_seen: T, last_seen: T }]);
  assert.equal(recordSessionIdentityClasses(db, pk, 'd:x', T, home), 0);
  const row = db.prepare('SELECT account_class, binding_evidence FROM session_identity WHERE session_id = ?').get('s1') as { account_class: string | null; binding_evidence: string };
  assert.equal(row.account_class, null, 'never a guess');
  assert.equal(row.binding_evidence, 'store_origin');
});

test('whoami: exits 0 on a store whose session_identity rows have a NULL tool', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vole-whoami-'));
  resetDbCache();
  const db = openDb(join(dir, '.vole', 'vole.db'));
  db.prepare(`INSERT INTO session_identity (session_id, principal_key, binding_evidence, first_seen, last_seen)
              VALUES ('s1', 'p:abc', 'store_origin', ?, ?)`).run(T, T); // tool NULL — the crash shape
  db.close();
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/cli/identity.ts', 'whoami'],
    { cwd: join(import.meta.dirname, '..', '..'), env: { ...process.env, VOLE_HOME_OVERRIDE: dir }, encoding: 'utf8' },
  );
  assert.equal(r.status, 0, `whoami must exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /principal :/);
  assert.match(r.stdout, /unknown {2}/);
});
