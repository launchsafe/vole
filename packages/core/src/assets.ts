import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DB } from '../db';
import type { Anomaly, Severity } from '../types';
import { paths } from './paths';
import { originSlug } from './repos/roots';
import { globToRegex, hostOf, isPlaceholderTarget, nearMatchHost, portOf, sha256hex } from './repos/util';

/**
 * assets.json: the admin-authored register (tier 6 §23), loaded only from
 * paths.assetsPolicyPaths() through the content_packs registry as kind
 * 'assets' in the admin-authored trust class — never vendor-signed, never
 * inferred from evidence. The register is a declaration, not evidence: an
 * absent file means 'no register loaded', never 'nothing here is critical'.
 */

export type AssetKind = 'repo' | 'path' | 'domain' | 'dsn' | 'store' | 'class';

export const ASSET_KINDS: AssetKind[] = ['repo', 'path', 'domain', 'dsn', 'store', 'class'];

export interface AssetEntry {
  asset_id: string;
  tier: number; // 1..5, the spec's numbering — INTEGER everywhere
  kind: AssetKind;
  match: string;
  owner?: string;
  /** one-line admin sentence quoted verbatim in every incident citing the asset */
  basis?: string;
}

export interface RejectedEntry {
  index: number;
  asset_id: string | null;
  reason: string;
}

export interface AssetRegister {
  version: number;
  checksum: string;
  entries: AssetEntry[];
  rejected: RejectedEntry[];
  sourceFile: string | null;
}

const HMAC_SHAPE = /^[0-9a-f]{64}$/;

/**
 * Load and validate the register. Refusal rules (the "two entry kinds it
 * refuses to load" from §23, plus malformed shapes):
 *  - kind 'literal' as a top-level kind: values never live in the register;
 *  - class entries carrying a plain `literal` that is not a 64-hex salted
 *    HMAC (entropy-floor / live-value rejection);
 *  - unknown kind, tier outside 1..5, empty match, dsn without a port.
 */
export function loadAssetRegister(text: string, sourceFile: string | null = null): AssetRegister {
  let doc: { version?: unknown; entries?: unknown } | null = null;
  try {
    doc = JSON.parse(text) as { version?: unknown; entries?: unknown };
  } catch {
    return { version: 0, checksum: sha256hex(text), entries: [], rejected: [{ index: 0, asset_id: null, reason: 'register is not valid JSON' }], sourceFile };
  }
  const rawEntries = Array.isArray(doc?.entries) ? (doc!.entries as Record<string, unknown>[]) : [];
  const entries: AssetEntry[] = [];
  const rejected: RejectedEntry[] = [];
  rawEntries.forEach((raw, i) => {
    const id = typeof raw.asset_id === 'string' ? raw.asset_id : null;
    const kind = typeof raw.kind === 'string' ? raw.kind : null;
    const match = typeof raw.match === 'string' ? raw.match : null;
    const tier = typeof raw.tier === 'number' ? raw.tier : null;
    const refuse = (reason: string): void => {
      rejected.push({ index: i, asset_id: id, reason });
    };
    if (kind === 'literal') {
      refuse(`kind 'literal' refused: values never live in the register — supply an HMAC-SHA256 under the pack salt inside a 'class' entry`);
      return;
    }
    if (kind === 'class') {
      // class entries may carry {regex, validator, tables, filename_shape, literal}
      const m = typeof raw.match === 'object' && raw.match !== null ? (raw.match as Record<string, unknown>) : null;
      if (m && typeof m.literal === 'string' && !HMAC_SHAPE.test(m.literal)) {
        refuse(`class entry literal is not a 64-hex salted HMAC — a live value in the register file is refused (entropy floor)`);
        return;
      }
    }
    if (!kind || !ASSET_KINDS.includes(kind as AssetKind)) {
      refuse(`unknown kind ${JSON.stringify(kind)}`);
      return;
    }
    if (tier === null || !Number.isInteger(tier) || tier < 1 || tier > 5) {
      refuse(`tier must be an integer 1..5 (the spec's numbering), got ${JSON.stringify(raw.tier)}`);
      return;
    }
    const matchOk = typeof match === 'string' ? match.length > 0 : kind === 'class' && typeof raw.match === 'object' && raw.match !== null;
    if (!matchOk) {
      refuse('match must be a non-empty string (a structured object only for class entries)');
      return;
    }
    if (kind === 'dsn' && portOf(match) === null) {
      refuse(`dsn match "${match}" carries no port — a dsn entry is host+port so a host suffix cannot masquerade as an exact DSN`);
      return;
    }
    entries.push({
      asset_id: id ?? `entry-${i}`,
      tier,
      kind: kind as AssetKind,
      match: typeof match === 'string' ? match : JSON.stringify(match),
      owner: typeof raw.owner === 'string' ? raw.owner : undefined,
      basis: typeof raw.basis === 'string' ? raw.basis : undefined,
    });
  });
  const version = typeof doc?.version === 'number' ? doc.version : 1;
  return { version, checksum: sha256hex(text), entries, rejected, sourceFile };
}

/** Read the register from the policy paths (managed root wins over per-user). */
export function readAssetRegister(): AssetRegister {
  for (const file of paths.assetsPolicyPaths()) {
    try {
      return loadAssetRegister(readFileSync(file, 'utf8'), file);
    } catch {
      /* try the next path */
    }
  }
  return { version: 0, checksum: '', entries: [], rejected: [], sourceFile: null };
}

/** Register the pack load in content_packs (kind 'assets', idempotent). */
export function registerAssetPack(db: DB, register: AssetRegister, now: number): void {
  if (!register.sourceFile || register.entries.length === 0) return;
  db.prepare(
    `INSERT INTO content_packs (kind, version, checksum, loaded_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(kind, version) DO NOTHING`,
  ).run('assets', register.version, register.checksum, now);
}

// ── the resolver (chain order decides collisions) ────────────────────────────

export interface AssetTarget {
  kind: 'repo' | 'domain' | 'dsn' | 'path' | 'store' | 'host';
  value: string;
}

export interface ResolvedAsset {
  entry: AssetEntry;
  matchedBy: AssetKind | 'store' | 'path';
}

/** Resolution chain: repo -> dsn -> domain -> store -> path. First hit wins. */
export function resolveAsset(register: AssetRegister, target: AssetTarget): ResolvedAsset | null {
  const chain: AssetKind[] = ['repo', 'dsn', 'domain', 'store', 'path'];
  for (const kind of chain) {
    for (const e of register.entries) {
      if (e.kind !== kind) continue;
      if (matchesEntry(kind, e.match, target)) return { entry: e, matchedBy: kind };
    }
  }
  return null;
}

function matchesEntry(kind: AssetKind, match: string, target: AssetTarget): boolean {
  const v = target.value.toLowerCase();
  switch (kind) {
    case 'repo': {
      if (target.kind !== 'repo') return false;
      const slug = originSlug(target.value) ?? v;
      const m = match.toLowerCase().replace(/\/+$/, '');
      if (m.endsWith('/*')) return slug.startsWith(m.slice(0, -1)); // github.com/org/* prefix
      return slug === m.replace(/\.git$/, '');
    }
    case 'dsn': {
      if (target.kind !== 'dsn' && target.kind !== 'domain' && target.kind !== 'host') return false;
      const host = hostOf(target.value);
      const port = portOf(target.value);
      const [mh, mp] = [hostOf(match), portOf(match)];
      return host === mh && (mp === null || port === null || port === mp || target.kind === 'dsn');
    }
    case 'domain': {
      if (target.kind !== 'domain' && target.kind !== 'dsn' && target.kind !== 'host') return false;
      const host = hostOf(target.value);
      const m = match.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      return host === m || host.endsWith(`.${m}`);
    }
    case 'store':
    case 'path': {
      if (target.kind !== 'path' && target.kind !== 'store') return false;
      if (kind === 'store') return v === match || v.startsWith(match.endsWith('/') ? match : `${match}/`);
      return globToRegex(match).test(target.value);
    }
    case 'class':
      return false; // class entries resolve sightings, not targets
  }
}

// ── criticality as the second severity input (§24) ──────────────────────────

const SEV_ORDER: Severity[] = ['info', 'warn', 'critical'];

/**
 * f(posture, asset_tier): a tier-1/2 target escalates exactly ONE step above
 * the posture-weighted level; an unresolved target never de-escalates. A
 * declared step, never a computed risk score — the product stays out of
 * Annex III 4(b) scoring territory by construction.
 */
export function severityWithAsset(postureSeverity: Severity, tier: number | null): Severity {
  if (tier === null || tier > 2) return postureSeverity;
  const i = SEV_ORDER.indexOf(postureSeverity);
  return SEV_ORDER[Math.min(i + 1, SEV_ORDER.length - 1)]!;
}

export interface SeverityInputs {
  severity: Severity;
  posture: string;
  tier: number | null;
  entry?: AssetEntry | null;
  registerVersion?: number;
}

/** The severity_inputs template (§24): 'critical: bypass posture + tier 1 (assets.json v7, entry prod-db: "...")'. */
export function severityInputsText(inputs: SeverityInputs): string {
  const head = `${inputs.severity}: ${inputs.posture}`;
  if (inputs.tier === null) {
    return `${head} + target not in the register (never 'low value')`;
  }
  if (!inputs.entry) {
    return `${head} + tier ${inputs.tier}`;
  }
  return `${head} + tier ${inputs.tier} (assets.json v${inputs.registerVersion ?? '?'}${inputs.entry.asset_id ? `, entry ${inputs.entry.asset_id}` : ''}${inputs.entry.basis ? `: "${inputs.entry.basis}"` : ''})`;
}

/** Stamp asset columns + escalated severity on a stored anomaly (NULL-safe updates). */
export function stampAnomalyAsset(db: DB, anomalyKey: string, entry: AssetEntry, registerVersion: number, postureSeverity: Severity): void {
  const escalated = severityWithAsset(postureSeverity, entry.tier);
  db.prepare(
    `UPDATE anomalies SET asset_id = :assetId, asset_tier = :tier, asset_rev = :rev,
       severity = CASE WHEN :rank > CASE severity WHEN 'critical' THEN 2 WHEN 'warn' THEN 1 ELSE 0 END THEN :sev ELSE severity END
     WHERE anomaly_key = :key AND asset_id IS NULL`,
  ).run({
    assetId: entry.asset_id,
    tier: entry.tier,
    rev: registerVersion,
    sev: escalated,
    rank: SEV_ORDER.indexOf(escalated),
    key: anomalyKey,
  });
}

// ── crown-jewel-scoped rule variants (§9) ────────────────────────────────────

function baseAnomaly(now: number): Omit<Anomaly, 'anomaly_key' | 'rule' | 'severity' | 'title' | 'detail'> {
  return {
    tool: 'claude_code', session_id: null, model: null,
    window_start: now, window_end: now,
    observed: 1, baseline: null, threshold: null,
    confidence: 'exact', source: 'live', detected_at: now,
  };
}

/** crown_jewel_read_unasked: a sensitive sighting whose path resolves to a tier<=2 asset. */
export function detectCrownJewelRead(db: DB, now: number, register: AssetRegister): Anomaly[] {
  if (register.entries.length === 0) return [];
  const rows = db
    .prepare(`SELECT id, path FROM secret_sightings ORDER BY id LIMIT 500`)
    .all() as { id: number; path: string }[];
  const out: Anomaly[] = [];
  for (const r of rows) {
    const hit = resolveAsset(register, { kind: 'path', value: r.path }) ?? resolveAsset(register, { kind: 'store', value: r.path });
    if (!hit || hit.entry.tier > 2) continue;
    out.push({
      ...baseAnomaly(now),
      anomaly_key: `crown_jewel_read_unasked:${sha256hex(`${r.id}|${hit.entry.asset_id}`)}`,
      rule: 'crown_jewel_read_unasked',
      severity: 'critical',
      title: `Crown-jewel target: sensitive sighting at tier ${hit.entry.tier}`,
      detail:
        `A secret sighting sits under a tier-${hit.entry.tier} asset (${hit.entry.asset_id}, matched by ${hit.matchedBy}: ` +
        `"${hit.entry.match}"). Parent rule: sensitive_read_unasked escalated only on the tiered target — no threshold ` +
        `was retuned. ${hit.entry.basis ? `Register basis: "${hit.entry.basis}".` : ''}`,
    });
  }
  return out;
}

/** crown_jewel_egress: a sighting with an egress direction whose sink path is tier<=2. */
export function detectCrownJewelEgress(db: DB, now: number, register: AssetRegister): Anomaly[] {
  if (register.entries.length === 0) return [];
  const rows = db
    .prepare(`SELECT id, path, direction FROM secret_sightings WHERE direction IS NOT NULL AND direction != 'at_rest' ORDER BY id LIMIT 500`)
    .all() as { id: number; path: string; direction: string }[];
  const out: Anomaly[] = [];
  for (const r of rows) {
    const hit = resolveAsset(register, { kind: 'path', value: r.path }) ?? resolveAsset(register, { kind: 'store', value: r.path });
    if (!hit || hit.entry.tier > 2) continue;
    out.push({
      ...baseAnomaly(now),
      anomaly_key: `crown_jewel_egress:${sha256hex(`${r.id}|${hit.entry.asset_id}`)}`,
      rule: 'crown_jewel_egress',
      severity: 'critical',
      title: `Crown-jewel egress: secret left via tier-${hit.entry.tier} path`,
      detail:
        `A secret sighting carries direction '${r.direction}' under tier-${hit.entry.tier} asset ${hit.entry.asset_id} ` +
        `(matched by ${hit.matchedBy}: "${hit.entry.match}") — the class x tier crossed the register's declared line. ` +
        `${hit.entry.basis ? `Register basis: "${hit.entry.basis}".` : ''}`,
    });
  }
  return out;
}

/** tier1_remote_write: a remote database write against a declared production DSN. */
export function detectTier1RemoteWrite(db: DB, now: number, register: AssetRegister): Anomaly[] {
  if (register.entries.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT DISTINCT call_key, target_kind, target_label, first_seen AS ts FROM action_targets
       WHERE (target_kind LIKE '%database%' OR target_kind LIKE '%remote%') AND target_label IS NOT NULL
       ORDER BY ts DESC LIMIT 500`,
    )
    .all() as { call_key: string; target_kind: string; target_label: string; ts: number | null }[];
  const out: Anomaly[] = [];
  for (const r of rows) {
    // Shape near-misses are the failure mode: a DSN-looking label that
    // resolves to no declared entry does NOT fire.
    if (isPlaceholderTarget(r.target_label)) continue;
    const hit = resolveAsset(register, { kind: 'dsn', value: r.target_label }) ?? resolveAsset(register, { kind: 'domain', value: r.target_label });
    if (!hit || hit.entry.tier > 2) continue;
    out.push({
      ...baseAnomaly(now),
      anomaly_key: `tier1_remote_write:${sha256hex(`${r.call_key}|${hit.entry.asset_id}`)}`,
      rule: 'tier1_remote_write',
      severity: 'critical',
      title: `Remote write against declared production DSN (${hit.entry.asset_id})`,
      detail:
        `A ${r.target_kind} targeted ${hit.entry.match} — a declared tier-${hit.entry.tier} production DSN ` +
        `(matched by ${hit.matchedBy}). ${hit.entry.basis ? `Register basis: "${hit.entry.basis}".` : ''} ` +
        `Hostnames that merely look like a production DSN but resolve to no entry stay on the parent rule.`,
      window_start: r.ts ?? now,
      window_end: r.ts ?? now,
    });
  }
  return out;
}

/** crown_jewel_left_device: a context edge off-device carrying a tier-1 target. */
export function detectCrownJewelLeftDevice(db: DB, now: number, register: AssetRegister): Anomaly[] {
  if (register.entries.length === 0) return [];
  const rows = db
    .prepare(`SELECT call_key, destination, direction, ts FROM context_edges WHERE destination IS NOT NULL ORDER BY ts DESC LIMIT 500`)
    .all() as { call_key: string; destination: string; direction: string | null; ts: number | null }[];
  const out: Anomaly[] = [];
  for (const r of rows) {
    const host = hostOf(r.destination);
    if (!host || /^(localhost|127\.|::1|0\.0\.0\.0)/.test(host)) continue; // on-device
    const hit = resolveAsset(register, { kind: 'domain', value: r.destination }) ?? resolveAsset(register, { kind: 'dsn', value: r.destination });
    if (!hit || hit.entry.tier !== 1) continue;
    out.push({
      ...baseAnomaly(now),
      anomaly_key: `crown_jewel_left_device:${sha256hex(`${r.call_key}|${hit.entry.asset_id}`)}`,
      rule: 'crown_jewel_left_device',
      severity: 'critical',
      title: `Tier-1 target left the device: ${host}`,
      detail:
        `A context edge carried data off-device to ${host}, a declared tier-1 asset (${hit.entry.asset_id}, matched ` +
        `by ${hit.matchedBy}: "${hit.entry.match}")${r.direction ? `, direction '${r.direction}'` : ''}. ` +
        `${hit.entry.basis ? `Register basis: "${hit.entry.basis}".` : ''}`,
      window_start: r.ts ?? now,
      window_end: r.ts ?? now,
    });
  }
  return out;
}

/** All four variants at once. */
export function detectCrownJewelVariants(db: DB, now: number, register: AssetRegister): Anomaly[] {
  return [
    ...detectCrownJewelRead(db, now, register),
    ...detectCrownJewelEgress(db, now, register),
    ...detectTier1RemoteWrite(db, now, register),
    ...detectCrownJewelLeftDevice(db, now, register),
  ];
}

// ── register coverage on every asset-scoped figure (§17) ────────────────────

export interface LedgerCoverage {
  ledger: string;
  eligible: number;
  resolved: number;
  unresolved: number;
  noTarget: number;
  coveragePct: number | null;
  /** the denominator's definition, printed next to the number */
  denominator: string;
}

export interface AssetCoverage {
  absent: boolean;
  ledgers: LedgerCoverage[];
  /** 'No asset register loaded — every severity is posture-only' when absent */
  sentence: string;
  /** ranked by row count — the unresolved worklist (copy-as-entry emits a candidate line) */
  unresolvedTargets: { value: string; ledger: string; rows: number }[];
}

const COVERAGE_LEDGERS: { ledger: string; sql: string; target: (v: string) => AssetTarget; denominator: string }[] = [
  {
    ledger: 'file_writes',
    sql: `SELECT path AS v, COUNT(*) AS n FROM file_writes WHERE path IS NOT NULL GROUP BY path`,
    target: (v) => ({ kind: 'path', value: v }),
    denominator: 'distinct write paths (writes only — reads have no target here)',
  },
  {
    ledger: 'secret_sightings',
    sql: `SELECT path AS v, COUNT(*) AS n FROM secret_sightings GROUP BY path`,
    target: (v) => ({ kind: 'store', value: v }),
    denominator: 'distinct sighting sink paths',
  },
  {
    ledger: 'action_targets',
    sql: `SELECT target_label AS v, COUNT(*) AS n FROM action_targets WHERE target_label IS NOT NULL GROUP BY target_label`,
    target: (v) => ({ kind: 'dsn', value: v }),
    denominator: 'remote-action rows with a resolved label',
  },
  {
    ledger: 'context_edges',
    sql: `SELECT destination AS v, COUNT(*) AS n FROM context_edges WHERE destination IS NOT NULL GROUP BY destination`,
    target: (v) => ({ kind: 'domain', value: v }),
    denominator: 'egress destinations (public documentation hosts included)',
  },
];

/**
 * Coverage per ledger over the ELIGIBLE denominator (write, egress,
 * secret-sighting and remote-action rows), definition printed beside it.
 * A perfect 100% can still mean the admin declared only what these agents
 * touched — the strip says so.
 */
export function assetCoverage(db: DB, register: AssetRegister): AssetCoverage {
  if (register.entries.length === 0) {
    return {
      absent: true,
      ledgers: [],
      sentence: 'No asset register loaded — every severity is posture-only',
      unresolvedTargets: [],
    };
  }
  const ledgers: LedgerCoverage[] = [];
  const unresolved = new Map<string, { value: string; ledger: string; rows: number }>();
  for (const def of COVERAGE_LEDGERS) {
    const rows = db.prepare(def.sql).all() as { v: string; n: number }[];
    let resolved = 0;
    let unresolvedRows = 0;
    for (const row of rows) {
      const hit = resolveAsset(register, def.target(row.v));
      if (hit) {
        resolved += row.n;
      } else {
        unresolvedRows += row.n;
        const key = `${def.ledger}|${row.v}`;
        const cur = unresolved.get(key);
        unresolved.set(key, { value: row.v, ledger: def.ledger, rows: (cur?.rows ?? 0) + row.n });
      }
    }
    const eligible = rows.reduce((n, r) => n + r.n, 0);
    const noTarget = (
      db.prepare(`SELECT COUNT(*) AS n FROM ${def.ledger === 'file_writes' ? 'file_writes WHERE path IS NULL' : def.ledger === 'secret_sightings' ? 'secret_sightings WHERE path IS NULL' : def.ledger === 'action_targets' ? 'action_targets WHERE target_label IS NULL' : 'context_edges WHERE destination IS NULL'}`).get() as { n: number }
    ).n;
    ledgers.push({
      ledger: def.ledger,
      eligible,
      resolved,
      unresolved: unresolvedRows,
      noTarget,
      coveragePct: eligible === 0 ? null : Math.round((resolved / eligible) * 100),
      denominator: def.denominator,
    });
  }
  const unresolvedTargets = [...unresolved.values()].sort((a, b) => b.rows - a.rows);
  return {
    absent: false,
    ledgers,
    sentence:
      `Coverage measures how much of what Vole saw resolves — not how much of the estate is declared. ` +
      `${unresolvedTargets.length} unresolved target(s) in the worklist; an unresolved target never de-escalates.`,
    unresolvedTargets,
  };
}

// ── preflight (§18) ──────────────────────────────────────────────────────────

export interface PreflightEntry {
  asset_id: string;
  kind: AssetKind;
  match: string;
  rowsResolved: number;
  dead: boolean;
  /** earlier entries claiming the same targets — chain order decides, this names the loser */
  collisions: string[];
  nearMatches: string[];
  /** how many already-stored incidents would escalate under content_rev if this pack shipped */
  severityDelta: number;
}

export interface PreflightReport {
  header: string;
  entries: PreflightEntry[];
  rejected: RejectedEntry[];
}

/**
 * Score a candidate register against this machine's retained evidence. A
 * worksheet, never a pass/fail gate — the header states that before the first
 * table, and an entry scoring zero here may be another team's crown jewel.
 */
export function preflightRegister(db: DB, candidate: AssetRegister): PreflightReport {
  const header =
    'This is a worksheet scored against ONE machine\'s retained evidence, itself bounded by the ' +
    'evidence-expiry horizon — an entry scoring zero here may be another team\'s crown jewel. Never a gate.';
  const targets: { target: AssetTarget; rows: number; sessions: Set<string> }[] = [];
  for (const def of COVERAGE_LEDGERS) {
    const rows = db.prepare(def.sql).all() as { v: string; n: number }[];
    for (const row of rows) targets.push({ target: def.target(row.v), rows: row.n, sessions: new Set() });
  }
  const sessionIds = (ledger: string, value: string): string[] => {
    try {
      const col = ledger === 'file_writes' ? 'path' : ledger === 'secret_sightings' ? 'path' : ledger === 'action_targets' ? 'target_label' : 'destination';
      const rows = db.prepare(`SELECT DISTINCT session_id FROM ${ledger} WHERE ${col} = ? AND session_id IS NOT NULL`).all(value) as { session_id: string }[];
      return rows.map((r) => r.session_id);
    } catch {
      return [];
    }
  };
  const entries: PreflightEntry[] = [];
  const claimed = new Map<string, string>(); // target value -> first asset_id
  for (const e of candidate.entries) {
    let rowsResolved = 0;
    const collisions: string[] = [];
    const nearMatches = new Set<string>();
    let severityDelta = 0;
    for (const t of targets) {
      const hit = resolveAsset({ ...candidate, entries: [e] }, t.target);
      if (!hit) {
        // near-match: observed host differs by a single label or is a placeholder
        if ((e.kind === 'domain' || e.kind === 'dsn') && (t.target.kind === 'domain' || t.target.kind === 'dsn')) {
          const observed = hostOf(t.target.value);
          const declared = hostOf(e.match);
          if (nearMatchHost(declared, observed)) nearMatches.add(t.target.value);
        }
        continue;
      }
      rowsResolved += t.rows;
      const first = claimed.get(t.target.value);
      if (first && first !== e.asset_id) collisions.push(first); // this entry LOSES the chain order
      else claimed.set(t.target.value, e.asset_id);
      if (e.tier <= 2) {
        for (const s of sessionIds(ledgerOf(t.target), t.target.value)) severityDelta += countIncidents(db, s);
      }
    }
    entries.push({
      asset_id: e.asset_id,
      kind: e.kind,
      match: e.match,
      rowsResolved,
      dead: rowsResolved === 0,
      collisions: [...new Set(collisions)],
      nearMatches: [...nearMatches],
      severityDelta,
    });
  }
  return { header, entries, rejected: candidate.rejected };
}

function ledgerOf(target: AssetTarget): string {
  return target.kind === 'path' ? 'file_writes' : target.kind === 'store' ? 'secret_sightings' : target.kind === 'dsn' ? 'action_targets' : 'context_edges';
}

function countIncidents(db: DB, sessionId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM anomalies WHERE session_id = ?`).get(sessionId) as { n: number }).n;
}

// ── proposals (§25): the desktop's only write is a proposal ─────────────────

export const proposedAssetPath = (): string => join(dirname(paths.assetsPolicyPaths()[paths.assetsPolicyPaths().length - 1]!), 'assets.proposed.json');

/** Write a candidate entry to assets.proposed.json — never the signed pack. */
export function proposeAsset(entry: AssetEntry): void {
  const file = proposedAssetPath();
  let doc: AssetEntry[] = [];
  try {
    doc = JSON.parse(readFileSync(file, 'utf8')) as AssetEntry[];
  } catch {
    /* absent or empty: start fresh */
  }
  doc.push(entry);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(doc, null, 2));
}

/** A candidate register line for the copy-as-entry button (§17). */
export function candidateEntryLine(value: string, ledger: string): string {
  const host = hostOf(value);
  if (host && host.includes('.')) return `{ "asset_id": "TODO", "tier": 1, "kind": "domain", "match": "${host}", "owner": "", "basis": "proposed from ${ledger} worklist" }`;
  return `{ "asset_id": "TODO", "tier": 1, "kind": "path", "match": "${value}", "owner": "", "basis": "proposed from ${ledger} worklist" }`;
}
