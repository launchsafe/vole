import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { DB } from '../db';
import { paths } from '../paths';

/**
 * The inalienable exclusion floor for personal work on a corporate device.
 *
 * v1's monitoring-scope policy let the org set never_excludable with no floor,
 * so an employer could forbid all exclusions and the personal-project carve-out
 * that almost every works agreement contains became unenforceable in the tool.
 * The floor: any path OUTSIDE the profile's declared workRoots is always
 * excludable by the employee — the org's never_excludable list is simply
 * ignored there, by Vole's code, and cannot say otherwise. Inside the
 * workRoots the org's list binds.
 *
 * For an excluded session the org receives a COUNT only — never the project
 * path, branch, model or token totals (orgExclusionCount below is the only
 * shape the org side is allowed to call).
 *
 * Files: the org declares workRoots/neverExcludable in the managed exclude.json
 * (paths.exclusionPaths()); the employee's own list is ~/.vole/exclude.json —
 * employee-owned, never written by the collector.
 */

export interface ExclusionPolicy {
  workRoots: string[];
  neverExcludable: string[];
  source: string | null;
}

export interface EmployeeExclusions {
  paths: string[];
  source: string;
}

export function loadExclusionPolicy(files: string[] = paths.exclusionPaths()): ExclusionPolicy {
  let merged: { workRoots?: string[]; neverExcludable?: string[] } | null = null;
  let source: string | null = null;
  for (const p of files) {
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { workRoots?: string[]; neverExcludable?: string[] };
      // Later wins entirely (admin file is the baseline, user file refines) —
      // same precedence as the surface policy.
      merged = { workRoots: parsed.workRoots ?? [], neverExcludable: parsed.neverExcludable ?? [] };
      source = p;
    } catch {
      /* malformed layer: ignored, same as pricing.json */
    }
  }
  return { workRoots: merged?.workRoots ?? [], neverExcludable: merged?.neverExcludable ?? [], source };
}

/** The employee's own list. Written by the app's add/remove control, never by the collector. */
export function employeeExcludePath(home = homedir()): string {
  // ponytail: belongs in paths.ts with the other policy paths — move at integration.
  return process.env.VOLE_HOME_OVERRIDE ? join(process.env.VOLE_HOME_OVERRIDE, '.vole', 'exclude.json') : join(home, '.vole', 'exclude.json');
}

export function loadEmployeeExclusions(file = employeeExcludePath()): EmployeeExclusions {
  if (!existsSync(file)) return { paths: [], source: file };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { paths?: string[] };
    return { paths: Array.isArray(parsed.paths) ? parsed.paths : [], source: file };
  } catch {
    return { paths: [], source: file };
  }
}

/** The app's add/remove control. */
export function saveEmployeeExclusions(pathsList: string[], file = employeeExcludePath()): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ paths: pathsList }, null, 2) + '\n');
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : root + '/');
}

export function insideWorkRoots(path: string, workRoots: string[]): boolean {
  return workRoots.some((r) => under(path, r));
}

/** Is a path inside the org's never_excludable list? (Only meaningful inside workRoots — see floor.) */
function neverExcludable(path: string, never: string[]): boolean {
  return never.some((r) => under(path, r));
}

export type ExclusionBand = 'work' | 'personal' | 'unknown';

export interface ExclusionOutcome {
  excluded: boolean;
  band: ExclusionBand;
  basis: string;
}

/**
 * The floor, in one function. A project with no path (NULL) is 'unknown' —
 * never silently classified either way; those rows are released to the org
 * only as aggregates.
 */
export function exclusionOutcome(
  project: string | null,
  policy: ExclusionPolicy,
  employee: EmployeeExclusions,
): ExclusionOutcome {
  if (!project) return { excluded: false, band: 'unknown', basis: 'no project path recorded — cannot be classified either way' };
  const inWork = insideWorkRoots(project, policy.workRoots);
  if (!inWork) {
    // The floor: outside every declared work root the employee always wins.
    const excluded = employee.paths.some((p) => under(project, p));
    return {
      excluded,
      band: 'personal',
      basis: excluded
        ? 'outside all declared work roots — employee-excluded (inalienable floor)'
        : 'outside all declared work roots — always excludable by the employee, not currently excluded',
    };
  }
  const excluded = employee.paths.some((p) => under(project, p)) && !neverExcludable(project, policy.neverExcludable);
  return {
    excluded,
    band: 'work',
    basis: excluded
      ? 'inside a declared work root, not on the never-excludable list — employee-excluded'
      : neverExcludable(project, policy.neverExcludable)
        ? 'inside a declared work root and never-excludable — the org binds this path'
        : 'inside a declared work root — excludable unless the org pins it',
  };
}

/**
 * Filter rows by the exclusion rules. Counted, never silent: the excluded
 * count comes back even when the caller keeps only the survivors.
 */
export function applyExclusions<T extends { project: string | null }>(
  rows: T[],
  policy: ExclusionPolicy,
  employee: EmployeeExclusions,
): { kept: T[]; excludedCount: number; bands: Record<ExclusionBand, number> } {
  const kept: T[] = [];
  let excludedCount = 0;
  const bands: Record<ExclusionBand, number> = { work: 0, personal: 0, unknown: 0 };
  for (const r of rows) {
    const o = exclusionOutcome(r.project, policy, employee);
    bands[o.band]++;
    if (o.excluded) excludedCount++;
    else kept.push(r);
  }
  return { kept, excludedCount, bands };
}

/**
 * The only shape the org receives for excluded work: a COUNT of excluded
 * sessions in the window — never the path, branch, model or token totals.
 * Returns sessions whose project matches an employee exclusion under the floor.
 */
export function orgExclusionCount(db: DB, sinceTs: number, files: { policy?: string[]; employee?: string }): number {
  const policy = loadExclusionPolicy(files.policy);
  const employee = loadEmployeeExclusions(files.employee);
  const projects = db
    .prepare('SELECT DISTINCT project FROM usage_events WHERE project IS NOT NULL AND source = \'live\'')
    .all() as { project: string }[];
  const excludedProjects = new Set(projects.map((p) => p.project).filter((p) => exclusionOutcome(p, policy, employee).excluded));
  if (excludedProjects.size === 0) return 0;
  const placeholders = [...excludedProjects].map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT session_id) AS n FROM usage_events
       WHERE source = 'live' AND session_id IS NOT NULL AND ts >= ? AND project IN (${placeholders})`,
    )
    .get(sinceTs, ...excludedProjects) as { n: number };
  return row.n;
}

/** The same count the org sees, shown to the employee in Privacy Center. */
export function excludedSessionsThisMonth(db: DB, now = Date.now(), files: { policy?: string[]; employee?: string } = {}): number {
  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  return orgExclusionCount(db, monthStart.getTime(), files);
}
