/**
 * `vole pr` — agent usage for the branch you are on, as markdown for a PR description.
 *
 * Attribution is by working directory inside this repo, from the moment the branch
 * diverged from the default branch, across every tool. Only Claude Code records the
 * branch name itself, so that exact count is reported as a second line rather than
 * used as the filter.
 */
import { execFileSync } from 'node:child_process';
import { openDb } from '../db';
import { compact, usd } from '../util/format';
import type { Tool } from '../types';

const args = process.argv.slice(2);
const json = args.includes('--json');
const sinceDays = Number(args.find((a) => a.startsWith('--since='))?.split('=')[1] ?? 0);
// pnpm runs scripts from the package dir; INIT_CWD is where the user actually typed the command.
const cwd = process.env.INIT_CWD ?? process.cwd();

function git(...a: string[]): string | null {
  try {
    return execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

const root = git('rev-parse', '--show-toplevel');
if (!root) {
  console.error(`vole pr: ${cwd} is not inside a git repository`);
  process.exit(1);
}
const branch = git('rev-parse', '--abbrev-ref', 'HEAD') ?? 'HEAD';
const remoteHead = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
const base =
  remoteHead ?? (git('rev-parse', '--verify', '-q', 'main') ? 'main' : git('rev-parse', '--verify', '-q', 'master') ? 'master' : null);
const mergeBase = base && base !== branch ? git('merge-base', base, 'HEAD') : null;
const divergedAt = mergeBase ? Number(git('show', '-s', '--format=%ct', mergeBase)) * 1000 : null;
const since = sinceDays > 0 ? Date.now() - sinceDays * 86_400_000 : (divergedAt ?? Date.now() - 7 * 86_400_000);
const basis = sinceDays > 0
  ? `last ${sinceDays} days`
  : divergedAt
    ? `since it diverged from ${base} on ${new Date(divergedAt).toISOString().slice(0, 10)}`
    : 'last 7 days (no base branch found)';

const db = openDb();
interface Row { tool: Tool; model: string | null; calls: number; tokens: number | null; cost: number | null }
const rows = db
  .prepare(
    `SELECT tool, model, COUNT(*) AS calls,
            SUM(CASE WHEN confidence != 'activity_only' THEN total_tokens END) AS tokens, SUM(cost_usd) AS cost
     FROM usage_events
     WHERE source = 'live' AND ts >= ? AND (project = ? OR project LIKE ?)
     GROUP BY tool, model ORDER BY tokens DESC`,
  )
  .all(since, root, `${root}/%`) as Row[];
const exactBranch = db
  .prepare(
    `SELECT COUNT(*) AS calls, SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost
     FROM usage_events WHERE source = 'live' AND git_branch = ? AND (project = ? OR project LIKE ?)`,
  )
  .get(branch, root, `${root}/%`) as { calls: number; tokens: number | null; cost: number | null };

const total = {
  calls: rows.reduce((s, r) => s + r.calls, 0),
  tokens: rows.reduce((s, r) => s + (r.tokens ?? 0), 0),
  cost: rows.some((r) => r.cost !== null) ? rows.reduce((s, r) => s + (r.cost ?? 0), 0) : null,
};

if (json) {
  console.log(JSON.stringify({ repo: root, branch, base, since, basis, rows, total, exactBranch }, null, 2));
  process.exit(0);
}

const L: string[] = [];
L.push(`### Agent usage on \`${branch}\``);
L.push('');
L.push(`${basis} · ${compact(total.tokens)} tokens · ${usd(total.cost)} equivalent value`);
L.push('');
L.push('| Tool | Model | Calls | Tokens | Value |');
L.push('|---|---|---:|---:|---:|');
for (const r of rows) L.push(`| ${r.tool} | ${r.model ?? '—'} | ${r.calls} | ${compact(r.tokens)} | ${usd(r.cost)} |`);
L.push(`| **Total** | | **${total.calls}** | **${compact(total.tokens)}** | **${usd(total.cost)}** |`);
L.push('');
L.push(
  `<sub>Exact tokens from each tool's own logs, attributed by working directory inside this repo. ` +
    `Value is equivalent API cost at list price, "—" where no rate is loaded. ` +
    `${exactBranch.calls} calls recorded the branch name itself (${compact(exactBranch.tokens)} tokens). Generated locally by Vole.</sub>`,
);
console.log(L.join('\n'));
