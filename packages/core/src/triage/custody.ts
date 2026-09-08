/**
 * Tier 7 custody: the derived coverage figures every export, evidence
 * bundle, DSAR answer and control-framework mapping must carry.
 *
 * EVIDENCE GAPS are derived, never asserted: collector_runs sorted by
 * started_at, any interval longer than 3x the effective poll interval is a
 * candidate, and activity inside the interval is counted only from
 * witnesses that need no Vole run at all (the agents' own clocks —
 * history.jsonl timestamps, PID-session startedAt, Codex's session index,
 * collector_state.last_mtime). A gap with no witness stays silent and
 * renders as 'unobserved, no activity witness' — a closed laptop is not
 * tampering and must never be scored as such.
 *
 * WITNESS ORPHANS: session ids seen by a survivor artifact (Claude's
 * history.jsonl) left-anti-joined against the transcripts on disk AND
 * usage_events, classified pruned / deleted / never_ingested.
 *
 * THE CUSTODY SENTENCE renders the figures as one sentence — and it is a
 * coverage statement, not an innocence statement: a fully covered period
 * can still be one in which the subject worked on another machine.
 */
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DB } from '../db';
import { paths } from '../paths';
import { clockSuspects } from '../clock';

// Local witness-path constants; paths.ts integration should adopt these.
export function claudeHistoryPath(): string {
  return process.env.VOLE_CLAUDE_HISTORY ?? join(paths.claudeConfigDir(), 'history.jsonl');
}
export function codexSessionIndexPath(): string {
  return process.env.VOLE_CODEX_SESSION_INDEX ?? join(paths.codexHome(), 'session_index.jsonl');
}

// ── Evidence gaps ─────────────────────────────────────────────────────────────

export interface EvidenceGap {
  start: number;
  end: number;
  minutes: number;
  /** Activity timestamps found inside the gap, by witness artifact. */
  witnesses: Record<string, number>;
  activity_count: number;
}

export interface WitnessTimestamps {
  history_jsonl: number[];
  pid_sessions: number[];
  codex_session_index: number[];
  collector_state_mtime: number[];
  usage_events_ts: number[];
}

/**
 * Witness activity timestamps. Every witness needs no Vole run to have been
 * written — that is the whole point: the agents' own clocks.
 */
export function collectWitnessTimestamps(db: DB): WitnessTimestamps {
  const history: number[] = [];
  if (existsSync(claudeHistoryPath())) {
    try {
      for (const line of readFileSync(claudeHistoryPath(), 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as { timestamp?: string | number };
          if (e.timestamp !== undefined) {
            const t = typeof e.timestamp === 'number' ? e.timestamp : Date.parse(e.timestamp);
            if (!Number.isNaN(t)) history.push(t);
          }
        } catch { /* one bad line never invalidates the file */ }
      }
    } catch { /* unreadable */ }
  }
  const pid: number[] = [];
  const sessionsDir = join(paths.claudeConfigDir(), 'sessions');
  if (existsSync(sessionsDir)) {
    try {
      for (const f of readdirSync(sessionsDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const d = JSON.parse(readFileSync(join(sessionsDir, f), 'utf8')) as { startedAt?: number };
          if (typeof d.startedAt === 'number') pid.push(d.startedAt);
        } catch { /* skip */ }
      }
    } catch { /* unreadable dir */ }
  }
  const codex: number[] = [];
  if (existsSync(codexSessionIndexPath())) {
    try {
      for (const line of readFileSync(codexSessionIndexPath(), 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as { updated_at?: number };
          if (typeof e.updated_at === 'number') codex.push(e.updated_at);
        } catch { /* skip */ }
      }
    } catch { /* unreadable */ }
  }
  const mtime = (
    db.prepare('SELECT last_mtime FROM collector_state WHERE last_mtime IS NOT NULL').all() as { last_mtime: number }[]
  ).map((r) => r.last_mtime);
  const usage = (
    db.prepare('SELECT ts FROM usage_events').all() as { ts: number }[]
  ).map((r) => r.ts);
  return { history_jsonl: history, pid_sessions: pid, codex_session_index: codex, collector_state_mtime: mtime, usage_events_ts: usage };
}

/**
 * Derives the unmonitored intervals. Runs are covered intervals
 * [started_at, started_at + duration_ms]; the gap between the end of one
 * and the start of the next, when longer than 3x the effective poll
 * interval, is a candidate gap. The effective interval is the median
 * spacing of the runs themselves — what the machine actually did, not what
 * the config claims.
 */
export function deriveEvidenceGaps(
  runs: { started_at: number; duration_ms: number }[],
  witnesses: WitnessTimestamps,
): EvidenceGap[] {
  const sorted = runs.slice().sort((a, b) => a.started_at - b.started_at);
  if (sorted.length < 2) return [];
  const spacings: number[] = [];
  for (let i = 1; i < sorted.length; i++) spacings.push(sorted[i]!.started_at - sorted[i - 1]!.started_at);
  spacings.sort((a, b) => a - b);
  const effective = spacings[spacings.length >> 1] ?? 5000;
  const allWitness: [string, number[]][] = Object.entries(witnesses);

  const gaps: EvidenceGap[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1]!.started_at + sorted[i - 1]!.duration_ms;
    const start = Math.max(prevEnd, sorted[i - 1]!.started_at);
    const end = sorted[i]!.started_at;
    if (end - start <= 3 * effective) continue;
    const w: Record<string, number> = {};
    let activity = 0;
    for (const [name, ts] of allWitness) {
      const n = ts.filter((t) => t >= start && t <= end).length;
      if (n > 0) { w[name] = n; activity += n; }
    }
    gaps.push({ start, end, minutes: (end - start) / 60000, witnesses: w, activity_count: activity });
  }
  return gaps;
}

// ── Witness orphans ───────────────────────────────────────────────────────────

export type OrphanClass = 'pruned' | 'deleted' | 'never_ingested';

export interface OrphanSession {
  session_key: string;
  tool: string;
  session_id: string;
  /** which witness saw it, and when */
  evidence: string;
  classification: OrphanClass;
}

/** Claude Code's own retention horizon, in ms. Unset config = tool default 30d. */
export const CLAUDE_CLEANUP_DEFAULT_DAYS = 30;

function transcriptsOnDisk(): Set<string> {
  const out = new Set<string>();
  const root = paths.claudeCodeProjects();
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (f.endsWith('.jsonl')) out.add(f.replace(/\.jsonl$/, ''));
    }
  };
  try { walk(root); } catch { /* unreadable */ }
  return out;
}

/**
 * The left-anti-join: every session id a survivor artifact (history.jsonl)
 * saw, minus the transcripts on disk. Three outcomes for the transcript-less:
 *  - never_ingested: no usage_events row either — Vole never saw it, and no
 *    raw_ref can ever point at it.
 *  - pruned: Vole has the rows, and the witness timestamp is OUTSIDE the
 *    tool's retention window — the tool's own housekeeping, not a finding.
 *  - deleted: Vole has the rows, but the witness timestamp is INSIDE the
 *    retention window — something removed the transcript early.
 *
 * ponytail: uses history.jsonl alone as the witness (the spec also names
 * ~/.claude.json projects[].lastSessionId, which only keeps the LAST session
 * per project — adding it changes counts marginally, not classifications).
 */
export function classifyOrphans(
  db: DB,
  history: { sessionId: string; timestamp: number; project?: string }[],
  opts: { now?: number; retentionDays?: number } = {},
): OrphanSession[] {
  const now = opts.now ?? Date.now();
  const retentionMs = (opts.retentionDays ?? CLAUDE_CLEANUP_DEFAULT_DAYS) * 86400000;
  const onDisk = transcriptsOnDisk();
  const ingested = new Set(
    (db.prepare('SELECT DISTINCT session_id FROM usage_events WHERE session_id IS NOT NULL').all() as { session_id: string }[])
      .map((r) => r.session_id),
  );
  const out: OrphanSession[] = [];
  for (const h of history) {
    if (onDisk.has(h.sessionId)) continue;
    const sawIt = `history.jsonl@${new Date(h.timestamp).toISOString()}`;
    let classification: OrphanClass;
    if (!ingested.has(h.sessionId)) {
      classification = 'never_ingested';
    } else if (now - h.timestamp > retentionMs) {
      classification = 'pruned';
    } else {
      classification = 'deleted';
    }
    out.push({
      session_key: `claude_code:${h.sessionId}`,
      tool: 'claude_code',
      session_id: h.sessionId,
      evidence: sawIt,
      classification,
    });
  }
  return out;
}

/** Reads history.jsonl witnesses. One line = one session sighting. */
export function readClaudeHistory(): { sessionId: string; timestamp: number; project?: string }[] {
  const out: { sessionId: string; timestamp: number; project?: string }[] = [];
  if (!existsSync(claudeHistoryPath())) return out;
  try {
    for (const line of readFileSync(claudeHistoryPath(), 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as { sessionId?: string; timestamp?: string | number; project?: string };
        if (!e.sessionId || e.timestamp === undefined) continue;
        const t = typeof e.timestamp === 'number' ? e.timestamp : Date.parse(e.timestamp);
        if (Number.isNaN(t)) continue;
        out.push({ sessionId: e.sessionId, timestamp: t, project: e.project });
      } catch { /* skip line */ }
    }
  } catch { /* unreadable */ }
  return out;
}

/** Upserts the orphan census. Idempotent on session_key; classification is re-derived each pass. */
export function recordOrphans(db: DB, orphans: OrphanSession[], now: number = Date.now()): number {
  const up = db.prepare(
    `INSERT INTO orphan_sessions (session_key, tool, session_id, evidence, classification, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_key) DO UPDATE SET
       classification = excluded.classification,
       evidence = excluded.evidence,
       last_seen = excluded.last_seen`,
  );
  let n = 0;
  for (const o of orphans) {
    n += up.run(o.session_key, o.tool, o.session_id, o.evidence, o.classification, now, now).changes;
  }
  return n;
}

// ── The custody figures and the sentence ──────────────────────────────────────

export interface CustodyFigures {
  window_start: number;
  window_end: number;
  /** run-covered milliseconds over window milliseconds */
  covered_ms: number;
  window_ms: number;
  coverage_pct: number | null;
  gap_count: number;
  gap_minutes_total: number;
  gaps_with_activity: number;
  /** sources whose chained prefix digest no longer matches the file on disk */
  sources_digest_broken: number;
  clock_suspect_count: number;
  orphan_sessions_overlapping: number;
}

/**
 * A chained-digest break: the file's first 4 KiB no longer hashes to the
 * stored head_sha256 — the O(1) per-poll probe the coverage strip shields.
 * Only sources that carry a head digest are checkable; the rest are unknown,
 * never counted as clean.
 */
export function countDigestBreaks(db: DB): number {
  const rows = db
    .prepare('SELECT source_path, head_sha256 FROM collector_state WHERE head_sha256 IS NOT NULL')
    .all() as { source_path: string; head_sha256: string }[];
  let broken = 0;
  for (const r of rows) {
    const fd = openSync(r.source_path, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, 4096, 0);
      if (createHash('sha256').update(buf.subarray(0, n)).digest('hex') !== r.head_sha256) broken++;
    } catch {
      broken++; // unreadable where a digest once was: the file was replaced
    } finally {
      closeSync(fd);
    }
  }
  return broken;
}

/**
 * The five mechanisms joined to a bundle's own window. Coverage is computed
 * from the runs actually recorded — before the first run there is 'no run
 * record', not 'monitored', so coverage_pct is NULL when no run overlaps
 * the window at all.
 */
export function custodyFigures(
  db: DB,
  window_start: number,
  window_end: number,
  opts: { gaps?: EvidenceGap[] } = {},
): CustodyFigures {
  const runs = db
    .prepare('SELECT started_at, duration_ms FROM collector_runs WHERE started_at <= ? AND started_at + duration_ms >= ?')
    .all(window_end, window_start) as { started_at: number; duration_ms: number }[];
  const allRuns = db
    .prepare('SELECT id, started_at, duration_ms, wall_ms, boot_epoch FROM collector_runs')
    .all() as { id: number; started_at: number; duration_ms: number; wall_ms: number | null; boot_epoch: number | null }[];
  const gaps = opts.gaps ?? deriveEvidenceGaps(
    allRuns.map((r) => ({ started_at: r.started_at, duration_ms: r.duration_ms })),
    collectWitnessTimestamps(db),
  );
  const window_ms = window_end - window_start;
  // Covered = the union of run intervals clipped to the window (merge, no
  // double count of overlapping runs from concurrent collectors).
  const clipped = runs
    .map((r) => ({
      s: Math.max(r.started_at, window_start),
      e: Math.min(r.started_at + r.duration_ms, window_end),
    }))
    .filter((r) => r.e > r.s)
    .sort((a, b) => a.s - b.s);
  let covered = 0;
  let curE = -Infinity;
  for (const r of clipped) {
    if (r.s > curE) { covered += r.e - r.s; curE = r.e; }
    else if (r.e > curE) { covered += r.e - curE; curE = r.e; }
  }

  const inWindow = gaps.filter((g) => g.end > window_start && g.start < window_end);
  const broken = countDigestBreaks(db);
  const suspects = clockSuspects(
    allRuns.map((r) => ({ id: r.id, started_at: r.started_at, wall_ms: r.wall_ms, boot_epoch: r.boot_epoch })),
  ).length;
  const orphans = (db.prepare('SELECT first_seen, last_seen FROM orphan_sessions').all() as { first_seen: number; last_seen: number }[])
    .filter((o) => o.last_seen >= window_start && o.first_seen <= window_end).length;

  return {
    window_start,
    window_end,
    covered_ms: covered,
    window_ms,
    coverage_pct: runs.length > 0 ? (covered / window_ms) * 100 : null,
    gap_count: inWindow.length,
    gap_minutes_total: inWindow.reduce((s, g) => s + g.minutes, 0),
    gaps_with_activity: inWindow.filter((g) => g.activity_count > 0).length,
    sources_digest_broken: broken,
    clock_suspect_count: suspects,
    orphan_sessions_overlapping: orphans,
  };
}

/**
 * The sentence, carrying the actual figures — and saying in its own words
 * that it is a coverage statement, not an innocence statement.
 */
export function custodySentence(f: CustodyFigures): string {
  const pct = f.coverage_pct === null ? 'no run record' : `${f.coverage_pct.toFixed(1)}%`;
  return [
    `Monitored ${pct} of ${new Date(f.window_start).toISOString().slice(0, 10)} to ${new Date(f.window_end).toISOString().slice(0, 10)}.`,
    `${f.gap_count} unmonitored interval(s) (${Math.round(f.gap_minutes_total)} min total, ${f.gaps_with_activity} with agent activity).`,
    f.sources_digest_broken > 0 ? `${f.sources_digest_broken} source(s) with a chained digest recorded.` : '',
    f.clock_suspect_count > 0 ? `${f.clock_suspect_count} run stamp(s) recorded under a suspect clock.` : '',
    'This is a coverage statement, not an innocence statement.',
  ].filter(Boolean).join(' ');
}

/** Convenience: figures + sentence straight from the store for the last N days. */
export function custodyForWindow(db: DB, days: number, now: number = Date.now()): { figures: CustodyFigures; sentence: string } {
  const figures = custodyFigures(db, now - days * 86400000, now);
  return { figures, sentence: custodySentence(figures) };
}
