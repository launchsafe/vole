/**
 * Health checks behind `vole doctor`.
 *
 * The question this answers is narrower and more useful than "is Vole running": it is
 * *"is any source lying to me by omission?"* A collector whose parser still works
 * against a tool that has changed what it writes looks identical to a healthy one — it
 * reports success, inserts rows, and the number it produces simply stops growing. That
 * failure is invisible by construction, and it has already happened once in this
 * product: Cursor stopped recording token counts in April 2026 and nothing said so.
 *
 * So the checks are grounded in what the collector already records (`collector_runs`,
 * `collector_state`) plus one derived signal — the age of the newest MEASURED row per
 * tool, which is what catches silent drift.
 */
import { existsSync, statSync } from 'node:fs';
import { paths } from './paths';
import { LATEST_MIGRATION, type DB } from './db';
import type { Tool } from './types';

export type HealthLevel = 'ok' | 'warn' | 'fail';

/** A tool that has produced no measured token in this long, while still being read. */
export const STALE_AFTER_DAYS = 30;

export interface ToolHealth {
  tool: Tool;
  level: HealthLevel;
  /** One-line verdict, written for a human scanning a list. */
  verdict: string;
  sourcePath: string;
  sourceExists: boolean;
  installed: boolean;
  rows: number;
  newestRowMs: number | null;
  newestMeasuredMs: number | null;
  staleDays: number | null;
  lastRunOk: boolean | null;
  lastRunNote: string | null;
}

/** Where each collector looks. Kept here so doctor reports the same path the collector reads. */
export function sourcePathFor(tool: Tool): string {
  switch (tool) {
    case 'claude_code': return paths.claudeCodeProjects();
    case 'codex': return paths.codexSessions();
    case 'cursor': return paths.cursorStateDb();
    case 'opencode': return paths.opencodeDb();
    case 'grok': return paths.grokUnifiedLog();
    case 'devin': return paths.devinAcpMessages();
    case 'antigravity': return paths.antigravityBrain();
  }
}

const TOOLS: Tool[] = ['claude_code', 'codex', 'cursor', 'opencode', 'grok', 'devin', 'antigravity'];

interface RunRow { tool: string; ok: number; source_state: string | null; notes: string | null; started_at: number }
interface StatRow { tool: string; rows: number; newest: number | null; newest_measured: number | null }

export function checkTools(db: DB, now: number = Date.now()): ToolHealth[] {
  const stats = new Map<string, StatRow>();
  for (const r of db
    .prepare(
      `SELECT tool, COUNT(*) AS rows, MAX(ts) AS newest,
              MAX(CASE WHEN total_tokens IS NOT NULL THEN ts END) AS newest_measured
         FROM usage_events WHERE source = 'live' GROUP BY tool`,
    )
    .all() as StatRow[]) stats.set(r.tool, r);

  const runs = new Map<string, RunRow>();
  for (const r of db
    .prepare(
      `SELECT tool, ok, source_state, notes, started_at FROM collector_runs
        WHERE id IN (SELECT MAX(id) FROM collector_runs GROUP BY tool)`,
    )
    .all() as RunRow[]) runs.set(r.tool, r);

  return TOOLS.map((tool) => {
    const p = sourcePathFor(tool);
    const exists = existsSync(p);
    const st = stats.get(tool);
    const run = runs.get(tool);
    const rows = st?.rows ?? 0;
    const newestRowMs = st?.newest ?? null;
    const newestMeasuredMs = st?.newest_measured ?? null;
    const staleDays =
      newestMeasuredMs !== null ? Math.floor((now - newestMeasuredMs) / 86_400_000) : null;

    let level: HealthLevel = 'ok';
    let verdict: string;

    if (!exists) {
      // Not installed is not a fault. Reporting it as one trains people to ignore the
      // whole list, which is how a real failure gets missed.
      level = 'ok';
      verdict = rows > 0 ? `not installed here — ${fmt(rows)} historical row(s) kept` : 'not installed';
    } else if (run && run.ok === 0) {
      level = 'fail';
      verdict = `last pass failed — ${run.notes ?? 'no detail recorded'}`;
    } else if (rows === 0) {
      level = 'warn';
      verdict = 'source is present but nothing has been parsed from it';
    } else if (newestMeasuredMs === null) {
      level = 'warn';
      verdict = `${fmt(rows)} row(s), none with token counts — activity only`;
    } else if (staleDays !== null && staleDays >= STALE_AFTER_DAYS) {
      // The silent-drift case: still being read, still inserting, no measurement.
      level = 'warn';
      const recent = newestRowMs !== null && now - newestRowMs < STALE_AFTER_DAYS * 86_400_000;
      verdict = recent
        ? `still active, but no token counts for ${staleDays} days — the tool may have stopped recording them`
        : `quiet for ${staleDays} days`;
    } else {
      verdict = `${fmt(rows)} row(s), newest measurement ${staleDays}d old`;
    }

    return {
      tool, level, verdict, sourcePath: p, sourceExists: exists, installed: exists,
      rows, newestRowMs, newestMeasuredMs, staleDays,
      lastRunOk: run ? run.ok === 1 : null,
      lastRunNote: run?.notes ?? null,
    };
  });
}

export interface StoreHealth {
  level: HealthLevel;
  verdict: string;
  integrity: string;
  schemaVersion: number;
  knownVersion: number;
  rows: number;
  sizeBytes: number | null;
  path: string;
}

export function checkStore(db: DB, dbPath: string = paths.db()): StoreHealth {
  let integrity = 'unknown';
  try {
    const r = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
    integrity = r?.integrity_check ?? 'unknown';
  } catch (err) {
    integrity = `unreadable: ${(err as Error).message}`;
  }
  const version =
    (db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined)?.user_version ?? 0;
  const rows =
    (db.prepare('SELECT COUNT(*) AS c FROM usage_events').get() as { c: number } | undefined)?.c ?? 0;
  let sizeBytes: number | null = null;
  try { sizeBytes = statSync(dbPath).size; } catch { /* store may be elsewhere */ }

  let level: HealthLevel = 'ok';
  let verdict = `schema ${version}, ${fmt(rows)} row(s)`;
  if (integrity !== 'ok') {
    level = 'fail';
    verdict = `integrity check says "${integrity}"`;
  } else if (version > LATEST_MIGRATION) {
    // Written by a newer Vole. The collector refuses such a store outright; say why.
    level = 'fail';
    verdict = `schema ${version} was written by a newer Vole (this one knows ${LATEST_MIGRATION})`;
  } else if (version < LATEST_MIGRATION) {
    level = 'warn';
    verdict = `schema ${version}; ${LATEST_MIGRATION} available — run the collector once to migrate`;
  }

  return { level, verdict, integrity, schemaVersion: version, knownVersion: LATEST_MIGRATION, rows, sizeBytes, path: dbPath };
}

/** The worst level present, which is what an exit code should reflect. */
export function worstLevel(levels: HealthLevel[]): HealthLevel {
  if (levels.includes('fail')) return 'fail';
  if (levels.includes('warn')) return 'warn';
  return 'ok';
}

const fmt = (n: number) => n.toLocaleString('en-US');
