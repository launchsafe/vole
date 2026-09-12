/**
 * The one place this project shells out to git.
 *
 * Read-only queries only — `rev-parse`, `log`. Nothing here mutates a repository, and
 * nothing here touches the network, so the collector's "reads local files, sends
 * nothing" property is unchanged.
 *
 * `execFileSync` with an argument array, never a shell string: repository paths come
 * from a third-party tool's log and land here as arguments, so there must be no shell
 * for them to be interpreted by.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** A git invocation in `cwd`. Returns null for any failure — missing git, not a repo, bad path. */
export function git(cwd: string, ...args: string[]): string | null {
  if (!existsSync(cwd)) return null;
  try {
    return execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      // A pathological repository must not hang a collector poll.
      timeout: 10_000,
      maxBuffer: 32 * 1024 * 1024,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * The repository a directory belongs to, or null if it is not in one.
 *
 * `rev-parse --show-toplevel` rather than walking up looking for a `.git` directory:
 * only git knows about worktrees, submodules and `$GIT_DIR`, and a session's recorded
 * project is very often a SUBDIRECTORY of the repo — on the development machine most
 * project paths had no `.git` of their own and would have been misread as "not a repo".
 */
export function repoRoot(dir: string): string | null {
  return git(dir, 'rev-parse', '--show-toplevel');
}

/**
 * Commit times in a repository, newest first, as epoch milliseconds.
 *
 * One call per repository covering the whole span of interest, rather than one per
 * session: a store with dozens of sessions in one repo would otherwise pay dozens of
 * process spawns to answer the same question.
 *
 * `--all` so work committed on another branch still counts — an agent's output does not
 * stop being productive because the branch was renamed or the commit landed elsewhere.
 */
export function commitTimesMs(root: string, sinceMs: number): number[] {
  const since = new Date(sinceMs).toISOString();
  const out = git(root, 'log', '--all', `--since=${since}`, '--format=%ct', '--no-merges');
  if (!out) return [];
  const times: number[] = [];
  for (const line of out.split('\n')) {
    const secs = Number(line.trim());
    if (Number.isFinite(secs) && secs > 0) times.push(secs * 1000);
  }
  return times;
}
