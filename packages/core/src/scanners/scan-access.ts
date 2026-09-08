import { readdirSync, openSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { paths } from '../paths';
import { openDb, insertAnomalies } from '../db';
import type { DB, Scanner } from '../db';
import type { Anomaly, Tool } from '../types';

/**
 * scan_access — the attempted-read ledger (tier 2 features 11, 16, 22).
 *
 * existsSync is not a permission oracle: TCC denies at open/readdir and never at
 * stat, so `existsSync` returning true says nothing about whether this process may
 * read the path. The only honest observable is the outcome of an actual attempt,
 * recorded as one of four states per (root, launch_context):
 *
 *   ok          — the read succeeded; `entries` counts what came back
 *   exists      — the path exists but yielded no directory listing (e.g. ENOTDIR)
 *   unreadable  — the read was attempted and denied; `errno` is the fact
 *   absent      — the read was attempted and the path does not exist
 *
 * Probe results are facts, never inferred zeros: a denied root is `unreadable`,
 * never "0 entries". Every attempted read in this scanner lane routes through
 * probeDir/probeFile so the readability matrix has a true denominator (the pill
 * rendering itself is reader work, wired at integration).
 */

export type ProbeState = 'ok' | 'exists' | 'unreadable' | 'absent';

export interface ProbeResult {
  state: ProbeState;
  /** The literal errno code of the failed attempt (EPERM, EACCES…); NULL when none. */
  errno: string | null;
  /** Entries seen on a successful directory read; NULL when not a listing. */
  entries: number | null;
}

/** The four-state probe for a directory root: readdir is the read we actually need. */
export function probeDir(root: string): ProbeResult {
  try {
    const entries = readdirSync(root);
    return { state: 'ok', errno: null, entries: entries.length };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? String(err);
    if (code === 'ENOENT') return { state: 'absent', errno: null, entries: null };
    // Path is present (stat succeeds) but the listing was refused or impossible.
    if (existsSync(root)) {
      if (code === 'ENOTDIR') return { state: 'exists', errno: code, entries: null };
      return { state: 'unreadable', errno: code, entries: null };
    }
    return { state: 'absent', errno: null, entries: null };
  }
}

/**
 * The four-state probe for a single file: OPEN the descriptor and close it
 * immediately — no bytes are read, ever (the FDA canary must never read TCC
 * content). open() is the syscall TCC gates, so its outcome is the permission
 * fact.
 */
export function probeFile(file: string): ProbeResult {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? String(err);
    if (code === 'ENOENT') return { state: 'absent', errno: null, entries: null };
    return existsSync(file)
      ? { state: 'unreadable', errno: code, entries: null }
      : { state: 'absent', errno: null, entries: null };
  }
  closeSync(fd);
  return { state: 'ok', errno: null, entries: null };
}

/**
 * Launch context for scan_access: which process shape made the attempt. Must be
 * stable across runs — it is half the UNIQUE key, so a per-run value (ppid!) would
 * break idempotency. ppid is deliberately excluded from the key for that reason;
 * the app/collector distinction comes from XPC_SERVICE_NAME, the uid from the OS.
 */
export function launchContext(): string {
  return `uid${process.getuid?.() ?? -1}:${process.env.XPC_SERVICE_NAME ? 'app' : 'cli'}`;
}

/** The read access table's last row for a root, before this pass rewrites it. */
export function readScanAccess(
  db: DB,
  root: string,
  context: string,
): { state: string; last_ok_ts: number | null; last_ok_entries: number | null } | undefined {
  return db
    .prepare('SELECT state, last_ok_ts, last_ok_entries FROM scan_access WHERE root = ? AND launch_context = ?')
    .get(root, context) as { state: string; last_ok_ts: number | null; last_ok_entries: number | null } | undefined;
}

/**
 * Upsert one probe outcome. last_ok_ts / last_ok_entries are history, not state:
 * they are written only on an `ok` pass and never clobbered by a later failure —
 * that pair is what makes coverage_degraded able to say "readable for six months,
 * denied since Tuesday" rather than only "denied now".
 */
export function recordScanAccess(db: DB, root: string, context: string, probe: ProbeResult, now: number): void {
  const lastResult =
    probe.state === 'unreadable' ? `unreadable:${probe.errno}` : probe.state;
  db.prepare(`
    INSERT INTO scan_access
      (root, launch_context, state, errno, entries, last_ok_ts, last_ok_entries, last_result, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(root, launch_context) DO UPDATE SET
      state          = excluded.state,
      errno          = excluded.errno,
      entries        = excluded.entries,
      last_ok_ts     = CASE WHEN excluded.state = 'ok' THEN excluded.last_ok_ts  ELSE scan_access.last_ok_ts END,
      last_ok_entries = CASE WHEN excluded.state = 'ok' THEN excluded.entries    ELSE scan_access.last_ok_entries END,
      last_result    = excluded.last_result,
      last_seen      = excluded.last_seen
  `).run(
    root, context, probe.state, probe.errno, probe.entries,
    probe.state === 'ok' ? now : null,
    probe.state === 'ok' ? probe.entries : null,
    lastResult, now, now,
  );
}

/** A UTC day bucket — allowed in keys (epoch bucket, not a wall-clock read). */
export const dayBucket = (ts: number): number => Math.floor(ts / 86_400_000);

/**
 * The build identity half of the coverage_degraded key. build_identity.cdhash
 * does not exist yet, so the store's own schema version stands in: it changes
 * exactly when the binary's expectations of the disk changed.
 * ponytail: schema-version stand-in; swap for build_identity.cdhash when that
 * table lands so the key tracks re-signed binaries, not schema migrations.
 */
export function buildId(db: DB): string {
  return `schema${(db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version}`;
}

export interface ProbeRoot {
  root: string;
  tool: Tool;
  label: string;
  /** 1 = a collector's own source (real spend is invisible while denied); 2 = discovery. */
  tier: 1 | 2;
  /** Files are probed with open/close (no bytes read); directories with readdir. */
  file?: boolean;
}

/** First-tier roots: the paths the collectors themselves read. */
export function tierOneRoots(): ProbeRoot[] {
  return ([
    [paths.claudeCodeProjects(), 'claude_code', 'Claude Code transcripts'],
    [paths.codexSessions(), 'codex', 'Codex rollouts'],
    [paths.geminiHome(), 'gemini', 'Gemini CLI home'],
    [paths.cursorTrackingDb(), 'cursor', 'Cursor attribution DB'],
    [paths.antigravityConversations(), 'antigravity', 'Antigravity conversations'],
    [paths.antigravityBrain(), 'antigravity', 'Antigravity brain'],
    [paths.opencodeDb(), 'opencode', 'OpenCode store'],
    [paths.grokUnifiedLog(), 'grok', 'Grok unified log', true],
    [paths.grokSessionsDir(), 'grok', 'Grok sessions'],
    [paths.devinAcpMessages(), 'devin', 'Devin ACP messages'],
    [paths.claudeConfigDir(), 'claude_code', 'Claude Code config home'],
    [paths.codexHome(), 'codex', 'Codex config home'],
  ] as [string, Tool, string, boolean?][]).map(([root, tool, label, file]) => ({ root, tool, label, tier: 1, file }));
}

/** Second-tier roots: discovery surfaces — informational, not the collectors' own spine. */
export function tierTwoRoots(): ProbeRoot[] {
  const home = homedir();
  return [
    { root: join(home, 'Desktop'), tool: 'claude_code', label: '~/Desktop', tier: 2 },
    { root: join(home, 'Documents'), tool: 'claude_code', label: '~/Documents', tier: 2 },
    { root: join(home, 'Downloads'), tool: 'claude_code', label: '~/Downloads', tier: 2 },
    { root: join(home, 'Library', 'Safari'), tool: 'claude_code', label: '~/Library/Safari', tier: 2 },
    { root: join(home, 'Library', 'Safari', 'History.db'), tool: 'claude_code', label: 'Safari History.db', tier: 2, file: true },
    { root: join(home, 'Library', 'Logs', 'Claude'), tool: 'claude_code', label: '~/Library/Logs/Claude', tier: 2 },
  ];
}

/**
 * The Full Disk Access canary (feature 11): one open() of the TCC database,
 * closed immediately — no query is ever issued, so no TCC content is read. The
 * outcome is recorded under root='tcc_canary' so the Settings chip and the
 * launch-context record have one fact to read.
 */
export const TCC_CANARY_ROOT = 'tcc_canary';

export function fdaCanary(): ProbeResult {
  // The per-user TCC db is the standard probe target; the system one needs root.
  return probeFile(join(homedir(), 'Library/Application Support/com.apple.TCC/TCC.db'));
}

/**
 * coverage_degraded (feature 22): fires on the `ok → unreadable` transition ONLY
 * — `ok → absent` is an uninstalled tool, not a degradation. Key is
 * root + build id + UTC day bucket of the first denial, all deterministic, so the
 * INSERT OR IGNORE path stays idempotent.
 */
export function degradedAnomaly(
  r: ProbeRoot,
  probe: ProbeResult,
  prev: { state: string } | undefined,
  now: number,
  build: string,
): Anomaly | null {
  if (!prev || prev.state !== 'ok' || probe.state !== 'unreadable') return null;
  return {
    anomaly_key: `access:${r.root}:${build}:${dayBucket(now)}`,
    rule: 'coverage_degraded',
    severity: r.tier === 1 ? 'critical' : 'warn',
    tool: r.tool,
    session_id: null,
    model: null,
    window_start: now,
    window_end: now,
    title: `Coverage degraded: ${r.label}`,
    detail:
      `${r.root} was readable and now reads ${probe.errno}. ` +
      `Rows behind it will read as absent — a permission fact, not an absence fact. ` +
      (r.tier === 1
        ? "First-tier root: a collector's own source path, so real spend is currently invisible."
        : 'Second-tier discovery root: inventory coverage is reduced.'),
    observed: 1,
    baseline: null,
    threshold: null,
    confidence: 'exact',
    source: 'live',
    detected_at: now,
  };
}

/**
 * One probe pass over the root table. Probes are attempted reads recorded as
 * facts; the degrade check compares against the pre-pass state so a root that
 * has been unreadable for days does not re-fire (the day bucket would make a new
 * key each day otherwise — only the *transition* creates an incident).
 */
export function runProbePass(db: DB, roots: ProbeRoot[], now: number): { probed: number; degraded: number } {
  const context = launchContext();
  let degraded = 0;
  const anomalies: Anomaly[] = [];
  const build = buildId(db);
  for (const r of roots) {
    const probe = r.file ? probeFile(r.root) : probeDir(r.root);
    const prev = readScanAccess(db, r.root, context);
    recordScanAccess(db, r.root, context, probe, now);
    const anomaly = degradedAnomaly(r, probe, prev, now, build);
    if (anomaly) {
      degraded++;
      anomalies.push(anomaly);
    }
  }
  // The FDA canary: same ledger, its own root id.
  recordScanAccess(db, TCC_CANARY_ROOT, context, fdaCanary(), now);
  if (anomalies.length) insertAnomalies(db, anomalies);
  return { probed: roots.length + 1, degraded };
}

/**
 * column_provenance (upgrade boundary, "not recorded before vX"): per column, the
 * first timestamp it was ever populated and the count of older rows that can
 * never be backfilled. The Coverage strip shades from this; the shading itself is
 * reader work. first_populated_ts is set once and never re-derived (a stored fact
 * is not overwritten); unbackfillable_rows is a live count of NULL rows older
 * than that timestamp.
 */
export function recordColumnProvenance(
  db: DB,
  now: number,
  cols: { table: string; column: string; migration: number }[],
): void {
  const prior = db
    .prepare('SELECT first_populated_ts FROM column_provenance WHERE table_name = ? AND column_name = ?');
  const insert = db.prepare(
    'INSERT INTO column_provenance (table_name, column_name, migration_version, first_populated_ts, unbackfillable_rows) VALUES (?, ?, ?, ?, 0)',
  );
  const update = db.prepare('UPDATE column_provenance SET unbackfillable_rows = ? WHERE table_name = ? AND column_name = ?');
  for (const c of cols) {
    const existing = prior.get(c.table, c.column) as { first_populated_ts: number } | undefined;
    if (!existing) {
      insert.run(c.table, c.column, c.migration, now);
      continue;
    }
    let unbackfillable = 0;
    try {
      unbackfillable = (
        db.prepare(
          `SELECT COUNT(*) AS n FROM "${c.table}" WHERE "${c.column}" IS NULL AND first_seen < ?`,
        ).get(existing.first_populated_ts) as { n: number }
      ).n;
    } catch {
      unbackfillable = 0; // table without first_seen: nothing older than the column exists
    }
    update.run(unbackfillable, c.table, c.column);
  }
}

/** The columns this scanner populates — registered once per pass, migration 20. */
const SCAN_ACCESS_COLUMNS = [
  { table: 'scan_access', column: 'root', migration: 20 },
  { table: 'scan_access', column: 'launch_context', migration: 20 },
  { table: 'scan_access', column: 'state', migration: 20 },
  { table: 'scan_access', column: 'errno', migration: 20 },
  { table: 'scan_access', column: 'entries', migration: 20 },
  { table: 'scan_access', column: 'last_ok_ts', migration: 20 },
  { table: 'scan_access', column: 'last_ok_entries', migration: 20 },
  { table: 'scan_access', column: 'last_result', migration: 20 },
];

export const scanAccessScanner: Scanner = {
  name: 'scan-access',
  cadenceMs: 5 * 60_000,
  run: () => {
    const db = openDb();
    const now = Date.now();
    const { probed, degraded } = runProbePass(db, [...tierOneRoots(), ...tierTwoRoots()], now);
    recordColumnProvenance(db, now, SCAN_ACCESS_COLUMNS);
    return {
      ok: true,
      notes:
        `${probed} attempted reads recorded` +
        (degraded ? ` · ${degraded} DEGRADED root(s) — ok→denied transition` : ''),
    };
  },
};
