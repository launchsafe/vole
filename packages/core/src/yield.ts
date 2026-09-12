/**
 * Yield tracking — did a session's spend produce anything?
 *
 * A session is correlated with commits landing in its repository inside its own time
 * window. Spend with no commit behind it is not automatically waste (research, reading,
 * a conversation that informed work committed days later), which is why the vocabulary
 * here is `abandoned` rather than "wasted" and why `unclear` is a first-class answer
 * rather than a rounding of the other two.
 *
 * This is the primitive `vole optimize` reuses to find high-cost sessions with nothing
 * to show; the correlation must not be re-implemented there.
 *
 * The attribution is a heuristic and says so: a commit inside the window is evidence,
 * not proof, that this session caused it. Two agents working the same repo at the same
 * time will both be credited for the same commit. That is a deliberate false-positive
 * bias — over-crediting a session is a far cheaper error than telling someone their
 * work was abandoned when it was not.
 */
import { commitTimesMs, repoRoot } from './util/git';
import type { DB } from './db';

export type YieldStatus = 'committed' | 'abandoned' | 'unclear';

/**
 * How long after a session's last call a commit still counts as its output. Agents
 * routinely stop, and the person reviews and commits a few minutes later.
 */
export const DEFAULT_GRACE_MS = 30 * 60_000;

export interface YieldInput {
  /** The repository the session's working directory belongs to, or null if none. */
  repoRoot: string | null;
  firstTs: number;
  lastTs: number;
  /** Commit times in that repository, epoch ms, any order. */
  commitTimes: number[];
  now: number;
  graceMs?: number;
}

export interface YieldVerdict {
  status: YieldStatus;
  /** Commits falling inside the session's window. Always 0 when the status is unclear. */
  commits: number;
}

/**
 * Classifies one session. Pure: no git, no database, no clock of its own.
 *
 * `unclear` covers the two genuinely unknowable cases, and they are different from each
 * other only in cause:
 *   - the session has no repository to look at;
 *   - the session is still inside its grace period, so "no commit yet" carries no
 *     information. Calling that `abandoned` would label work as wasted while the person
 *     is still typing the commit message.
 */
export function classifyYield(input: YieldInput): YieldVerdict {
  const grace = input.graceMs ?? DEFAULT_GRACE_MS;
  if (!input.repoRoot) return { status: 'unclear', commits: 0 };

  const windowEnd = input.lastTs + grace;
  if (input.now < windowEnd) return { status: 'unclear', commits: 0 };

  let commits = 0;
  for (const t of input.commitTimes) {
    if (t >= input.firstTs && t <= windowEnd) commits++;
  }
  return commits > 0 ? { status: 'committed', commits } : { status: 'abandoned', commits: 0 };
}

interface SessionRow {
  session_id: string;
  tool: string;
  project: string | null;
  first_ts: number;
  last_ts: number;
  cost: number | null;
}

/**
 * Classifies every session that does not yet have a settled verdict and stores the
 * result.
 *
 * Only sessions missing a row, or previously `unclear`, are considered: a `committed`
 * or `abandoned` verdict is about a window that has closed and cannot change, so
 * re-deriving it every poll would spawn git processes to recompute a constant.
 */
export function computeYield(db: DB, now: number = Date.now(), graceMs: number = DEFAULT_GRACE_MS): number {
  const sessions = db
    .prepare(
      `SELECT u.session_id, u.tool, MAX(u.project) AS project,
              MIN(u.ts) AS first_ts, MAX(u.ts) AS last_ts, SUM(u.cost_usd) AS cost
         FROM usage_events u
         LEFT JOIN session_yield y
                ON y.session_id = u.session_id AND y.tool = u.tool
        WHERE u.source = 'live' AND u.session_id IS NOT NULL
          AND (y.status IS NULL OR y.status = 'unclear')
        GROUP BY u.session_id, u.tool`,
    )
    .all() as SessionRow[];
  if (sessions.length === 0) return 0;

  // One git call per repository, not per session.
  const rootOf = new Map<string, string | null>();
  const commitsOf = new Map<string, number[]>();
  const earliestIn = new Map<string, number>();

  for (const s of sessions) {
    if (!s.project) continue;
    if (!rootOf.has(s.project)) rootOf.set(s.project, repoRoot(s.project));
    const root = rootOf.get(s.project);
    if (!root) continue;
    const prev = earliestIn.get(root);
    if (prev === undefined || s.first_ts < prev) earliestIn.set(root, s.first_ts);
  }
  for (const [root, earliest] of earliestIn) {
    commitsOf.set(root, commitTimesMs(root, earliest - graceMs));
  }

  const upsert = db.prepare(
    `INSERT INTO session_yield (session_id, tool, repo_root, status, commits, window_start, window_end, computed_at)
     VALUES (@session_id, @tool, @repo_root, @status, @commits, @window_start, @window_end, @computed_at)
     ON CONFLICT(session_id, tool) DO UPDATE SET
       repo_root = excluded.repo_root, status = excluded.status, commits = excluded.commits,
       window_start = excluded.window_start, window_end = excluded.window_end,
       computed_at = excluded.computed_at`,
  );

  const run = db.transaction((rows: SessionRow[]) => {
    let n = 0;
    for (const s of rows) {
      const root = s.project ? (rootOf.get(s.project) ?? null) : null;
      const verdict = classifyYield({
        repoRoot: root,
        firstTs: s.first_ts,
        lastTs: s.last_ts,
        commitTimes: root ? (commitsOf.get(root) ?? []) : [],
        now,
        graceMs,
      });
      upsert.run({
        session_id: s.session_id,
        tool: s.tool,
        repo_root: root,
        status: verdict.status,
        commits: verdict.commits,
        window_start: s.first_ts,
        window_end: s.last_ts + graceMs,
        computed_at: now,
      });
      n++;
    }
    return n;
  });
  return run(sessions);
}

export interface YieldSummary {
  committed: { sessions: number; cost: number };
  abandoned: { sessions: number; cost: number };
  unclear: { sessions: number; cost: number };
  /** Share of *classified* cost with no commit behind it; null when nothing is classified. */
  abandonedShare: number | null;
}

/**
 * Yield over a time range, for `digest` and `top`.
 *
 * The share deliberately excludes `unclear` from its denominator. Folding unknowns in
 * would let a store full of non-git projects report a reassuringly low abandonment rate
 * that means nothing.
 */
export function getYieldSummary(db: DB, sinceMs: number): YieldSummary {
  const rows = db
    .prepare(
      `SELECT y.status, COUNT(*) AS sessions, COALESCE(SUM(c.cost), 0) AS cost
         FROM session_yield y
         JOIN (SELECT session_id, tool, SUM(cost_usd) AS cost, MAX(ts) AS last_ts
                 FROM usage_events WHERE source = 'live' GROUP BY session_id, tool) c
           ON c.session_id = y.session_id AND c.tool = y.tool
        WHERE c.last_ts >= ?
        GROUP BY y.status`,
    )
    .all(sinceMs) as { status: YieldStatus; sessions: number; cost: number }[];

  const zero = { sessions: 0, cost: 0 };
  const out: YieldSummary = {
    committed: { ...zero },
    abandoned: { ...zero },
    unclear: { ...zero },
    abandonedShare: null,
  };
  for (const r of rows) out[r.status] = { sessions: r.sessions, cost: r.cost ?? 0 };

  const classified = out.committed.cost + out.abandoned.cost;
  out.abandonedShare = classified > 0 ? out.abandoned.cost / classified : null;
  return out;
}
