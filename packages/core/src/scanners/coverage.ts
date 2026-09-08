import { readdirSync, readFileSync, existsSync, statSync, lstatSync, readlinkSync, openSync, closeSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { openDb, insertAnomalies } from '../db';
import type { DB, Scanner } from '../db';
import type { Anomaly, Tool } from '../types';
import { loadSurfacePolicy, isSanctioned } from '../policy';
import { readPlist } from './tier2-extras';

/**
 * The coverage lane (tier 2 features 48, 50, 52, 23, 33): everything that turns
 * "Vole saw a thing" into "here is exactly how much Vole could not see, and who
 * else could have seen it". Inventory only — names, counts, byte sizes and dates;
 * never content, never values, never a token.
 */

// ── launchd-declared log tail → surface_activity (feature 48) ───────────────────

/**
 * The versioned endpoint pattern pack: what a log line must look like to count
 * as a model request shape. Event-name shapes only — no bodies, no payloads are
 * ever stored, only that a line matched.
 */
export const ENDPOINT_PATTERN_PACK = {
  version: 1,
  patterns: [
    /POST \/v1\/messages\b/,
    /POST \/v1\/chat\/completions\b/,
    /POST \/v1beta\/models\/[^:\s]+:generateContent\b/,
    /\bmodel=[A-Za-z0-9._/:+-]+/,
  ],
} as const;

/** Pure: how many lines in a chunk match the endpoint pack. */
export function countEndpointLines(text: string, patterns: readonly RegExp[] = ENDPOINT_PATTERN_PACK.patterns): number {
  let n = 0;
  for (const line of text.split('\n')) {
    if (line.length > 4096) continue; // ponytail: guard against un-terminated binary blobs
    if (patterns.some((p) => p.test(line))) n++;
  }
  return n;
}

/**
 * Monotone counter upsert on (surface_key, counter_kind): the stored counter only
 * ever grows by the delta matched this pass, and the watermark (byte offset)
 * advances to the file size read. Rotation: if the file shrank below the
 * watermark it was truncated/rotated — restart from 0 rather than double-count.
 * ponytail: one counter row per log; per-day buckets if a sparkline ever needs history.
 */
export function tailCounter(
  db: DB,
  surfaceKey: string,
  counterKind: string,
  file: string,
  now: number,
  match: (text: string) => number,
): { added: number; total: number } | null {
  if (!existsSync(file)) return null; // absent log: no fact, no counter row
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return null;
  }
  const prev = db
    .prepare('SELECT counter, watermark FROM surface_activity WHERE surface_key = ? AND counter_kind = ?')
    .get(surfaceKey, counterKind) as { counter: number; watermark: number | null } | undefined;
  const counter = prev?.counter ?? 0;
  let start = prev?.watermark ?? 0;
  if (start > size) start = 0; // rotated: reset instead of double-counting
  if (start === size) {
    db.prepare(
      'UPDATE surface_activity SET last_seen = ? WHERE surface_key = ? AND counter_kind = ?',
    ).run(now, surfaceKey, counterKind);
    return { added: 0, total: counter };
  }
  // ponytail: cap a pass's read at 4 MiB; a chatty log catches up over passes.
  const readLen = Math.min(size - start, 4 * 1024 * 1024);
  let added = 0;
  try {
    const fd = openSync(file, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      const bytes = readSync(fd, buf, 0, readLen, start);
      added = match(buf.subarray(0, bytes).toString('utf8'));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null; // unreadable log: an attempted read, not a zero
  }
  const watermark = start + readLen;
  db.prepare(`
    INSERT INTO surface_activity (surface_key, counter_kind, counter, watermark, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(surface_key, counter_kind) DO UPDATE SET
      counter = counter + excluded.counter,
      watermark = excluded.watermark,
      last_seen = excluded.last_seen
  `).run(surfaceKey, counterKind, added, watermark, now, now);
  return { added, total: counter + added };
}

/** launchd job log tails: the operator's own declared StandardOut/ErrPath. */
export function launchdLogTails(db: DB, now: number): { label: string; log: string; matched: number }[] {
  const out: { label: string; log: string; matched: number }[] = [];
  const dirs = [
    join(homedir(), 'Library/LaunchAgents'),
    '/Library/LaunchAgents',
    '/Library/LaunchDaemons',
  ];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // no read on that dir: attempted, not zero — scan_access owns the fact
    }
    for (const f of entries) {
      if (!f.endsWith('.plist')) continue;
      const plist = readPlist(join(dir, f));
      if (!plist) continue;
      for (const log of plist.logPaths) {
        const r = tailCounter(db, `launchd:${plist.label}`, 'endpoint_lines', log, now, countEndpointLines);
        if (r) out.push({ label: plist.label, log, matched: r.total });
      }
    }
  }
  return out;
}

// ── console and gateway coverage ledger (feature 52) ───────────────────────────

/**
 * Console-blind: a token-bearing row whose model id is not the vendor's
 * first-party shape — gateway aliases, routers, local runtimes. NULL model can
 * never be classified and is excluded (an unknown, never "first-party").
 */
const FIRST_PARTY: Record<string, RegExp> = {
  claude_code: /^claude/i,
  codex: /^gpt/i,
  antigravity: /^gemini/i,
  gemini: /^gemini/i,
  grok: /^grok/i,
};

export function isConsoleBlind(tool: string, model: string): boolean | null {
  const fp = FIRST_PARTY[tool];
  if (!fp) return null; // no vendor shape known for this tool: unknowable
  return !fp.test(model);
}

/** Per-surface (tool) console-blind share, from stored live rows. NULL-free denominators. */
export function consoleBlindShare(db: DB): { tool: string; rows: number; blind: number; tokens: number; blindTokens: number }[] {
  const rows = db.prepare(
    `SELECT tool, model, COUNT(*) AS n, SUM(total_tokens) AS tokens
     FROM usage_events WHERE source = 'live' AND model IS NOT NULL AND total_tokens IS NOT NULL
     GROUP BY tool, model`,
  ).all() as { tool: string; model: string; n: number; tokens: number | null }[];
  const byTool = new Map<string, { tool: string; rows: number; blind: number; tokens: number; blindTokens: number }>();
  for (const r of rows) {
    const agg = byTool.get(r.tool) ?? { tool: r.tool, rows: 0, blind: 0, tokens: 0, blindTokens: 0 };
    agg.rows += r.n;
    agg.tokens += r.tokens ?? 0;
    if (isConsoleBlind(r.tool, r.model)) {
      agg.blind += r.n;
      agg.blindTokens += r.tokens ?? 0;
    }
    byTool.set(r.tool, agg);
  }
  return [...byTool.values()];
}

/** Persist the ledger as per-surface rows the Coverage screen reads (rendering is reader work). */
export function writeConsoleCoverage(db: DB, now: number): { tool: string; rows: number; blind: number }[] {
  const share = consoleBlindShare(db);
  const upsert = db.prepare(`
    INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, version, extra, first_seen, last_seen)
    VALUES (?, 'context', ?, NULL, ?, NULL, ?, ?, ?)
    ON CONFLICT(surface_key) DO UPDATE SET evidence = excluded.evidence, extra = excluded.extra, last_seen = excluded.last_seen`);
  const out: { tool: string; rows: number; blind: number }[] = [];
  for (const s of share) {
    const pct = s.rows ? Math.round((s.blind / s.rows) * 100) : 0;
    upsert.run(
      `console-coverage:${s.tool}`,
      `Console coverage — ${s.tool}`,
      `console-blind share: ${s.blind} of ${s.rows} token-bearing rows (${pct}%) — models routed through gateways, routers and local runtimes that no vendor console reports`,
      JSON.stringify({ tool: s.tool, rows: s.rows, blind: s.blind, tokens: s.tokens, blindTokens: s.blindTokens }),
      now, now,
    );
    out.push({ tool: s.tool, rows: s.rows, blind: s.blind });
  }
  return out;
}

// ── ghost-app detector (feature 23) ─────────────────────────────────────────────

/** Bundle-id shapes that mark an app as an AI surface (catalog, never fuzzy). */
const AI_BUNDLE_ID = /^(com\.anthropic\.|com\.openai\.|com\.exafunction\.|com\.cursor\.|com\.lmstudio\.|jan\.ai\.|dev\.warp\.|com\.zed-industries\.|com\.todesktop\.230313\.)/i;

/** Minimal plist bundle-id scrape for installed .app census. */
function bundleIdOf(appDir: string): string | null {
  try {
    return readFileSync(join(appDir, 'Contents/Info.plist'), 'utf8')
      .match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface GhostFinding {
  bundleId: string | null;
  name: string;
  evidence: string;
  lastWrite: number | null;
}

/**
 * Set-difference the residue bundle ids (~/Library/Preferences plist filenames,
 * Application Support dirs) against the installed bundle ids from the app census.
 * A preference plist proves the app launched at least once under this user; the
 * mtime is the last preference write, not the last use.
 */
export function ghostAppResidues(
  home: string,
  appRoots: string[] = ['/Applications', join(home, 'Applications')],
  linkFarms: string[] = ['/usr/local/bin', '/opt/homebrew/bin'],
): GhostFinding[] {
  const installed = new Set<string>();
  for (const root of appRoots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.app')) continue;
      const id = bundleIdOf(join(root, name));
      if (id) installed.add(id);
    }
  }
  const out: GhostFinding[] = [];
  const prefs = join(home, 'Library/Preferences');
  let plists: string[];
  try {
    plists = readdirSync(prefs);
  } catch {
    plists = [];
  }
  for (const f of plists) {
    if (!f.endsWith('.plist')) continue;
    const bundleId = f.replace(/\.plist$/, '');
    if (!AI_BUNDLE_ID.test(bundleId) || installed.has(bundleId)) continue;
    let lastWrite: number | null = null;
    try {
      lastWrite = statSync(join(prefs, f)).mtimeMs;
    } catch {
      /* unreadable mtime: unknown, not zero */
    }
    out.push({
      bundleId,
      name: `${bundleId} (removed)`,
      evidence: `preference plist ${join(prefs, f)} survives the app — it ran here once and was removed; mtime is the last preference write, not the last use`,
      lastWrite,
    });
  }
  // Dangling symlinks in the classic CLI link farms: the binary is gone, the name remains.
  for (const dir of linkFarms) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let isLink = false;
      try {
        isLink = lstatSync(p).isSymbolicLink();
      } catch {
        continue;
      }
      if (!isLink) continue;
      let target: string;
      try {
        target = readlinkSync(p);
      } catch {
        continue;
      }
      try {
        statSync(p); // resolves the link: throws when dangling
        continue;
    } catch {
        /* dangling: below */
      }
      if (!/claude|codex|gemini|aider|goose|amp|continue|ollama|lmstudio|jan|litellm|ccr/i.test(name + ' ' + target)) continue;
      out.push({
        bundleId: null,
        name: `${name} → ${target} (dangling)`,
        evidence: `dangling symlink ${p} → ${target} — the tool it pointed at is gone from disk`,
        lastWrite: null,
      });
    }
  }
  return out;
}

// ── second-tier store prober (feature 33) ──────────────────────────────────────

export interface StoreDef {
  name: string;
  key: string;
  dir: (home: string) => string;
  /** Which entries inside the dir count as one session (files or dirs). */
  sessionMatch: RegExp;
}

/** One module, ten tools: the spec's table, not the earlier dot-dir sweep. */
export const STORES: StoreDef[] = [
  { name: 'Goose', key: 'goose', dir: (h) => join(h, '.local/share/goose/sessions'), sessionMatch: /^sessions\.db$/ },
  { name: 'Amp', key: 'amp', dir: (h) => join(h, '.local/share/amp/threads'), sessionMatch: /^[\w-]+$/ },
  { name: 'Continue', key: 'continue', dir: (h) => join(h, '.continue/dev_data'), sessionMatch: /\.jsonl$/i },
  { name: 'Cline / Roo', key: 'cline', dir: (h) => join(h, '.local/share/cline-tasks'), sessionMatch: /^[\w-]+$/ },
  { name: 'Zed', key: 'zed', dir: (h) => join(h, 'Library/Application Support/Zed/threads'), sessionMatch: /^threads\.db$/ },
  { name: 'Kiro', key: 'kiro', dir: (h) => join(h, '.kiro/sessions'), sessionMatch: /^sess_/ },
  { name: 'Copilot CLI', key: 'copilot', dir: (h) => join(h, '.copilot/session-state'), sessionMatch: /^[\w-]+$/ },
  { name: 'Aider', key: 'aider', dir: (h) => join(h, '.aider-marker'), sessionMatch: /^\.aider\.chat\.history\.md$/ },
  { name: 'LM Studio', key: 'lmstudio', dir: (h) => join(h, '.lmstudio/conversations'), sessionMatch: /\.json$/i },
  { name: 'Jan', key: 'jan', dir: (h) => join(h, 'Library/Application Support/Jan/data/threads'), sessionMatch: /^[\w-]+$/ },
];

export interface StoreStats {
  sessions: number | null;
  mb: number | null;
  lastWrite: number | null;
}

/**
 * Per-store stats — session count, MB and last-write, never bare existence. MB is
 * the summed file size within a bounded walk.
 * ponytail: walk capped at depth 3 / 2000 files per store; uncap if a store ever
 * legitimately exceeds it (log farms, not session stores, are the risk).
 */
export function storeStats(dir: string, sessionMatch: RegExp): StoreStats | null {
  if (!existsSync(dir)) return null;
  let sessions = 0;
  let bytes = 0;
  let lastWrite: number | null = null;
  let visited = 0;
  const walk = (d: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return; // unreadable subtree: attempted, not zero
    }
    for (const e of entries) {
      if (++visited > 2000) return;
      const p = join(d, e.name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory() && depth < 3) walk(p, depth + 1);
      bytes += st.size;
      if (depth === 0 && sessionMatch.test(e.name)) sessions++;
      if (lastWrite === null || st.mtimeMs > lastWrite) lastWrite = st.mtimeMs;
    }
  };
  walk(dir, 0);
  return { sessions, mb: Math.round((bytes / (1024 * 1024)) * 10) / 10, lastWrite };
}

export function storeProberRows(home: string): { key: string; name: string; dir: string; stats: StoreStats }[] {
  const out: { key: string; name: string; dir: string; stats: StoreStats }[] = [];
  for (const s of STORES) {
    const dir = s.dir(home);
    const stats = storeStats(dir, s.sessionMatch);
    if (!stats) continue;
    out.push({ key: s.key, name: s.name, dir, stats });
  }
  return out;
}

// ── sanctioned-vs-detected join: distinct first_seen + heartbeat (feature 50) ──

/**
 * Fires the first day a surface appears that policy does not declare. Keyed by
 * surface + policy digest, so a policy change re-evaluates into a new,
 * explainable incident instead of being swallowed. Inert without a policy —
 * 'unsanctioned' is a company decision, not a technical fact.
 * The rule id stays 'unsanctioned_surface' (the union's existing literal);
 * integration may widen the union with 'unsanctioned_surface_first_seen'.
 */
export function sanctionedFirstSeen(db: DB, now: number): { fired: number; policy: string } {
  const policy = loadSurfacePolicy();
  if (!policy) return { fired: 0, policy: 'none loaded — join inert' };
  const digest = createHash('sha256').update(JSON.stringify(policy.allowed)).digest('hex').slice(0, 8);
  const surfaces = db.prepare('SELECT surface_key, kind, name, path, evidence, first_seen FROM ai_surfaces').all() as {
    surface_key: string; kind: string; name: string; path: string | null; evidence: string; first_seen: number;
  }[];
  const anomalies: Anomaly[] = [];
  for (const s of surfaces) {
    if (isSanctioned(policy, s.surface_key) !== false) continue; // sanctioned or glob-miss
    anomalies.push({
      anomaly_key: `unsanctioned_first_seen:${s.surface_key}:${digest}`,
      rule: 'unsanctioned_surface',
      severity: 'warn',
      tool: 'claude_code' as Tool,
      session_id: null,
      model: null,
      window_start: now,
      window_end: now,
      title: `Unsanctioned surface first seen: ${s.name}`,
      detail:
        `${s.surface_key} (kind ${s.kind}) is not in allowed_surfaces of ${policy.source}. ` +
        `Detected via ${s.path ?? 'its artifact'} — ${s.evidence}. Sanctioning is a policy decision, not a technical fact.`,
      observed: 1,
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }
  const res = insertAnomalies(db, anomalies);
  return { fired: res.inserted.length, policy: policy.source };
}

/**
 * The per-pass heartbeat: every surface still present this pass ticks a monotone
 * 'heartbeat' counter in surface_activity — the sparkline source for the
 * sanctioned-vs-detected cards, without inventing a new table.
 */
export function heartbeatSurfaces(db: DB, now: number): number {
  const surfaces = db.prepare('SELECT surface_key FROM ai_surfaces').all() as { surface_key: string }[];
  const upsert = db.prepare(`
    INSERT INTO surface_activity (surface_key, counter_kind, counter, watermark, first_seen, last_seen)
    VALUES (?, 'heartbeat', 1, NULL, ?, ?)
    ON CONFLICT(surface_key, counter_kind) DO UPDATE SET
      counter = counter + 1, last_seen = excluded.last_seen`);
  for (const s of surfaces) upsert.run(s.surface_key, now, now);
  return surfaces.length;
}

// ── the scanner ────────────────────────────────────────────────────────────────

export const coverageScanner: Scanner = {
  name: 'coverage',
  cadenceMs: 5 * 60_000,
  run: () => {
    const db = openDb();
    const now = Date.now();
    const home = homedir();

    const tails = launchdLogTails(db, now);
    // Enrol launchd jobs whose declared logs matched endpoint lines: their log is
    // the only telemetry that exists for them.
    const gatewayUpsert = db.prepare(`
      INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, version, extra, first_seen, last_seen)
      VALUES (?, 'gateway', ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(surface_key) DO UPDATE SET evidence = excluded.evidence, extra = excluded.extra, last_seen = excluded.last_seen`);
    for (const t of tails) {
      if (!t.matched) continue;
      gatewayUpsert.run(
        `launchd:${t.label}`, `${t.label} (launchd-declared)`, t.log,
        `always-on service whose own operator-declared log matched ${t.matched} endpoint-shaped line(s) — requests observed, tokens unknown`,
        JSON.stringify({ label: t.label, log: t.log, matchedLines: t.matched, pack: ENDPOINT_PATTERN_PACK.version }),
        now, now,
      );
    }

    const consoleShare = writeConsoleCoverage(db, now);

    const ghosts = ghostAppResidues(home);
    const ghostUpsert = db.prepare(`
      INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, version, extra, first_seen, last_seen)
      VALUES (?, 'ghost_app', ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(surface_key) DO UPDATE SET evidence = excluded.evidence, extra = excluded.extra, last_seen = excluded.last_seen`);
    for (const g of ghosts) {
      ghostUpsert.run(
        `ghost-app:${g.bundleId ?? g.name}`, g.name, g.bundleId ? join(home, 'Library/Preferences', `${g.bundleId}.plist`) : null,
        g.evidence, JSON.stringify({ bundleId: g.bundleId, lastWrite: g.lastWrite }),
        now, g.lastWrite ?? now,
      );
    }

    const stores = storeProberRows(home);
    const storeUpsert = db.prepare(`
      INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, version, extra, first_seen, last_seen)
      VALUES (?, 'store', ?, ?, ?, NULL, ?, ?, ?)
      ON CONFLICT(surface_key) DO UPDATE SET evidence = excluded.evidence, extra = excluded.extra, last_seen = excluded.last_seen`);
    for (const s of stores) {
      const last = s.stats.lastWrite ? new Date(s.stats.lastWrite).toISOString().slice(0, 10) : 'unknown';
      storeUpsert.run(
        `store:${s.key}`, s.name, s.dir,
        `${s.stats.sessions ?? 'unknown'} sessions, ${s.stats.mb ?? 'unknown'} MB, last write ${last} — presence and size are exact; tokens are not recoverable here`,
        JSON.stringify(s.stats), now, s.stats.lastWrite ?? now,
      );
    }

    const beats = heartbeatSurfaces(db, now);
    const sanctioned = sanctionedFirstSeen(db, now);
    db.prepare(
      `INSERT INTO column_provenance (table_name, column_name, migration_version, first_populated_ts, unbackfillable_rows)
       VALUES (?, 'watermark', 20, ?, 0)
       ON CONFLICT(table_name, column_name) DO UPDATE SET unbackfillable_rows = excluded.unbackfillable_rows`,
    ).run('surface_activity', now);

    return {
      ok: true,
      notes:
        `${tails.length} launchd log tail(s), ${consoleShare.length} console-coverage surface(s)` +
        (ghosts.length ? `, ${ghosts.length} ghost app residue(s)` : '') +
        (stores.length ? `, ${stores.length} second-tier store(s)` : '') +
        ` · ${beats} surface heartbeat(s) · policy: ${sanctioned.policy}` +
        (sanctioned.fired ? ` · ${sanctioned.fired} NEW unsanctioned first-seen` : ''),
    };
  },
};
