import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { DB } from '../db';
import type { Anomaly } from '../types';
import { dayBucket, sha256hex } from './util';

/**
 * work_roots: the root registry (tier 6 §50).
 *
 * Discovery-only — built from evidence Vole already holds (distinct
 * usage_events.project values), never a filesystem crawl. Each candidate cwd
 * is resolved upward to the nearest ancestor holding a `.git` entry (dir OR
 * gitdir-pointer file): that ancestor is root_kind='git_repo'. With no `.git`
 * ancestor the cwd itself is the root, root_kind='work_dir'. $HOME and the
 * enumerated system-path list are never roots by construction.
 */

export type RootKind = 'git_repo' | 'work_dir';

/** ponytail: system-path list is macOS-shaped; extend per-OS when Vole ships off darwin. */
const NEVER_ROOT_PREFIXES = [
  '/System', '/Library', '/private', '/usr', '/bin', '/sbin', '/etc', '/var', '/opt', '/Applications',
];

export function isNeverRoot(p: string): boolean {
  if (p === '/' || p === homedir()) return true;
  return NEVER_ROOT_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`));
}

export interface WorkRoot {
  rootPath: string;
  rootKind: RootKind;
}

/** Resolve a cwd to its work root by walking ancestors for a `.git` entry. */
export function resolveWorkRoot(cwd: string, exists: (p: string) => boolean = existsSync): WorkRoot | null {
  if (!cwd || !isAbsolute(cwd)) return null;
  if (isNeverRoot(cwd)) return null;
  let cur = cwd;
  for (;;) {
    if (exists(join(cur, '.git'))) return { rootPath: cur, rootKind: 'git_repo' };
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // No .git ancestor: the cwd is the root, unless it sits in never-root land.
  if (isNeverRoot(dirname(cwd)) && isNeverRoot(cwd)) return null;
  return { rootPath: cwd, rootKind: 'work_dir' };
}

// ── origin slug from .git/config ────────────────────────────────────────────

/** Minimal git-config section parser: `[remote "origin"] url = ...`. */
export function parseGitConfigOrigin(text: string): string | null {
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[\s*(\w+)(?:\s+"([^"]*)")?\s*\]$/.exec(line);
    if (sec) {
      section = sec[1] === 'remote' && sec[2] ? `remote:${sec[2]}` : sec[1]!;
      continue;
    }
    const kv = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(line);
    if (kv && section === 'remote:origin' && kv[1]!.toLowerCase() === 'url') {
      const v = kv[2]!.trim().replace(/^"|"$/g, '');
      if (v) return v;
    }
  }
  return null;
}

/**
 * Normalise a remote URL to `host/owner/repo` (the origin slug). ssh
 * `git@host:owner/repo.git`, `ssh://`, `https://` (credentials stripped),
 * `.git` and trailing slashes dropped. file:// and bare paths yield NULL —
 * a local-only remote has no distribution and the blast radius is unknown,
 * never one (spec §15 limit).
 */
export function originSlug(url: string | null): string | null {
  if (!url) return null;
  let u = url.trim();
  if (/^file:|^\/|^\.\//.test(u)) return null;
  if (u.startsWith('git@')) u = `ssh://${u.replace(':', '/')}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = `https://${u}`;
  try {
    const parsed = new URL(u);
    if (!/^ssh|https?|git$/.test(parsed.protocol.replace(':', ''))) return null;
    const host = parsed.host.toLowerCase();
    const parts = parsed.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean);
    if (!host || parts.length === 0) return null;
    return [host, ...parts.map((p) => p.toLowerCase())].join('/');
  } catch {
    return null;
  }
}

/** Read the origin slug for a git work root, or NULL (no .git / no remote / unreadable). */
export function readOriginSlug(rootPath: string): string | null {
  const git = join(rootPath, '.git');
  try {
    const st = statSync(git);
    if (st.isDirectory()) return originSlug(parseGitConfigOrigin(readFileSync(join(git, 'config'), 'utf8')));
    if (st.isFile()) {
      const text = readFileSync(git, 'utf8');
      const m = /^gitdir:\s*(\S+)/m.exec(text);
      if (m) return originSlug(parseGitConfigOrigin(readFileSync(join(m[1]!, 'config'), 'utf8')));
    }
  } catch {
    /* unreadable: NULL is the honest unknown */
  }
  return null;
}

// ── the registry sync + tombstones (spec §50, §54) ──────────────────────────

export interface RootCandidate {
  cwd: string;
  /** where the evidence came from — the registry is a lower bound, label it */
  evidence: 'usage_project';
}

/** Candidate cwds from evidence already in the store. No filesystem crawl. */
export function rootCandidatesFromDb(db: DB): RootCandidate[] {
  const rows = db
    .prepare(`SELECT DISTINCT project FROM usage_events WHERE project IS NOT NULL AND project != ''`)
    .all() as { project: string }[];
  // ponytail: usage_events.project consolidates every collector's cwd; the
  // codex state_5.sqlite project_roots and ~/.claude.json githubRepoPaths
  // surfaces add roots no session ran in — wire them when a "roots without
  // evidence" lane is wanted (they inflate the known denominator).
  return rows.map((r) => ({ cwd: r.project, evidence: 'usage_project' }));
}

export interface RootSyncResult {
  discovered: string[];
  tombstoned: string[];
  reappeared: string[];
}

/**
 * Upsert the registry. Idempotent: keys on root_path, no now()-derived keys.
 * Tombstone (§54): when a known root stops resolving, exists_now=0 and
 * disappeared_at is stamped ONCE (a later poll must not move it); a root that
 * reappears flips exists_now back to 1 but keeps its disappearance date as
 * history. Frozen-hash freezing of repo_artifacts rows is the integrator's
 * read of `tombstoned` (repo_artifacts carries no verifiable column yet —
 * flagged as a foundation gap).
 */
export function syncWorkRoots(
  db: DB,
  now: number,
  exists: (p: string) => boolean = existsSync,
  candidates: RootCandidate[] | null = null,
): RootSyncResult {
  const out: RootSyncResult = { discovered: [], tombstoned: [], reappeared: [] };
  const insert = db.prepare(
    `INSERT INTO work_roots (root_path, origin_slug, exists_now, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const sel = db.prepare(`SELECT root_id, exists_now, origin_slug FROM work_roots WHERE root_path = ?`);
  const markPresent = db.prepare(`UPDATE work_roots SET exists_now = 1, last_seen = ?, origin_slug = COALESCE(origin_slug, ?) WHERE root_path = ?`);
  const markGone = db.prepare(`UPDATE work_roots SET exists_now = 0, disappeared_at = ?, last_seen = last_seen WHERE root_path = ?`);
  for (const c of candidates ?? rootCandidatesFromDb(db)) {
    const root = resolveWorkRoot(c.cwd, exists);
    if (!root) continue;
    const present = exists(root.rootPath);
    const row = sel.get(root.rootPath) as { root_id: number; exists_now: number | null; origin_slug: string | null } | undefined;
    const slug = root.rootKind === 'git_repo' ? readOriginSlug(root.rootPath) : null;
    if (!row) {
      insert.run(root.rootPath, slug, present ? 1 : 0, now, now);
      if (present) out.discovered.push(root.rootPath);
      continue;
    }
    if (present) {
      markPresent.run(now, slug, root.rootPath);
      if (row.exists_now === 0) out.reappeared.push(root.rootPath);
    } else if (row.exists_now === 1) {
      markGone.run(now, root.rootPath);
      out.tombstoned.push(root.rootPath);
    }
    // exists_now already 0 and still gone: nothing moves (disappeared_at frozen).
  }
  return out;
}

/** root_not_present (§54): info severity, once per root per disappearance day. */
export function detectRootNotPresent(db: DB, now: number): Anomaly[] {
  const rows = db
    .prepare(`SELECT root_path, COALESCE(disappeared_at, first_seen) AS since FROM work_roots WHERE exists_now = 0`)
    .all() as { root_path: string; since: number }[];
  return rows.map((r) => ({
    anomaly_key: `root_not_present:${sha256hex(r.root_path)}:${dayBucket(r.since)}`,
    rule: 'root_not_present' as const,
    severity: 'info' as const,
    tool: 'claude_code' as const,
    session_id: null,
    model: null,
    window_start: r.since,
    window_end: r.since,
    title: `Work root no longer on disk: ${r.root_path}`,
    detail:
      `A known agent work root stopped resolving on disk (unmounted volume, renamed directory or a ` +
      `container-only path are all possible — gone is not deleted). Its frozen artifact hashes are the ` +
      `last verifiable state, preserved as of ${new Date(r.since).toISOString()}.`,
    observed: 1,
    baseline: null,
    threshold: null,
    confidence: 'exact' as const,
    source: 'live' as const,
    detected_at: now,
  }));
}

// ── Repos band (spec §8): counts + the printed denominator sentence ─────────

export interface ReposBandRoot {
  root_path: string;
  origin_slug: string | null;
  exists_now: number | null;
  disappeared_at: number | null;
  first_seen: number;
  last_seen: number;
  artifacts: number;
  last_artifact_seen: number | null;
  bytes_last_pass: number | null;
  last_scan_at: number | null;
}

export interface ReposBand {
  roots: ReposBandRoot[];
  known: number;
  present: number;
  gone: number;
  readable: number;
  /** printed next to every figure — the denominator sentence from spec §8 */
  sentence: string;
}

/**
 * The Repos band data. `known` is a LOWER BOUND (roots that produced agent
 * evidence only) and the sentence says so rather than presenting a repo
 * inventory. Every count is a real query; a root with no artifacts renders
 * 'none of the declared paths present', never a bare zero meaning "scanned".
 */
export function reposBand(db: DB): ReposBand {
  const roots = db
    .prepare(
      `SELECT w.root_path, w.origin_slug, w.exists_now, w.disappeared_at, w.first_seen, w.last_seen,
              (SELECT COUNT(*) FROM repo_artifacts a WHERE a.root_path = w.root_path) AS artifacts,
              (SELECT MAX(a.last_seen) FROM repo_artifacts a WHERE a.root_path = w.root_path) AS last_artifact_seen,
              s.bytes_scanned AS bytes_last_pass, s.last_scan_at
       FROM work_roots w LEFT JOIN repo_scan_state s ON s.root_path = w.root_path
       ORDER BY w.last_seen DESC`,
    )
    .all() as ReposBandRoot[];
  const known = roots.length;
  const present = roots.filter((r) => r.exists_now === 1).length;
  const gone = roots.filter((r) => r.exists_now === 0).length;
  const readable = roots.filter((r) => r.exists_now === 1 && r.last_scan_at !== null).length;
  const covered = roots.filter((r) => r.artifacts > 0).length;
  const lastGone = roots
    .filter((r) => r.exists_now === 0)
    .map((r) => Math.max(r.disappeared_at ?? 0, r.last_artifact_seen ?? 0))
    .filter((t) => t > 0)
    .sort((a, b) => b - a)[0];
  const parts: string[] = [
    `artifact findings cover ${covered} readable roots of ${known} known`,
  ];
  if (gone > 0) {
    parts.push(
      `${gone} roots are not present on disk and their last-known state is from ` +
        (lastGone ? new Date(lastGone).toISOString().slice(0, 10) : 'an unknown date'),
    );
  }
  parts.push('the registry is a lower bound: roots no agent ran in are invisible');
  return { roots, known, present, gone, readable, sentence: `${parts.join('; ')}.` };
}
