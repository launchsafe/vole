/**
 * Tier 3 — the principal resolution chain (feature 7) and the read-time join
 * (features 33/31 substrate).
 *
 * Who a row belongs to is resolved in a fixed precedence, and the winner is
 * RECORDED so a report can say 'MDM-asserted' rather than 'OS username,
 * unverified'. Because the usage_events upsert can never rewrite `user`, the
 * resolution is a read-time join, not a backfill: every per-person query must
 * go through `principalForUser`/`principalRows` rather than the raw column.
 *
 * Nothing local can PROVE a principal — every source is an assertion by
 * whoever controls the laptop; MDM raises the bar, a local admin can still set
 * VOLE_USER. The `declared` flag carries exactly that honesty.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import type { DB } from '../db';
import type { Anomaly, Severity, Tool } from '../types';
import { principalKey } from '../identity';

/** Where the winning username came from, in precedence order. */
export type PrincipalSource =
  | 'managed_preference' // /Library/Managed Preferences — only MDM writes there
  | 'env_vole_user' // $VOLE_USER
  | 'identity_file' // ~/.vole/identity.json
  | 'os_username'; // bare userInfo().username — the unverified floor

export interface ResolvedPrincipal {
  username: string;
  source: PrincipalSource;
  /** The file/env that produced it, for the 'which source won' sentence. */
  evidence: string;
  /** True when an admin or the user asserted it; false when it is only ambient OS state. */
  declared: boolean;
}

/** The managed-preferences domain only an MDM-delivered profile writes. */
const MANAGED_PLIST = '/Library/Managed Preferences/com.launchsafe.vole.plist';

function plistString(xml: string, key: string): string | null {
  const m = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`));
  return m?.[1] ?? null;
}

/**
 * The chain: managed preference > $VOLE_USER > ~/.vole/identity.json >
 * os.userInfo().username. First match wins; the OS username is the floor,
 * never a preference.
 */
export function resolvePrincipal(home = userInfo().username): ResolvedPrincipal {
  if (existsSync(MANAGED_PLIST)) {
    try {
      const xml = readFileSync(MANAGED_PLIST, 'utf8');
      const user = plistString(xml, 'VOLEUser') ?? plistString(xml, 'PrincipalUser');
      if (user) {
        // ponytail: a local admin can hand-write this plist — 'declared', never 'attested'.
        return { username: user, source: 'managed_preference', evidence: MANAGED_PLIST, declared: true };
      }
    } catch {
      /* unreadable: fall through */
    }
  }
  if (process.env.VOLE_USER) {
    return { username: process.env.VOLE_USER, source: 'env_vole_user', evidence: '$VOLE_USER', declared: true };
  }
  const identityFile = join(process.env.VOLE_HOME_OVERRIDE ?? homedir(), '.vole', 'identity.json');
  if (existsSync(identityFile)) {
    try {
      const cfg = JSON.parse(readFileSync(identityFile, 'utf8')) as { principal?: string };
      if (cfg.principal) {
        return { username: cfg.principal, source: 'identity_file', evidence: identityFile, declared: true };
      }
    } catch {
      /* malformed: fall through */
    }
  }
  return { username: home, source: 'os_username', evidence: 'os.userInfo().username', declared: false };
}

// Homedir without a top-level os import cycle at module scope.
import { homedir as require$$homedir } from 'node:os';

/**
 * Upserts the resolved principal with its source and validity window
 * (NULL-only widening — a stored fact is never re-derived away), and records
 * a source transition in scope_history: who a row belongs to is exactly the
 * kind of monitoring-scope change § 87(1) Nr. 6 attaches to.
 */
export function recordPrincipal(db: DB, resolved: ResolvedPrincipal, now = Date.now()): string {
  const pk = principalKey(resolved.username);
  const prev = db
    .prepare('SELECT principal_source, valid_from, valid_to FROM principals WHERE principal_key = ?')
    .get(pk) as { principal_source: string | null; valid_from: number | null; valid_to: number | null } | undefined;
  if (!prev) {
    db.prepare(
      `INSERT INTO principals (principal_key, display, first_seen, last_seen, principal_source, valid_from)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(pk, `user-${pk.slice(2, 8)}`, now, now, resolved.source, now);
    return pk;
  }
  db.prepare('UPDATE principals SET last_seen = ? WHERE principal_key = ?').run(now, pk);
  if (prev.principal_source === null) {
    db.prepare('UPDATE principals SET principal_source = ?, valid_from = ? WHERE principal_key = ? AND principal_source IS NULL')
      .run(resolved.source, now, pk);
  } else if (prev.principal_source !== resolved.source) {
    // Close the old source's interval, open the new one's — and leave a
    // field-level diff in the scope ledger so the change is employee-visible.
    db.prepare('UPDATE principals SET valid_to = ?, principal_source = ?, valid_from = ? WHERE principal_key = ?')
      .run(now, resolved.source, now, pk);
    db.prepare(
      `INSERT INTO scope_history (captured_at, sha256, diff, source) VALUES (?, ?, ?, ?)`,
    ).run(
      now,
      pk,
      JSON.stringify({ field: 'principal_source', from: prev.principal_source, to: resolved.source }),
      resolved.evidence,
    );
  }
  return pk;
}

/** The read-time join: the principal row a cleartext `user` value resolves to, or null. */
export function principalForUser(db: DB, user: string | null): {
  principal_key: string; display: string; principal_source: string | null;
  first_seen: number; last_seen: number; valid_from: number | null; valid_to: number | null;
} | null {
  if (!user) return null;
  return (
    db.prepare(
      `SELECT principal_key, display, principal_source, first_seen, last_seen, valid_from, valid_to
       FROM principals WHERE principal_key = ?`,
    ).get(principalKey(user)) ?? null
  );
}

/**
 * DDL for the `v_events_principal` view the spec names. NOT executed here:
 * views belong to the migration seam (db.ts owns MIGRATIONS), so the
 * integrator registers this constant with the foundation. The read-time join
 * functions above are the same join, executable today.
 */
export const V_EVENTS_PRINCIPAL_DDL = `
CREATE VIEW IF NOT EXISTS v_events_principal AS
SELECT e.*, p.display AS principal_display, p.principal_source, p.valid_from, p.valid_to
FROM usage_events e
LEFT JOIN principals p ON p.principal_key = e.subject_id`;

/** How strongly a principal's rows are bound, as the (bound, ambient, unbound) triple. */
export interface BindingTriple {
  session_proved: number;
  ambient: number;
  unbound: number;
  /** Sessions with no binding row at all — never merged into a named person's total. */
  no_identity_row: number;
}

export interface PrincipalRow {
  principal_key: string;
  display: string;
  principal_source: string | null;
  first_seen: number;
  last_seen: number;
  sessions: number;
  calls: number;
  tokens: number | null;
  cost_usd: number | null;
  incidents: { info: number; warn: number; critical: number };
  account_classes: { tool: Tool | null; account_class: string | null; sessions: number }[];
  binding: BindingTriple;
}

/**
 * The People read model (feature 33): one row per resolved principal through
 * the read-time join, never through the raw user column — with the binding
 * triple attached to every figure. Rows with NULL user land in the separate
 * 'origin unknown' bucket the caller renders, never here.
 */
export function principalRows(db: DB, includeSeed = false): { principals: PrincipalRow[]; originUnknown: { calls: number; tokens: number | null } } {
  const src = includeSeed ? '' : "AND source = 'live'";
  const users = db
    .prepare(`SELECT DISTINCT user FROM usage_events e WHERE user IS NOT NULL ${includeSeed ? '' : "AND e.source = 'live'"}`)
    .all() as { user: string }[];
  const principals: PrincipalRow[] = [];
  for (const { user } of users) {
    const p = principalForUser(db, user);
    if (!p) continue;
    const agg = db.prepare(
      `SELECT COUNT(DISTINCT e.session_id) AS sessions, COUNT(*) AS calls,
              SUM(e.total_tokens) AS tokens, SUM(e.cost_usd) AS cost, MIN(e.ts) AS first, MAX(e.ts) AS last
       FROM usage_events e WHERE e.user = ? ${src}`,
    ).get(user) as { sessions: number; calls: number; tokens: number | null; cost: number | null; first: number; last: number };
    const inc = db.prepare(
      `SELECT severity, COUNT(*) AS n FROM anomalies WHERE user = ? ${includeSeed ? '' : "AND source = 'live'"} GROUP BY severity`,
    ).all(user) as { severity: string; n: number }[];
    const classes = db.prepare(
      `SELECT si.tool, si.account_class, COUNT(DISTINCT si.session_id) AS n
       FROM session_identity si WHERE si.principal_key = ?
       GROUP BY si.tool, si.account_class ORDER BY n DESC`,
    ).all(p.principal_key) as { tool: Tool | null; account_class: string | null; n: number }[];
    const bind = db.prepare(
      `SELECT binding_evidence, COUNT(*) AS n FROM session_identity WHERE principal_key = ? GROUP BY binding_evidence`,
    ).all(p.principal_key) as { binding_evidence: string; n: number }[];
    const triple: BindingTriple = { session_proved: 0, ambient: 0, unbound: 0, no_identity_row: 0 };
    for (const b of bind) {
      if (b.binding_evidence === 'session_proved') triple.session_proved = b.n;
      else if (b.binding_evidence === 'ambient') triple.ambient = b.n;
      else if (b.binding_evidence === 'unbound') triple.unbound = b.n;
      else if (b.binding_evidence === 'none' || b.binding_evidence === null) triple.unbound += b.n;
    }
    const sessionsWithIdentity = new Set(
      (db.prepare(`SELECT session_id FROM session_identity WHERE principal_key = ?`).all(p.principal_key) as { session_id: string }[]).map((r) => r.session_id),
    );
    const sessionCount = db.prepare(
      `SELECT COUNT(DISTINCT session_id) AS n FROM usage_events WHERE user = ? AND session_id IS NOT NULL ${src}`,
    ).get(user) as { n: number };
    triple.no_identity_row = Math.max(0, sessionCount.n - sessionsWithIdentity.size);
    principals.push({
      principal_key: p.principal_key,
      display: p.display,
      principal_source: p.principal_source,
      first_seen: agg.first ?? p.first_seen,
      last_seen: agg.last ?? p.last_seen,
      sessions: agg.sessions,
      calls: agg.calls,
      tokens: agg.tokens,
      cost_usd: agg.cost,
      incidents: {
        info: inc.find((i) => i.severity === 'info')?.n ?? 0,
        warn: inc.find((i) => i.severity === 'warn')?.n ?? 0,
        critical: inc.find((i) => i.severity === 'critical')?.n ?? 0,
      },
      account_classes: classes.map((c) => ({ tool: c.tool, account_class: c.account_class, sessions: c.n })),
      binding: triple,
    });
  }
  const unknown = db
    .prepare(`SELECT COUNT(*) AS calls, SUM(total_tokens) AS tokens FROM usage_events e WHERE user IS NULL ${includeSeed ? '' : "AND e.source = 'live'"}`)
    .get() as { calls: number; tokens: number | null };
  return { principals, originUnknown: { calls: unknown.calls, tokens: unknown.tokens } };
}

/** `vole whoami` / the vole_identity MCP tool: truncated ids only, never auth shapes. */
export interface WhoamiToolRow {
  tool: Tool;
  account_class: string | null;
  plan: string | null;
  org_id: string | null;
  binding_evidence: string;
  sessions: number;
  last_seen: number;
}

export interface WhoamiModel {
  principal: { label: string; source: PrincipalSource; evidence: string; declared: boolean };
  machine: { machine_uuid: string | null; hostname: string | null; hostname_history: { hostname: string; first_seen: number; last_seen: number }[] };
  tools: WhoamiToolRow[];
}

/**
 * When `restrictTo` is set (a multi-principal store without the people_view
 * grant), only that principal's sessions are reported — the caller's own
 * principal only, never the other people on the machine.
 */
export function whoamiModel(db: DB, restrictTo: string | null = null): WhoamiModel {
  const resolved = resolvePrincipal();
  const machine = machineUuidRaw();
  const hostnames = db
    .prepare('SELECT hostname, first_seen, last_seen FROM hostname_history ORDER BY last_seen DESC LIMIT 20')
    .all() as { hostname: string; first_seen: number; last_seen: number }[];
  const filter = restrictTo ? 'WHERE principal_key = ?' : '';
  const tools = db.prepare(
    `SELECT tool, account_class, plan, org_id, binding_evidence, MAX(last_seen) AS last_seen, COUNT(*) AS n
     FROM session_identity ${filter}
     GROUP BY tool, account_class, plan, org_id, binding_evidence ORDER BY last_seen DESC`,
  ).all(...(restrictTo ? [restrictTo] : [])) as { tool: Tool; account_class: string | null; plan: string | null; org_id: string | null; binding_evidence: string; last_seen: number; n: number }[];
  return {
    principal: {
      label: `user-${principalKey(resolved.username).slice(2, 8)}`,
      source: resolved.source,
      evidence: resolved.evidence,
      declared: resolved.declared,
    },
    machine: { machine_uuid: machine ? `d:${machine.slice(0, 12)}…` : null, hostname: hostnameRaw(), hostname_history: hostnames },
    tools: tools.map((t) => ({
      tool: t.tool,
      account_class: t.account_class,
      plan: t.plan,
      org_id: t.org_id ? `${t.org_id.slice(0, 8)}…` : null,
      binding_evidence: t.binding_evidence,
      sessions: t.n,
      last_seen: t.last_seen,
    })),
  };
}

function hostnameRaw(): string | null {
  try {
    return hostname() || null;
  } catch {
    return null;
  }
}

/** The raw IOPlatformUUID (never stored — only its HMAC is). */
export function machineUuidRaw(): string | null {
  try {
    const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 4000 });
    return out.match(/"IOPlatformUUID" = "([^"]+)"/)?.[1] ?? null;
  } catch {
    return null; // Linux/CI: no IOPlatformUUID — hostname is the only key
  }
}

// ── feature 37: the principal_conflict guard ────────────────────────────────

const DAY_MS = 86_400_000;

interface Pair { user: string; machine: string; calls: number }

function anomaly(rule: Anomaly['rule'], anomalyKey: string, severity: Severity, title: string, detail: string, ts: number, now: number): Anomaly {
  return {
    anomaly_key: anomalyKey, rule, severity, tool: 'claude_code', session_id: null, model: null,
    window_start: ts, window_end: ts, title, detail, observed: 1, baseline: null, threshold: null,
    confidence: 'activity_only', source: 'live', detected_at: now,
  };
}

/**
 * One machine_uuid under more than one OS username, or one OS username under
 * more than one machine_uuid — both shapes break per-employee reporting
 * silently, so this is an info-severity guard, never a verdict about intent.
 * Keyed on the utc DAY of observation, so one conflict per day, never per poll.
 */
export function detectPrincipalConflicts(db: DB, now = Date.now()): Anomaly[] {
  const out: Anomaly[] = [];
  for (const source of ['live', 'seed'] as const) {
    const pairs = db
      .prepare('SELECT user, machine, COUNT(*) AS calls FROM usage_events WHERE source = ? AND user IS NOT NULL AND machine IS NOT NULL GROUP BY user, machine')
      .all(source) as Pair[];
    const byMachine = new Map<string, string[]>();
    const byUser = new Map<string, string[]>();
    for (const p of pairs) {
      byMachine.set(p.machine, [...(byMachine.get(p.machine) ?? []), p.user]);
      byUser.set(p.user, [...(byUser.get(p.user) ?? []), p.machine]);
    }
    const day = Math.floor(now / DAY_MS);
    const emit = (kind: 'machine' | 'user', key: string, peers: string[]): void => {
      const sorted = [...new Set(peers)].sort();
      if (sorted.length < 2) return;
      const a = anomaly(
        'principal_conflict',
        `identity:principal_conflict:${key}:${sorted.join('|')}:${day}`,
        'info',
        `${sorted.length} OS accounts seen on this ${kind === 'machine' ? 'Mac' : 'username'}; per-person figures are held back`,
        `Conflicting values: ${sorted.join(', ')}. This is a record, not a verdict — it cannot tell a shared laptop from a renamed OS account, and it only sees usernames Vole itself ran under.`,
        now, now,
      );
      a.source = source;
      out.push({ ...a, anomaly_key: `${source}:${a.anomaly_key}` });
    };
    for (const [machine, users] of byMachine) emit('machine', machine, users);
    for (const [user, machines] of byUser) emit('user', user, machines);
  }
  return out;
}
