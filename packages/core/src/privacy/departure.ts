/**
 * Tier 8: the lifecycle family. principal_lifecycle is a DECLARED state,
 * never an inferred one: nothing in this module (or anywhere) may write it
 * from observation. Silence means the collector was off, the tool's retention
 * pruned the source, or the person was on leave — it never means departed.
 * Vole records who said so, when, and on what basis; it cannot know anyone
 * left a company.
 *
 * On top of the declarations: activity_after_departure (the credential that
 * outlived the person), the departure evidence pack (one principal, one
 * window, a denominator on every figure), the purpose-gated before/after
 * delta against the principal's own baseline, the at-exit credential
 * residency/liveness sweep, the evidence freeze (hash the raw_ref sources
 * before they age out), and the scope-change diff for movers with the
 * residual-reach column.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db';
import type { Anomaly, PrincipalState, Tool } from '../types';
import { paths } from '../paths';

// ── declarations ─────────────────────────────────────────────────────────────

export interface LifecycleDeclaration {
  principal_key: string;
  state: PrincipalState;
  effective_from: number;
  effective_to?: number | null;
  declared_by?: string | null;
  basis?: string | null;
  source?: string | null;
}

export function declHash(d: LifecycleDeclaration): string {
  return `sha256:${createHash('sha256')
    .update([d.principal_key, d.state, d.effective_from, d.effective_to ?? '', d.declared_by ?? '', d.basis ?? ''].join('|'))
    .digest('hex').slice(0, 24)}`;
}

/**
 * Appends one declaration. Append-only: one row per declaration, never updated
 * in place, so the state at any past instant is a query, not a mutable column.
 * Re-declaring the same tuple is an idempotent no-op.
 */
export function declareLifecycle(db: DB, d: LifecycleDeclaration, now: number = Date.now()): number {
  return db
    .prepare(
      `INSERT OR IGNORE INTO principal_lifecycle
         (principal_key, state, effective_from, effective_to, declared_by, basis, decl_hash, source, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      d.principal_key, d.state, d.effective_from, d.effective_to ?? null,
      d.declared_by ?? null, d.basis ?? null, declHash(d),
      d.source ?? 'cli', now, now,
    ).changes;
}

/** The lifecycle[] block of the identity policy (managed mode). */
export interface PolicyLifecycleEntry {
  principal_key: string;
  state: PrincipalState;
  effective_from: number;
  effective_to?: number | null;
  declared_by?: string | null;
  basis?: string | null;
}

export function loadLifecyclePolicy(
  files: string[] = paths.identityPolicyPaths(),
): { path: string; entries: PolicyLifecycleEntry[] }[] {
  const out: { path: string; entries: PolicyLifecycleEntry[] }[] = [];
  for (const p of files) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { lifecycle?: PolicyLifecycleEntry[] };
      if (Array.isArray(parsed.lifecycle)) {
        out.push({
          path: p,
          entries: parsed.lifecycle.filter(
            (e) => typeof e?.principal_key === 'string' && typeof e?.state === 'string' && typeof e?.effective_from === 'number',
          ),
        });
      }
    } catch {
      /* malformed layer ignored */
    }
  }
  return out;
}

/** Writes every policy declaration into the ledger, source='policy'. Idempotent. */
export function syncLifecycleFromPolicy(db: DB, now: number = Date.now()): number {
  let n = 0;
  for (const layer of loadLifecyclePolicy()) {
    for (const e of layer.entries) {
      n += declareLifecycle(db, { ...e, source: `policy:${layer.path}` }, now);
    }
  }
  return n;
}

export interface LifecycleStateAt {
  principal_key: string;
  state: PrincipalState;
  effective_from: number;
  declared_by: string | null;
  basis: string | null;
  decl_hash: string | null;
}

/** The latest declaration with effective_from <= t (and not yet expired). The state at any past instant. */
export function stateAt(db: DB, principalKey: string, t: number): LifecycleStateAt | null {
  return (db
    .prepare(
      `SELECT principal_key, state, effective_from, declared_by, basis, decl_hash
       FROM principal_lifecycle
       WHERE principal_key = ? AND effective_from <= ?
         AND (effective_to IS NULL OR effective_to > ?)
       ORDER BY effective_from DESC LIMIT 1`,
    )
    .get(principalKey, t, t) as LifecycleStateAt | undefined) ?? null;
}

/** Every principal with a current (at t) state — the People view's chips. */
export function currentStates(db: DB, t: number = Date.now()): LifecycleStateAt[] {
  const keys = db.prepare(`SELECT DISTINCT principal_key FROM principal_lifecycle`).all() as { principal_key: string }[];
  const out: LifecycleStateAt[] = [];
  for (const k of keys) {
    const s = stateAt(db, k.principal_key, t);
    if (s) out.push(s);
  }
  return out;
}

// ── activity_after_departure ────────────────────────────────────────────────

/** The predicate matching a principal's live rows: subject_id or a bound session. */
const SUBJECT_ROWS = `source = 'live' AND (subject_id = :pk OR session_id IN
  (SELECT session_id FROM session_identity WHERE principal_key = :pk))`;

/**
 * The rule: for any principal whose latest declaration at time t is 'departed',
 * any live row with ts > effective_from fires. Keyed on the event's own ts
 * (never ingest time), one incident per principal per UTC day bucket per tool,
 * no now() in the key. observed = rows after the declaration; baseline = the
 * principal's rows in the seven days before it; threshold = 0.
 */
export function activityAfterDeparture(db: DB, now: number = Date.now()): Anomaly[] {
  const out: Anomaly[] = [];
  const keys = db
    .prepare(`SELECT DISTINCT principal_key FROM principal_lifecycle`)
    .all() as { principal_key: string }[];
  for (const { principal_key: pk } of keys) {
    const st = stateAt(db, pk, now);
    if (!st || st.state !== 'departed') continue;
    const after = db.prepare(
      `SELECT CAST(ts / 86400000 AS INTEGER) AS day, tool, COUNT(*) AS n
       FROM usage_events WHERE ${SUBJECT_ROWS} AND ts > :from
       GROUP BY day, tool`,
    ).all({ pk, from: st.effective_from }) as { day: number; tool: string; n: number }[];
    if (after.length === 0) continue;
    const baseline = (db.prepare(
      `SELECT COUNT(*) AS n FROM usage_events WHERE ${SUBJECT_ROWS} AND ts > :from - 604800000 AND ts <= :from`,
    ).get({ pk, from: st.effective_from }) as { n: number }).n;
    for (const a of after) {
      out.push({
        anomaly_key: `live:activity_after_departure:${pk}:${a.day}:${a.tool}`,
        rule: 'activity_after_departure',
        severity: 'critical',
        tool: a.tool as Tool,
        session_id: null,
        model: null,
        window_start: a.day * 86_400_000,
        window_end: (a.day + 1) * 86_400_000 - 1,
        title: `Activity after departure: ${a.tool}`,
        detail:
          `${a.n} live row(s) for a departed principal on UTC day ${a.day} ` +
          `(declared by ${st.declared_by ?? 'unknown'}, basis ${st.basis ?? 'unknown'}). ` +
          `A shared laptop, a CI runner or a sudo session under the leaver's OS account produces ` +
          `identical rows — attributed weakly, never a named person.`,
        observed: a.n,
        baseline,
        threshold: 0,
        confidence: 'exact',
        source: 'live',
        detected_at: now,
      });
    }
  }
  return out;
}

// ── credential residency and liveness sweep ──────────────────────────────────

export interface CredentialRow {
  /** Where the credential NAME lives — never a value. */
  where: string;
  name: string;
  kind: 'oauth' | 'api_key_name' | 'keychain_service' | 'account_id';
  state: 'live_oauth' | 'key_name_present' | 'no_use_observed';
  /** Last refresh when the source states one (e.g. auth.json last_refresh). */
  last_refresh: number | null;
  note: string;
}

/**
 * At-exit sweep: enumerate where provider credentials still live on this
 * device — names and metadata only, never a value. ~/.codex/auth.json
 * auth_mode/last_refresh, OPENAI_API_KEY presence, Keychain service names
 * from `security dump-keychain` attributes. A name is not a valid credential
 * and absence is not proof one was never there: a locked keychain or a
 * missing Full Disk Access grant yields NULL, not zero.
 */
export function credentialSweep(homeDir: string = paths.home()): CredentialRow[] {
  const out: CredentialRow[] = [];
  // ~/.codex/auth.json — auth_mode and last_refresh are metadata, not material.
  const authJson = join(homeDir, '.codex', 'auth.json');
  if (existsSync(authJson)) {
    try {
      const auth = JSON.parse(readFileSync(authJson, 'utf8')) as {
        auth_mode?: string;
        last_refresh?: string;
        tokens?: { account_id?: string };
        OPENAI_API_KEY?: string;
      };
      if (typeof auth.auth_mode === 'string') {
        out.push({
          where: '~/.codex/auth.json',
          name: 'auth_mode',
          kind: 'oauth',
          state: 'live_oauth',
          last_refresh: auth.last_refresh ? Date.parse(auth.last_refresh) || null : null,
          note: `auth_mode '${auth.auth_mode}'${auth.last_refresh ? `, refreshed ${auth.last_refresh}` : ', last_refresh not stated'}`,
        });
      }
      if (auth.tokens && typeof auth.tokens.account_id === 'string') {
        out.push({
          where: '~/.codex/auth.json', name: 'tokens.account_id (presence)', kind: 'account_id',
          state: 'live_oauth', last_refresh: null, note: 'account id present — the session maps to a vendor console row',
        });
      }
    } catch {
      /* unreadable: a permission fact, not an absence fact */
    }
  }
  if (process.env.OPENAI_API_KEY) {
    out.push({
      where: 'environment', name: 'OPENAI_API_KEY', kind: 'api_key_name',
      state: 'key_name_present', last_refresh: null,
      note: 'an OpenAI key is exported in this shell — the VALUE is never read',
    });
  }
  // Keychain service names — attributes only, via the same binary every other
  // keychain touch in this codebase uses.
  try {
    const dump = execFileSync('security', ['dump-keychain'], { encoding: 'utf8', timeout: 8000 });
    const seen = new Set<string>();
    for (const line of dump.split('\n')) {
      const m = line.match(/^\s*"svce"<blob>="([^"]+)"/);
      if (!m) continue;
      if (seen.has(m[1]!)) continue;
      seen.add(m[1]!);
      out.push({
        where: 'keychain', name: m[1]!, kind: 'keychain_service',
        state: 'no_use_observed', last_refresh: null,
        note: 'keychain service name — a name is not a valid credential',
      });
    }
  } catch {
    /* locked keychain or non-macOS: NULL, never zero */
  }
  return out;
}

// ── evidence freeze ─────────────────────────────────────────────────────────

export interface FreezeResult {
  freeze_id: string;
  rows_referencing: number;
  paths: number;
  hashed: number;
  already_gone: number;
  budget_capped: number;
}

/**
 * One bounded pass over the distinct raw_ref paths behind the principal's
 * rows in the window: file metadata and a sha256, never a byte of content —
 * the content boundary holds. A digest proves the file's bytes at freeze
 * time, not at event time; a source deleted before the freeze is gone for
 * good (present=0, the pack says 'source deleted', never 'no activity').
 * Hashing is I/O, so it runs under a byte budget: past the cap, sha256 stays
 * NULL with reason='budget' rather than stalling the pass. Re-runs append
 * (new paths); stored rows are never rewritten.
 */
export function freezeEvidence(
  db: DB,
  principalKey: string,
  windowStart: number,
  windowEnd: number,
  opts: { freezeId?: string; byteBudget?: number } = {},
): FreezeResult {
  const budget = opts.byteBudget ?? 64 * 1024 * 1024;
  const freezeId = opts.freezeId ?? freezeIdFor(db, principalKey);
  const refs = db.prepare(
    `SELECT raw_ref, COUNT(*) AS n FROM usage_events
     WHERE raw_ref IS NOT NULL AND source = 'live' AND ts >= ? AND ts < ?
       AND (subject_id = ? OR session_id IN (SELECT session_id FROM session_identity WHERE principal_key = ?))
     GROUP BY raw_ref`,
  ).all(windowStart, windowEnd, principalKey, principalKey) as { raw_ref: string; n: number }[];
  const ins = db.prepare(
    `INSERT OR IGNORE INTO evidence_freeze
       (freeze_id, principal_key, declared_at, path, present, size_bytes, mtime, sha256, consumed_to_offset, rows_referencing, reason, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  );
  let hashed = 0;
  let gone = 0;
  let capped = 0;
  let spent = 0;
  const now = Date.now();
  for (const r of refs) {
    let st: { size: number; mtimeMs: number } | null = null;
    try {
      const s = statSync(r.raw_ref);
      st = { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      st = null;
    }
    if (!st) {
      gone++;
      ins.run(freezeId, principalKey, now, r.raw_ref, 0, null, null, null, r.n, 'source deleted', now);
      continue;
    }
    if (spent + st.size > budget) {
      capped++;
      ins.run(freezeId, principalKey, now, r.raw_ref, 1, st.size, st.mtimeMs, null, r.n, 'budget', now);
      continue;
    }
    const sha = sha256File(r.raw_ref);
    spent += st.size;
    if (sha === null) {
      capped++;
      ins.run(freezeId, principalKey, now, r.raw_ref, 1, st.size, st.mtimeMs, null, r.n, 'unreadable', now);
    } else {
      hashed++;
      ins.run(freezeId, principalKey, now, r.raw_ref, 1, st.size, st.mtimeMs, sha, r.n, null, now);
    }
  }
  return {
    freeze_id: freezeId,
    rows_referencing: refs.reduce((a, r) => a + r.n, 0),
    paths: refs.length,
    hashed,
    already_gone: gone,
    budget_capped: capped,
  };
}

/** Deterministic freeze id from the principal's departure declaration — never now(). */
export function freezeIdFor(db: DB, principalKey: string, t: number = Date.now()): string {
  const st = stateAt(db, principalKey, t);
  return `freeze:${principalKey}:${st ? `${st.state}:${st.effective_from}` : 'undeclared'}`;
}

function sha256File(path: string): string | null {
  try {
    return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  } catch {
    return null; // unreadable at freeze time: NULL, never zero
  }
}

// ── coverage fraction + the departure delta ─────────────────────────────────

/** Fraction of the window's days on which at least one live collector ran. */
export function coverageFraction(db: DB, from: number, to: number): number | null {
  const days = Math.max(1, Math.ceil((to - from) / 86_400_000));
  const ran = (db.prepare(
    `SELECT COUNT(DISTINCT CAST(started_at / 86400000 AS INTEGER)) AS d
     FROM collector_runs WHERE started_at >= ? AND started_at < ?`,
  ).get(from, to) as { d: number }).d;
  return ran / days;
}

export interface DeltaMetric {
  metric: string;
  after_window: number | null;
  baseline_median: number | null;
  /** Both windows' coverage fractions, printed beside every pair of figures. */
  after_coverage: number | null;
  baseline_coverage: number | null;
  note: string;
}

export type DeltaResult =
  | { refused: string }
  | { metrics: DeltaMetric[]; after_coverage: number | null; baseline_coverage: number | null };

/**
 * The departure delta, purpose-gated: only inside the pack, only for a
 * principal whose declared state is departing or departed, comparing the
 * last N days against that same principal's prior 90-day median in
 * exposure-relevant counts alone. No composite score, no cross-person
 * ranking, no output or productivity axis — and the table refuses to render
 * when either window's coverage fraction is below the floor. A change in
 * counts is not intent; a quiet baseline can mean the collector was off.
 */
export function departureDelta(
  db: DB,
  principalKey: string,
  windowEnd: number,
  opts: { windowDays?: number; floor?: number } = {},
): DeltaResult {
  const days = opts.windowDays ?? 30;
  // ponytail: floor 0.7 default; the pack's policy block (departure.coverage_floor) overrides.
  const floor = opts.floor ?? 0.7;
  const st = stateAt(db, principalKey, windowEnd);
  if (!st || (st.state !== 'departing' && st.state !== 'departed')) {
    return { refused: 'the delta is purpose-gated: it renders only for a principal whose declared state is departing or departed' };
  }
  const afterStart = windowEnd - days * 86_400_000;
  const baseStart = afterStart - 90 * 86_400_000;
  const afterCov = coverageFraction(db, afterStart, windowEnd);
  const baseCov = coverageFraction(db, baseStart, afterStart);
  if ((afterCov !== null && afterCov < floor) || (baseCov !== null && baseCov < floor)) {
    return { refused: `coverage below the pack's floor (${floor}): after=${afterCov ?? 'unknown'}, baseline=${baseCov ?? 'unknown'} — a quiet window is not a quiet person` };
  }
  const count = (sql: string, params: Record<string, unknown>): number =>
    (db.prepare(sql).get(params) as { n: number }).n;
  const median = (nums: number[]): number | null => {
    if (nums.length === 0) return null;
    const s = [...nums].sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) / 2)]!;
  };
  // Per-day counts for the median: 90 days, exposure-relevant metrics only.
  const subject = SUBJECT_ROWS;
  const metricDefs: { metric: string; note: string; after: number; baseline: number | null }[] = [];
  // node:sqlite rejects object keys the statement does not bind: exact params only.
  const perDay = (sql: string): number[] => {
    const out: number[] = [];
    for (let d = 0; d < 90; d++) {
      const from = baseStart + d * 86_400_000;
      out.push(count(sql, { a: from, b: from + 86_400_000 }));
    }
    return out;
  };
  // Secret sightings and surfaces are device-scoped ledgers (no session column):
  // counted within the windows and labelled as such, never silently attributed.
  metricDefs.push({
    metric: 'secret_sightings (device-wide, by first_seen in window)',
    note: 'attribution to the person is not possible from this ledger',
    after: count(`SELECT COUNT(*) AS n FROM secret_sightings WHERE first_seen >= :a AND first_seen < :b`, { a: afterStart, b: windowEnd }),
    baseline: median(perDay(`SELECT COUNT(*) AS n FROM secret_sightings WHERE first_seen >= :a AND first_seen < :b`)),
  });
  metricDefs.push({
    metric: 'off-device pushes (context_edges off_device)',
    note: 'context_edges rows joined to the principal through tool_calls.session_id',
    after: count(
      `SELECT COUNT(*) AS n FROM context_edges ce
       WHERE ce.direction = 'off_device' AND ce.ts >= :a AND ce.ts < :b
         AND ce.call_key IN (SELECT tool_call_key FROM tool_calls tc
           WHERE tc.session_id IN (SELECT session_id FROM session_identity WHERE principal_key = :pk))`,
      { pk: principalKey, a: afterStart, b: windowEnd },
    ),
    baseline: null, // the 90-day median needs the same join per day; NULL, never guessed
  });
  metricDefs.push({
    metric: 'repositories first touched in window',
    note: 'usage_events projects whose first occurrence falls inside the window',
    after: count(
      `SELECT COUNT(*) AS n FROM (
         SELECT project FROM usage_events WHERE ${subject} AND project IS NOT NULL AND ts < :b
         GROUP BY project HAVING MIN(ts) >= :a)`,
      { pk: principalKey, a: afterStart, b: windowEnd },
    ),
    baseline: null,
  });
  metricDefs.push({
    metric: 'package installs (package_execs in window)',
    note: 'package_execs joined through tool_calls sessions',
    after: count(
      `SELECT COUNT(*) AS n FROM package_execs pe WHERE pe.ts >= :a AND pe.ts < :b
       AND pe.call_key IN (SELECT tool_call_key FROM tool_calls tc
         WHERE tc.session_id IN (SELECT session_id FROM session_identity WHERE principal_key = :pk))`,
      { pk: principalKey, a: afterStart, b: windowEnd },
    ),
    baseline: null,
  });
  metricDefs.push({
    metric: 'unsanctioned surfaces first seen in window',
    note: 'ai_surfaces with sanctioned = 0 and first_seen in the window',
    after: count(
      `SELECT COUNT(*) AS n FROM ai_surfaces WHERE sanctioned = 0 AND first_seen >= :a AND first_seen < :b`,
      { a: afterStart, b: windowEnd },
    ),
    baseline: null,
  });
  return {
    metrics: metricDefs.map((m) => ({ ...m, after_window: m.after, baseline_median: m.baseline, after_coverage: afterCov, baseline_coverage: baseCov })),
    after_coverage: afterCov,
    baseline_coverage: baseCov,
  };
}

// ── the departure evidence pack ─────────────────────────────────────────────

export interface PackSection {
  section: string;
  rows_in_window: number;
  total_rows: number | null;
  note: string;
}

export interface DeparturePack {
  principal_key: string;
  window_start: number;
  window_end: number;
  basis: string;
  purpose: string;
  created_at: number;
  state_at_window_end: LifecycleStateAt | null;
  sections: PackSection[];
  /** Every figure's denominator lives in its section; this is the cross-cutting list. */
  not_covered: string[];
  freeze: FreezeResult | null;
  delta: DeltaResult | null;
  /** sha256 over the pack's own sections — the checkpoint head of what was emitted. */
  chain_head: string;
}

/**
 * `vole pack --principal <id> --window 30d --basis <text>`: the existing
 * incident-bundle and export machinery scoped to one principal and one
 * window, vole.db only, no new disk read. It proves what the agents recorded
 * while the collector ran, not what the human did — browser chat, phone,
 * personal laptop and any tool with no collector are absent by construction
 * and are named in not_covered. A window whose source was pruned reads
 * 'source deleted', never 'no activity'.
 */
export function buildDeparturePack(
  db: DB,
  opts: {
    principalKey: string;
    windowDays?: number;
    basis: string;
    freeze?: boolean;
    delta?: boolean;
    now?: number;
  },
): DeparturePack {
  const now = opts.now ?? Date.now();
  const days = opts.windowDays ?? 30;
  const start = now - days * 86_400_000;
  const pk = opts.principalKey;
  const subject = SUBJECT_ROWS;
  // node:sqlite rejects object keys the statement does not bind, so params are
  // exact per query — no throwaway keys.
  const n = (sql: string, params: Record<string, unknown>): number =>
    (db.prepare(sql).get(params) as { n: number }).n;
  const sections: PackSection[] = [
    {
      section: 'usage_events',
      rows_in_window: n(`SELECT COUNT(*) AS n FROM usage_events WHERE ${subject} AND ts >= :a AND ts < :b`, { pk, a: start, b: now }),
      total_rows: n(`SELECT COUNT(*) AS n FROM usage_events WHERE ${subject}`, { pk }),
      note: 'rows attributed to the principal via subject_id or a bound session',
    },
    {
      section: 'tool_calls',
      rows_in_window: n(
        `SELECT COUNT(*) AS n FROM tool_calls WHERE session_id IN
           (SELECT session_id FROM session_identity WHERE principal_key = :pk) AND ts >= :a AND ts < :b`,
        { pk, a: start, b: now },
      ),
      total_rows: n(
        `SELECT COUNT(*) AS n FROM tool_calls WHERE session_id IN
           (SELECT session_id FROM session_identity WHERE principal_key = :pk)`,
        { pk },
      ),
      note: 'the behaviour ledger, same sessions',
    },
    {
      section: 'grants',
      rows_in_window: n(`SELECT COUNT(*) AS n FROM grants WHERE last_seen >= :a AND last_seen < :b`, { a: start, b: now }),
      total_rows: n(`SELECT COUNT(*) AS n FROM grants`, {}),
      note: 'config declarations on this device — device-scoped, not person-scoped',
    },
    {
      section: 'anomalies',
      rows_in_window: n(
        `SELECT COUNT(*) AS n FROM anomalies WHERE source='live' AND session_id IN
           (SELECT session_id FROM session_identity WHERE principal_key = :pk) AND window_end >= :a AND window_end < :b`,
        { pk, a: start, b: now },
      ),
      total_rows: null,
      note: 'incidents over the principal\'s sessions',
    },
    {
      section: 'collector_runs',
      rows_in_window: n(`SELECT COUNT(*) AS n FROM collector_runs WHERE started_at >= :a AND started_at < :b`, { a: start, b: now }),
      total_rows: null,
      note: 'the denominator: which collectors actually ran in the window',
    },
  ];
  const pack: DeparturePack = {
    principal_key: pk,
    window_start: start,
    window_end: now,
    basis: opts.basis,
    purpose: 'departure evidence — security incident purpose only',
    created_at: now,
    state_at_window_end: stateAt(db, pk, now),
    sections,
    not_covered: [
      'browser chat, phone and any personal laptop — no collector exists by construction',
      'any AI tool Vole has no collector for (absent, not zero — see the coverage screen)',
      'what the human did rather than what the agents recorded',
      'windows whose source was pruned read "source deleted", never "no activity"',
    ],
    freeze: opts.freeze ? freezeEvidence(db, pk, start, now) : null,
    delta: opts.delta ? departureDelta(db, pk, now) : null,
    chain_head: '',
  };
  pack.chain_head = `sha256:${createHash('sha256')
    .update(JSON.stringify({ s: pack.sections, f: pack.freeze, d: pack.delta === null ? null : 'rendered', p: pk }))
    .digest('hex').slice(0, 24)}`;
  return pack;
}

// ── scope-change diff for movers ────────────────────────────────────────────

export interface ScopeDiffRow {
  principal_key: string;
  effective_from: number;
  dimension: string;
  value: string;
  before_window: [number, number] | null;
  after_window: [number, number] | null;
  state: 'kept' | 'added' | 'removed' | 'residual';
  /** The exact file and entry that grants it, where one exists. */
  evidence: string | null;
}

/**
 * A 'scope_changed' declaration with an effective_from triggers a diff
 * computed from ledgers already in the store, never from a policy statement:
 * projects and repositories touched, MCP endpoint identities registered,
 * grant/override entries with the file that granted each authority, remote-
 * execution destinations, secret-store retrievals, and each surface's
 * sanctioned state. Reachability here is what local configs and past actions
 * show — 'residual' is a floor and never the full entitlement set; a
 * permission granted server-side and never exercised locally is invisible.
 */
export function scopeDiff(
  db: DB,
  principalKey: string,
  effectiveFrom: number,
  opts: { beforeDays?: number; now?: number } = {},
): ScopeDiffRow[] {
  const now = opts.now ?? Date.now();
  const beforeDays = opts.beforeDays ?? 90;
  const before: [number, number] = [effectiveFrom - beforeDays * 86_400_000, effectiveFrom];
  const after: [number, number] = [effectiveFrom, now];
  const out: ScopeDiffRow[] = [];
  const sessions = `SELECT session_id FROM session_identity WHERE principal_key = ?`;

  const inWindow = (sql: string, w: [number, number]): Set<string> =>
    new Set(
      (db.prepare(sql).all(principalKey, w[0], w[1]) as { v: string }[]).map((r) => r.v),
    );

  // Projects and repositories touched.
  const projects = (w: [number, number]) =>
    inWindow(
      `SELECT DISTINCT project AS v FROM usage_events WHERE project IS NOT NULL AND session_id IN (${sessions}) AND ts >= ?2 AND ts < ?3`,
      w,
    );
  diffSets(out, principalKey, effectiveFrom, 'project', projects(before), projects(after), before, after, (v) => null);

  // MCP endpoint identities registered (the grants ledger's mcp kind names the file).
  // Before = declared before the move; after = still declared at its end (last_seen >= w[0]).
  const mcp = (w: [number, number]) =>
    new Set(
      (db.prepare(
        `SELECT grant_key AS v, source_file AS f FROM grants WHERE kind = 'mcp' AND first_seen < ?`,
      ).all(w[1]) as { v: string; f: string }[]).map((r) => `${r.v}|${r.f}`),
    );
  diffSets(out, principalKey, effectiveFrom, 'mcp_endpoint', mcp(before), mcp(after), before, after, (v) => v.split('|')[1] ?? null);

  // Grant/override entries with the file that granted each authority. Before =
  // declared before the move (first_seen); after = still in force after it
  // (last_seen). Carried across the move reads 'residual' — authority that
  // persisted through a scope change and was not rescoped away.
  const grantsBefore = new Set(
    (db.prepare(`SELECT grant_key AS v, source_file AS f FROM grants WHERE first_seen < ?`)
      .all(effectiveFrom) as { v: string; f: string }[]).map((r) => `${r.v}|${r.f}`),
  );
  const grantsAfter = new Set(
    (db.prepare(`SELECT grant_key AS v, source_file AS f FROM grants WHERE last_seen >= ?`)
      .all(effectiveFrom) as { v: string; f: string }[]).map((r) => `${r.v}|${r.f}`),
  );
  diffSets(out, principalKey, effectiveFrom, 'grant', grantsBefore, grantsAfter, before, after, (v) => v.split('|')[1] ?? null, 'residual');

  // Remote-execution destinations from the ledger.
  const remote = (w: [number, number]) =>
    inWindow(
      `SELECT DISTINCT re.host AS v FROM remote_exec re WHERE re.ts >= ?2 AND re.ts < ?3
       AND re.call_key IN (SELECT tool_call_key FROM tool_calls tc WHERE tc.session_id IN (${sessions}))`,
      w,
    );
  diffSets(out, principalKey, effectiveFrom, 'remote_exec_destination', remote(before), remote(after), before, after, () => null);

  // Secret-store retrievals.
  const vault = (w: [number, number]) =>
    inWindow(
      `SELECT DISTINCT ssr.item_name AS v FROM secret_store_reads ssr WHERE ssr.ts >= ?2 AND ssr.ts < ?3
       AND ssr.call_key IN (SELECT tool_call_key FROM tool_calls tc WHERE tc.session_id IN (${sessions}))`,
      w,
    );
  diffSets(out, principalKey, effectiveFrom, 'secret_store_item', vault(before), vault(after), before, after, () => null);

  // Each surface's sanctioned state — declared by policy, read from the scan.
  const surfaces = db.prepare(`SELECT surface_key, sanctioned FROM ai_surfaces`).all() as { surface_key: string; sanctioned: number | null }[];
  for (const s of surfaces) {
    out.push({
      principal_key: principalKey,
      effective_from: effectiveFrom,
      dimension: 'surface_sanctioned',
      value: s.surface_key,
      before_window: null,
      after_window: null,
      state: s.sanctioned === 0 ? 'residual' : 'kept',
      evidence: 'ai_surfaces.sanctioned (policy join at scan time)',
    });
  }
  return out;
}

function diffSets(
  out: ScopeDiffRow[],
  pk: string,
  from: number,
  dimension: string,
  before: Set<string>,
  after: Set<string>,
  bw: [number, number] | null,
  aw: [number, number] | null,
  evidenceOf: (v: string) => string | null,
  /** Grants carried across the move read 'residual', not 'kept': authority that persisted. */
  keptState: 'kept' | 'residual' = 'kept',
): void {
  for (const v of before) {
    const raw = v.includes('|') ? v.split('|')[0]! : v;
    if (after.has(v)) {
      out.push({ principal_key: pk, effective_from: from, dimension, value: raw, before_window: bw, after_window: aw, state: keptState, evidence: evidenceOf(v) });
    } else {
      // Removed from observation, but authority may still be declared: residual.
      const stillDeclared = dimension === 'grant' || dimension === 'mcp_endpoint';
      out.push({
        principal_key: pk, effective_from: from, dimension, value: raw,
        before_window: bw, after_window: aw,
        state: stillDeclared ? 'residual' : 'removed',
        evidence: evidenceOf(v),
      });
    }
  }
  for (const v of after) {
    if (before.has(v)) continue;
    const raw = v.includes('|') ? v.split('|')[0]! : v;
    out.push({ principal_key: pk, effective_from: from, dimension, value: raw, before_window: null, after_window: aw, state: 'added', evidence: evidenceOf(v) });
  }
}
