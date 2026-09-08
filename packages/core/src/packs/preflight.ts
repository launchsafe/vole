/**
 * Tier 6 §18 + §79: preflight — score a candidate pack against this
 * machine's retained evidence BEFORE the fleet gets it.
 *
 * Verifies the candidate's signature first (a candidate is refused unless
 * explicitly `allowUnsigned`, and then says so loudly), then dry-runs it over
 * the evidence this machine still holds. Writes NOTHING to the store; every
 * third-party file is read-only. The output is a worksheet, never a pass/fail
 * gate: it measures one laptop's evidence, itself bounded by the retention
 * window, and the sample size it actually saw is printed with it.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { DB } from '../db';
import { verifyDetached, trustAnchors, type PackManifest } from './registry';
import { preflightPricing } from './pricing-pack';
import { effectiveThresholds } from './policy';
import { DETECTORS } from '../dlp/pack';

export interface PreflightOpts {
  /** Refuse unsigned candidates unless this is explicitly set. */
  allowUnsigned?: boolean;
  /** Byte budget for the detector dry-run scan. Default 8 MiB. */
  budgetBytes?: number;
}

export interface PreflightEntryScore {
  id: string;
  hits: number;
  note?: string;
}

export interface PreflightReport {
  path: string;
  kind: string | null;
  version: number | null;
  verified: boolean;
  refusal: string | null;
  /** Sample basis, printed with every worksheet — a clean canary is not a clean fleet. */
  sample: string;
  dlp?: {
    files_scanned: number;
    files_gone: number;
    bytes_read: number;
    entries: PreflightEntryScore[];
    findings_added: number;
    findings_removed: number;
  };
  pricing?: ReturnType<typeof preflightPricing>;
  command_patterns?: { entries: PreflightEntryScore[]; total_tool_calls: number };
  assets?: {
    entries: { asset_id: string; tier: number | null; kind: string; match: string; rows_resolved: number; basis: string | null }[];
    dead: string[];
    collisions: { target: string; winner: string; loser: string }[];
    near_match: { observed: string; declared: string }[];
    severity_delta: number;
    invalid: { index: number; reason: string }[];
  };
  thresholds?: { changed: { rule: string; param: string; from: number; to: number; stored_anomalies: number }[] };
}

/**
 * Retained DLP evidence: the distinct files that produced sightings and are
 * still on disk. ponytail: this scores the sighting-bearing subset of the
 * sink set, not every sink file — widen to raw_ref joins when a foundation
 * column lands.
 */
function retainedDlpFiles(db: DB): { files: string[]; gone: number } {
  const rows = db.prepare('SELECT DISTINCT path FROM secret_sightings').all() as { path: string }[];
  const files: string[] = [];
  let gone = 0;
  for (const r of rows) {
    try {
      if (statSync(r.path).isFile()) files.push(r.path);
    } catch {
      gone++;
    }
  }
  return { files, gone };
}

interface CandidateDetector {
  id: string;
  pattern?: string;
  severity?: string;
}

function scoreDetectors(db: DB, candidate: PackManifest, opts: PreflightOpts): PreflightReport['dlp'] {
  const entries = (candidate.entries ?? []) as CandidateDetector[];
  const budget = opts.budgetBytes ?? 8 * 1024 * 1024;
  const { files, gone } = retainedDlpFiles(db);
  const compiled = entries
    .filter((e) => typeof e.pattern === 'string')
    .map((e) => ({ id: e.id, re: new RegExp(e.pattern as string, 'g') }));
  const hits = new Map<string, number>();
  let bytesRead = 0;
  for (const f of files) {
    if (bytesRead >= budget) break;
    let text: string;
    try {
      const buf = readFileSync(f);
      bytesRead += buf.length;
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    for (const c of compiled) {
      c.re.lastIndex = 0;
      hits.set(c.id, (hits.get(c.id) ?? 0) + (text.match(c.re)?.length ?? 0));
    }
  }
  const builtinIds = new Set(DETECTORS.map((d) => d.id));
  const candidateIds = new Set(entries.map((e) => e.id));
  const added = entries.filter((e) => !builtinIds.has(e.id)).reduce((n, e) => n + (hits.get(e.id) ?? 0), 0);
  const removed = (db.prepare('SELECT detector, COUNT(*) AS n FROM secret_sightings GROUP BY detector').all() as { detector: string; n: number }[])
    .filter((r) => !candidateIds.has(r.detector))
    .reduce((n, r) => n + r.n, 0);
  return {
    files_scanned: files.length,
    files_gone: gone,
    bytes_read: bytesRead,
    entries: entries.map((e) => ({ id: e.id, hits: hits.get(e.id) ?? 0 })),
    findings_added: added,
    findings_removed: removed,
  };
}

function labelDistance(a: string, b: string): number {
  const la = a.split('.');
  const lb = b.split('.');
  if (la.length !== lb.length) return Infinity;
  return la.filter((l, i) => l !== lb[i]).length;
}

function scoreAssets(db: DB, candidate: PackManifest): PreflightReport['assets'] {
  const validKinds = new Set(['repo', 'path', 'domain', 'dsn', 'store', 'class']);
  const entries = (candidate.entries ?? []) as { asset_id?: string; tier?: number; kind?: string; match?: string; owner?: string; basis?: string }[];
  const invalid: { index: number; reason: string }[] = [];
  entries.forEach((e, i) => {
    if (!e.asset_id) invalid.push({ index: i, reason: 'entry has no asset_id' });
    else if (!e.kind || !validKinds.has(e.kind)) invalid.push({ index: i, reason: `entry kind '${e.kind}' is not one of repo/path/domain/dsn/store/class` });
    else if (!e.match) invalid.push({ index: i, reason: 'entry has no match' });
  });
  const valid = entries.filter((e) => e.asset_id && e.match && e.kind && validKinds.has(e.kind));

  // Host-ish entries resolve against the two ledgers that name outside targets.
  const targets = (db
    .prepare("SELECT DISTINCT target_label FROM action_targets WHERE target_label IS NOT NULL")
    .all() as { target_label: string }[])
    .map((r) => r.target_label)
    .concat((db.prepare('SELECT DISTINCT destination FROM context_edges WHERE destination IS NOT NULL').all() as { destination: string }[]).map((r) => r.destination));
  // Chain order decides: the first valid entry matching a target wins it;
  // every later entry matching the same target is recorded as a collision.
  const winners = new Map<string, { entry: (typeof valid)[number]; order: number }>();
  valid.forEach((e, order) => {
    const isHost = e.kind === 'domain' || e.kind === 'dsn';
    for (const t of targets) {
      if (isHost ? t === e.match || t.endsWith(`.${e.match}`) : t.includes(String(e.match))) {
        const prev = winners.get(t);
        if (!prev || prev.order > order) winners.set(t, { entry: e, order });
      }
    }
  });

  // Rows resolved per entry: distinct targets won, each weighted by its stored row count.
  const qCount = db.prepare('SELECT COUNT(*) AS n FROM action_targets WHERE target_label = ?');
  const perEntry = new Map<string, number>();
  let severityDelta = 0;
  for (const [t, w] of winners) {
    const n = (qCount.get(t) as { n: number }).n;
    perEntry.set(w.entry.asset_id as string, (perEntry.get(w.entry.asset_id as string) ?? 0) + n);
    if (typeof w.entry.tier === 'number' && w.entry.tier <= 2) severityDelta += n;
  }

  const collisions: { target: string; winner: string; loser: string }[] = [];
  valid.forEach((e, order) => {
    const isHost = e.kind === 'domain' || e.kind === 'dsn';
    for (const t of targets) {
      if (winners.get(t)?.entry === e) continue;
      if (isHost ? t === e.match || t.endsWith(`.${e.match}`) : t.includes(String(e.match))) {
        collisions.push({ target: t, winner: (winners.get(t)?.entry.asset_id) ?? '?', loser: e.asset_id as string });
      }
    }
  });

  const nearMatch: { observed: string; declared: string }[] = [];
  const hostEntries = valid.filter((e) => e.kind === 'domain' || e.kind === 'dsn');
  for (const t of targets) {
    if (winners.has(t)) continue;
    for (const e of hostEntries) {
      if (e.match && labelDistance(t, e.match) === 1) {
        nearMatch.push({ observed: t, declared: e.match });
        break;
      }
    }
  }

  // Severity delta: how many stored action-target rows resolve to a tier<=2
  // entry — each of their incidents would escalate exactly one step.

  return {
    entries: valid.map((e) => ({
      asset_id: e.asset_id as string,
      tier: typeof e.tier === 'number' ? e.tier : null,
      kind: e.kind as string,
      match: e.match as string,
      rows_resolved: perEntry.get(e.asset_id as string) ?? 0,
      basis: e.basis ?? null,
    })),
    dead: valid
      .filter((e) => (perEntry.get(e.asset_id as string) ?? 0) === 0 && !collisions.some((c) => c.loser === e.asset_id))
      .map((e) => e.asset_id as string),
    collisions,
    near_match: nearMatch,
    severity_delta: severityDelta,
    invalid,
  };
}

/**
 * Runs the preflight for one candidate file. Read-only over the store.
 */
export function preflightPack(db: DB, path: string, opts: PreflightOpts = {}): PreflightReport {
  const report: PreflightReport = { path, kind: null, version: null, verified: false, refusal: null, sample: '' };
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    report.refusal = `unreadable candidate: ${(e as Error).message}`;
    return report;
  }
  const anchors = trustAnchors();
  const sigPath = `${path}.sig`;
  if (existsSync(sigPath)) {
    const sig = readFileSync(sigPath, 'utf8').trim();
    if ((anchors.vendor && verifyDetached(bytes, sig, anchors.vendor)) || (anchors.admin && verifyDetached(bytes, sig, anchors.admin))) {
      report.verified = true;
    } else {
      report.refusal = 'candidate signature invalid under every trust anchor — refusing to score';
      return report;
    }
  } else if (!opts.allowUnsigned) {
    report.refusal = 'unsigned candidate — refusing to score (pass --allow-unsigned to score anyway)';
    return report;
  }

  let m: PackManifest;
  try {
    m = JSON.parse(bytes.toString('utf8')) as PackManifest;
  } catch (e) {
    report.refusal = `malformed candidate JSON: ${(e as Error).message}`;
    return report;
  }
  report.kind = typeof m.kind === 'string' ? m.kind : null;
  report.version = typeof m.version === 'number' ? m.version : null;

  if (m.kind === 'dlp_detectors') {
    const d = scoreDetectors(db, m, opts)!;
    report.dlp = d;
    report.sample = `${d.files_scanned} retained sighting files (${d.bytes_read} bytes read, ${d.files_gone} gone) — one laptop's evidence, not the fleet's`;
  } else if (m.kind === 'pricing') {
    report.pricing = preflightPricing(db, m as unknown as { models?: Record<string, unknown> });
    report.sample = `${report.pricing.models_seen.length} distinct models observed in this store`;
  } else if (m.kind === 'command_patterns') {
    const entries = (m.entries ?? []) as { id?: string; pattern?: string }[];
    const shapes = db.prepare('SELECT DISTINCT shape FROM tool_calls WHERE shape IS NOT NULL').all() as { shape: string }[];
    const counts = db.prepare('SELECT shape, COUNT(*) AS n FROM tool_calls WHERE shape IS NOT NULL GROUP BY shape').all() as { shape: string; n: number }[];
    const byShape = new Map(counts.map((c) => [c.shape, c.n]));
    report.command_patterns = {
      total_tool_calls: counts.reduce((n, c) => n + c.n, 0),
      entries: entries.map((e) => {
        const re = typeof e.pattern === 'string' ? new RegExp(e.pattern) : null;
        const hits = re ? shapes.filter((s) => re.test(s.shape)).reduce((n, s) => n + (byShape.get(s.shape) ?? 0), 0) : 0;
        return { id: e.id ?? '', hits };
      }),
    };
    report.sample = `${report.command_patterns.total_tool_calls} tool calls on this machine`;
  } else if (m.kind === 'assets') {
    report.assets = scoreAssets(db, m);
    report.sample = 'scored against this machine\'s action-target and egress ledgers — an entry scoring zero here may be another team\'s crown jewel';
  } else if (m.kind === 'thresholds' || m.kind === 'rule_policy') {
    const cand = (m.rules ?? {}) as Record<string, Record<string, number>>;
    const stored = db.prepare('SELECT rule, COUNT(*) AS n FROM anomalies GROUP BY rule').all() as { rule: string; n: number }[];
    const storedN = new Map(stored.map((s) => [s.rule, s.n]));
    report.thresholds = {
      changed: effectiveThresholds()
        .filter((t) => typeof cand[t.rule]?.[t.param] === 'number' && cand[t.rule]![t.param] !== t.effective)
        .map((t) => ({ rule: t.rule, param: t.param, from: t.effective, to: cand[t.rule]![t.param] as number, stored_anomalies: storedN.get(t.rule) ?? 0 })),
    };
    report.sample = 'configured thresholds, not enforcement — nothing here prevents an agent from doing anything';
  } else {
    report.sample = 'no dry-run scorer for this kind on this machine — signature verified only';
  }
  return report;
}
