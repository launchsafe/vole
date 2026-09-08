import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { DB } from '../db';
import { paths } from '../paths';
import { Database } from '../sqlite';
import { isExcluded } from '../dlp/engine';

/**
 * The where-it-landed chain's residence half (tier 4 #128/#129/#132):
 *
 * key_residency — under CONSENTED repo roots only, deploy and CI manifests
 * are read for references to provider key NAMES (secrets.X, env:, ENV/ARG,
 * terraform variables). A manifest reference is a reference, not a
 * deployment: it cannot confirm the target ever received the key, cannot see
 * the value, and cannot enumerate residencies that never touch this disk.
 *
 * residency_evidence / recipient_state — the region hop, ranked by the
 * evidence that produced it: route-declared (the gateway config's api_base
 * carries a region token) beats pack-asserted beats nothing. A surface with
 * no evidence keeps state 'unknown' rather than a guessed country, and the
 * chain's visual break comes from the rank column, never from silence.
 *
 * answerable_from — per (source × indicator_kind), the earliest timestamp a
 * hunt can truthfully answer 'not seen', with the basis that produced the
 * bound. The basis is READ (the vendor's own retention setting, the real
 * mtime span of the retained files), never assumed.
 */

const home = () => process.env.VOLE_HOME_OVERRIDE ?? homedir();

// ── key_residency ──────────────────────────────────────────────────────────

export type TargetClass = 'ci' | 'container' | 'paas' | 'iac';

export interface ManifestTarget {
  /** Glob-ish patterns relative to the repo root, matched against the relative path. */
  match: RegExp;
  targetClass: TargetClass;
}

export const MANIFEST_TARGETS: ManifestTarget[] = [
  { match: /^\.github\/workflows\/[^/]+\.(ya?ml)$/, targetClass: 'ci' },
  { match: /^\.gitlab-ci\.yml$/, targetClass: 'ci' },
  { match: /^\.env\.production$/, targetClass: 'paas' },
  { match: /^vercel\.json$|^fly\.toml$|^app\.yaml$|^serverless\.yml$/, targetClass: 'paas' },
  { match: /^docker-compose[^/]*\.ya?ml$/, targetClass: 'container' },
  { match: /^(?:[^/]+\/)?Dockerfile$/, targetClass: 'container' },
  { match: /\.tf(vars)?$/, targetClass: 'iac' },
];

/** Extracts the variable NAMES a manifest declares or references — names only, never values. */
export function extractVarNames(text: string, targetClass: TargetClass): string[] {
  const names = new Set<string>();
  const add = (n: string | undefined) => {
    if (n && n.length >= 3) names.add(n);
  };
  if (targetClass === 'ci') {
    for (const m of text.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)) add(m[1]);
  }
  if (targetClass === 'container') {
    for (const m of text.matchAll(/^\s*(?:ENV|ARG)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) add(m[1]);
  }
  // YAML env blocks, map form (KEY: value) and list form (- KEY=value), plus
  // terraform variable blocks and tfvars keys.
  for (const m of text.matchAll(/(?:^|\s)(?:env|environment):\s*\n((?:[ \t]+[^\n]*\n?)+)/g)) {
    for (const line of m[1]!.split('\n')) {
      add(line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/)?.[1]);
      add(line.match(/^\s*-\s*([A-Za-z_][A-Za-z0-9_]*)=/)?.[1]);
    }
  }
  for (const m of text.matchAll(/\bvariables:\s*\n((?:[ \t]+[^\n]*\n?)+)/g)) {
    for (const line of m[1]!.split('\n')) add(line.match(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s*$/)?.[1]);
  }
  for (const m of text.matchAll(/^\s*variable\s+"([^"]+)"/gm)) add(m[1]);
  for (const m of text.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"|[^=\n])/gm)) add(m[1]);
  if (targetClass === 'paas') {
    // JSON env objects (vercel.json build.env / serverless.yml environment:)
    for (const m of text.matchAll(/"env"\s*:\s*\{([^}]*)\}/g)) {
      for (const k of m[1]!.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)) add(k[1]);
    }
    for (const m of text.matchAll(/\[env\]\s*\n((?:[^\[\n]+\n?)+)/g)) {
      for (const k of m[1]!.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) add(k[1]);
    }
    for (const m of text.matchAll(/^(?:[A-Za-z_][A-Za-z0-9_]*)=/gm)) add(m[0].slice(0, -1));
  }
  return [...names];
}

function manifestClass(relPath: string): TargetClass | null {
  for (const t of MANIFEST_TARGETS) if (t.match.test(relPath)) return t.targetClass;
  return null;
}

/** Loads the exclusion floor (same precedence shape as the surface policy). */
function loadExclusions(): string[] {
  for (const p of paths.exclusionPaths()) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { exclude?: string[] };
      if (Array.isArray(parsed.exclude)) return parsed.exclude;
    } catch { /* absent or malformed: no exclusions loaded */ }
  }
  return [];
}

function walkManifests(root: string, out: string[], limit = 4000): void {
  const walk = (dir: string, depth: number) => {
    if (out.length >= limit || depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name.startsWith('.venv')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (manifestClass(relative(root, p))) out.push(p);
    }
  };
  walk(root, 0);
}

const RESIDENCY_UPSERT = `
INSERT INTO key_residency (repo, manifest_path, var_name, target_class, source, first_seen, last_seen)
VALUES (?, ?, ?, ?, 'live', ?, ?)
ON CONFLICT(repo, manifest_path, var_name) DO UPDATE SET last_seen = excluded.last_seen`;

/** Scans CI/container/PaaS/IaC manifests under consented work roots for key-name references. */
export function collectKeyResidency(db: DB, consentedRoots: string[], now = Date.now()): {
  rows: number; repos: number; notes: string[];
} {
  const exclusions = loadExclusions();
  const upsert = db.prepare(RESIDENCY_UPSERT);
  let rows = 0;
  const repos = new Set<string>();
  const notes: string[] = [];
  for (const root of consentedRoots) {
    if (isExcluded(root, exclusions)) {
      notes.push(`${root}: excluded by policy, never opened`);
      continue;
    }
    if (!existsSync(root)) continue;
    const manifests: string[] = [];
    walkManifests(root, manifests);
    repos.add(root);
    for (const m of manifests) {
      const rel = relative(root, m);
      const cls = manifestClass(rel)!;
      let text: string;
      try {
        text = readFileSync(m, 'utf8');
      } catch { continue; }
      for (const name of extractVarNames(text, cls)) {
        upsert.run(root, rel, name, cls, now, now);
        rows++;
      }
    }
  }
  return { rows, repos: repos.size, notes };
}

// ── residency_evidence + recipient_state: the region hop, ranked ──────────

/** Region tokens a route's own api_base can carry — read off the host, never resolved via network. */
const REGION_TOKENS: [RegExp, string][] = [
  [/(^|[.-])(eu|europe|eu-central|eu-west|fr|de|uk|ie)([.-]|$)/i, 'eu'],
  [/(^|[.-])(us|us-east|us-west|na)([.-]|$)/i, 'us'],
  [/(^|[.-])(apac|ap|jp|sg|au)([.-]|$)/i, 'apac'],
];

export function regionOfHost(host: string): string | null {
  for (const [re, region] of REGION_TOKENS) if (re.test(host)) return region;
  return null;
}

interface PackTermsEntry {
  surface_key?: string;
  kind?: string;
  value?: string;
}

/** Loads the admin terms pack if one is installed (packPaths), entries with a region kind. */
function loadRegionAssertions(): { source: string; regions: Map<string, string> } {
  for (const dir of paths.packPaths()) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch { continue; }
    for (const f of files) {
      if (!/^terms.*\.json$/i.test(f)) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { entries?: PackTermsEntry[] };
        const regions = new Map<string, string>();
        for (const e of parsed.entries ?? []) {
          if (e.surface_key && e.kind === 'region' && e.value) regions.set(e.surface_key, e.value);
        }
        return { source: join(dir, f), regions };
      } catch { /* malformed pack: ignored, never fatal */ }
    }
  }
  return { source: '', regions: new Map() };
}

/**
 * Populates residency_evidence and recipient_state for every known surface:
 * rank 2 = route-declared (the gateway's api_base host carries a region
 * token), rank 3 = pack-asserted (the admin terms pack), state 'unknown' with
 * an evidence_ref when the surface was examined and nothing was found. Every
 * hop carries the badge of the evidence that produced it.
 */
export function collectResidencyEvidence(db: DB, now = Date.now()): { evidence: number; states: number } {
  const routes = db.prepare(
    'SELECT route_key, api_base, source FROM model_routes',
  ).all() as unknown as { route_key: string; api_base: string | null; source: string | null }[];
  const surfaces = db.prepare(
    'SELECT surface_key, path FROM ai_surfaces',
  ).all() as unknown as { surface_key: string; path: string | null }[];
  const pack = loadRegionAssertions();

  // The gateway config file a surface points at → that route's api_base host.
  const routeByPath = new Map<string, { route_key: string; host: string }>();
  for (const r of routes) {
    if (!r.api_base || !r.source) continue;
    try {
      routeByPath.set(r.source, { route_key: r.route_key, host: new URL(r.api_base).host });
    } catch { /* unparseable api_base: no route evidence */ }
  }

  const evidenceUpsert = db.prepare(`
    INSERT INTO residency_evidence (surface_key, rank, evidence, source, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(surface_key, evidence) DO UPDATE SET last_seen = excluded.last_seen`);
  const stateUpsert = db.prepare(`
    INSERT INTO recipient_state (surface_key, state, evidence_ref, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(surface_key, state) DO UPDATE SET last_seen = excluded.last_seen`);

  let evidence = 0;
  let states = 0;
  for (const s of surfaces) {
    const route = s.path ? routeByPath.get(s.path) : undefined;
    if (route) {
      const region = regionOfHost(route.host);
      evidenceUpsert.run(s.surface_key, 2,
        `route-declared: gateway api_base host ${route.host} carries a region token`,
        `model_routes:${route.route_key}`, now, now);
      evidence++;
      stateUpsert.run(s.surface_key, region ?? 'unknown', route.host, now, now);
      states++;
      continue;
    }
    const asserted = pack.regions.get(s.surface_key);
    if (asserted) {
      evidenceUpsert.run(s.surface_key, 3, `pack-asserted: terms pack declares region ${asserted}`,
        pack.source, now, now);
      evidence++;
      stateUpsert.run(s.surface_key, asserted, pack.source, now, now);
      states++;
      continue;
    }
    // Examined and nothing found: the hop is an explicit unknown with its
    // evidence_ref, so the chain draws a break instead of closing the line.
    stateUpsert.run(s.surface_key, 'unknown', 'no local evidence examined this pass', now, now);
    states++;
  }
  return { evidence, states };
}

// ── answerable_from: the horizon that makes 'not seen' an answer ────────────

export type IndicatorKind = 'secret_sightings' | 'payload_sightings' | 'context_imports';

export interface HorizonRow {
  source: string;
  indicator_kind: IndicatorKind;
  horizon_ts: number | null;
  basis: string;
}

function minMtime(files: { path: string; mtime: number }[]): { horizon: number; files: number } | null {
  if (!files.length) return null;
  return { horizon: Math.min(...files.map((f) => f.mtime)), files: files.length };
}

function listFiles(dir: string, filter?: (name: string) => boolean): { path: string; mtime: number }[] {
  const out: { path: string; mtime: number }[] = [];
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!filter || filter(e.name)) {
        try { out.push({ path: p, mtime: statSync(p).mtimeMs }); } catch { /* raced */ }
      }
    }
  };
  walk(dir);
  return out;
}

/** The vendor's own cleanup setting, READ from settings/managed-settings (default 30 is documented, never assumed). */
export function claudeRetentionDays(): { days: number; basis: string } {
  for (const p of [join('/Library', 'Application Support', 'ClaudeCode', 'managed-settings.json'),
    join(paths.claudeConfigDir(), 'settings.json')]) {
    try {
      const s = JSON.parse(readFileSync(p, 'utf8')) as { cleanupPeriodDays?: number };
      if (typeof s.cleanupPeriodDays === 'number') {
        return { days: s.cleanupPeriodDays, basis: `cleanupPeriodDays=${s.cleanupPeriodDays} (${p.replace(/^\/Users\/[^/]+/, '~')})` };
      }
    } catch { /* absent: try the next layer */ }
  }
  return { days: 30, basis: 'cleanupPeriodDays unset — the vendor-documented tool default (30) applies' };
}

function npmLogsMax(): string {
  const r = spawnSync('npm', ['config', 'get', 'logs-max'], { encoding: 'utf8', timeout: 4000 });
  if (r.status === 0 && r.stdout) return `npm logs-max=${r.stdout.trim()} (npm's own bound on ~/.npm/_logs)`;
  return 'npm logs-max unknown (probe unavailable) — the documented default is 10';
}

/**
 * Computes the per-(source × indicator_kind) horizon from what actually
 * exists on disk plus the retention settings that bound it. A horizon is the
 * earliest evidence that still exists — a floor on answerability, never a
 * guarantee of coverage above it.
 */
export function computeHorizons(): HorizonRow[] {
  const rows: HorizonRow[] = [];
  const iso = (ts: number) => new Date(ts).toISOString().slice(0, 10);

  // Claude transcripts: bounded by the vendor's own cleanup period, checked
  // against the real mtime span of what is actually retained.
  const transcripts = listFiles(paths.claudeCodeProjects(), (n) => n.endsWith('.jsonl'));
  const retention = claudeRetentionDays();
  const tr = minMtime(transcripts);
  const claudeBasis = `${retention.basis}; oldest retained transcript ${tr ? `${iso(tr.horizon)} (${tr.files} files)` : 'none on disk'}`;
  for (const kind of ['secret_sightings', 'payload_sightings'] as IndicatorKind[]) {
    rows.push({
      source: 'claude_transcripts', indicator_kind: kind,
      horizon_ts: tr ? Math.trunc(tr.horizon) : null, basis: claudeBasis,
    });
  }
  // The last-cleanup stamp: when the vendor's own sweep last ran.
  const lastCleanup = join(paths.claudeConfigDir(), '.last-cleanup');
  if (existsSync(lastCleanup)) {
    try {
      rows.push({
        source: 'claude_cleanup_sweep', indicator_kind: 'secret_sightings',
        horizon_ts: Date.parse(readFileSync(lastCleanup, 'utf8').trim()),
        basis: `~/.claude/.last-cleanup read verbatim — the vendor's own sweep timestamp`,
      });
    } catch { /* unreadable stamp */ }
  }

  // Codex rollouts and thread_history: no vendor retention known — the store's
  // own earliest row/file is the only honest bound.
  const rollouts = minMtime(listFiles(paths.codexSessions()));
  rows.push({
    source: 'codex_rollouts', indicator_kind: 'secret_sightings',
    horizon_ts: rollouts ? Math.trunc(rollouts.horizon) : null,
    basis: rollouts ? `${rollouts.files} rollout file(s); vendor retention unknown` : 'no rollout files retained',
  });
  const th = join(paths.codexHome(), 'thread_history_1.sqlite');
  let thHorizon: number | null = null;
  let thBasis = 'thread_history store absent';
  if (existsSync(th)) {
    try {
      const store = new Database(th, { readonly: true, fileMustExist: true });
      const r = store.prepare('SELECT MIN(created_at_ms) AS m FROM thread_items').get() as { m: number | null };
      store.close();
      thHorizon = r.m ?? null;
      thBasis = r.m ? `earliest thread_items.created_at_ms; vendor retention unknown` : 'store present, no rows';
    } catch { thBasis = 'thread_history present but unreadable'; }
  }
  rows.push({ source: 'codex_thread_history', indicator_kind: 'secret_sightings', horizon_ts: thHorizon, basis: thBasis });

  // Import receipts: they outlive the source files, so the bound is the
  // earliest imported_at the receipt file still names.
  const receipts = join(paths.codexHome(), 'external_agent_session_imports.json');
  let impHorizon: number | null = null;
  let impBasis = 'no import receipts on disk';
  if (existsSync(receipts)) {
    try {
      const parsed = JSON.parse(readFileSync(receipts, 'utf8')) as { records?: { imported_at?: string }[] };
      const ats = (parsed.records ?? []).map((r) => Date.parse(r.imported_at ?? '')).filter((n) => !Number.isNaN(n));
      if (ats.length) {
        impHorizon = Math.min(...ats);
        impBasis = `${ats.length} import receipt(s) retained — receipts outlive the pruned source files`;
      }
    } catch { impBasis = 'import receipts unreadable'; }
  }
  rows.push({ source: 'codex_external_imports', indicator_kind: 'context_imports', horizon_ts: impHorizon, basis: impBasis });

  // Copilot's session store: its own earliest session timestamp.
  const copilotBasis = 'session-store.db sessions earliest created_at/updated_at; vendor retention unknown';
  let coHorizon: number | null = null;
  let coBasis = 'session-store.db absent from every editor globalStorage root';
  for (const root of [join(home(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
    join(home(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage')]) {
    const p = join(root, 'github.copilot-chat', 'session-store.db');
    if (!existsSync(p)) continue;
    try {
      const store = new Database(p, { readonly: true, fileMustExist: true });
      const r = store.prepare('SELECT MIN(COALESCE(created_at, updated_at)) AS m FROM sessions').get() as { m: number | string | null };
      store.close();
      const ms = typeof r.m === 'number' ? (r.m > 1e12 ? r.m : r.m * 1000)
        : typeof r.m === 'string' ? Date.parse(r.m) : null;
      coHorizon = ms !== null && !Number.isNaN(ms) ? ms : null;
      coBasis = copilotBasis;
    } catch { coBasis = 'session-store.db present but unreadable'; }
    break;
  }
  rows.push({ source: 'copilot_session_store', indicator_kind: 'secret_sightings', horizon_ts: coHorizon, basis: coBasis });

  // npm logs: bounded by the logs-max setting.
  const npmLogs = minMtime(listFiles(join(home(), '.npm', '_logs')));
  rows.push({
    source: 'npm_logs', indicator_kind: 'secret_sightings',
    horizon_ts: npmLogs ? Math.trunc(npmLogs.horizon) : null,
    basis: `${npmLogsMax()}; ${npmLogs ? `${npmLogs.files} log file(s), oldest ${iso(npmLogs.horizon)}` : 'no log files retained'}`,
  });

  // Prompt sinks: goose keeps the last 10 llm_request logs; gemini's prompt
  // log lives under tmp until the CLI removes it.
  const goose = minMtime(listFiles(join(home(), '.local', 'state', 'goose', 'logs'), (n) => /llm_request/.test(n)));
  rows.push({
    source: 'goose_llm_request', indicator_kind: 'secret_sightings',
    horizon_ts: goose ? Math.trunc(goose.horizon) : null,
    basis: goose ? `${goose.files} llm_request log(s) (last 10 kept); vendor retention 10 files` : 'no llm_request logs',
  });
  const gemini = minMtime(listFiles(join(paths.geminiHome(), 'tmp'), (n) => /prompt/.test(n)));
  rows.push({
    source: 'gemini_prompt_log', indicator_kind: 'secret_sightings',
    horizon_ts: gemini ? Math.trunc(gemini.horizon) : null,
    basis: gemini ? `${gemini.files} prompt log(s) under ~/.gemini/tmp` : 'no prompt logs under ~/.gemini/tmp',
  });

  return rows;
}

const HORIZON_UPSERT = `
INSERT INTO answerable_from (source, indicator_kind, horizon_ts, basis, first_seen, last_seen)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(source, indicator_kind) DO UPDATE SET
  horizon_ts = excluded.horizon_ts,
  basis      = excluded.basis,
  last_seen  = excluded.last_seen`;

/** Persists the horizons; first_seen stays the first time the bound was computed. */
export function collectAnswerableFrom(db: DB, now = Date.now()): number {
  const upsert = db.prepare(HORIZON_UPSERT);
  const rows = computeHorizons();
  for (const r of rows) upsert.run(r.source, r.indicator_kind, r.horizon_ts, r.basis, now, now);
  return rows.length;
}
