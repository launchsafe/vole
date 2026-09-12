/**
 * `vole budget` — see and set the spend caps, and install the guard.
 *
 *   pnpm budget                         show the caps and where spend stands
 *   pnpm budget --daily-hard=25         refuse further calls past $25 today
 *   pnpm budget --session-soft=5        warn past $5 in one session
 *   pnpm budget --exclude-estimated     count only verbatim cost toward caps
 *   pnpm budget --install-hook          print the settings.json block for Claude Code
 *   pnpm budget --json
 *
 * Setting a cap to 0 removes it.
 */
import { openDbReadOnly } from '../db';
import {
  loadBudget, saveBudget, budgetPath, spendSince, startOfLocalDay,
  evaluateBudget, countedSpend, type BudgetConfig,
} from '../budget';
import { usd } from '../util/format';

const args = process.argv.slice(2);
const json = args.includes('--json');
const num = (flag: string): number | undefined => {
  const a = args.find((x) => x.startsWith(`${flag}=`));
  if (!a) return undefined;
  const n = Number(a.split('=')[1]);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

const cfg = loadBudget();
let changed = false;
const set = (v: number | undefined, apply: (n: number | null) => void) => {
  if (v === undefined) return;
  apply(v > 0 ? v : null); // 0 clears
  changed = true;
};
set(num('--daily-soft'), (n) => { cfg.daily.soft = n; });
set(num('--daily-hard'), (n) => { cfg.daily.hard = n; });
set(num('--session-soft'), (n) => { cfg.session.soft = n; });
set(num('--session-hard'), (n) => { cfg.session.hard = n; });
if (args.includes('--exclude-estimated')) { cfg.includeEstimated = false; changed = true; }
if (args.includes('--include-estimated')) { cfg.includeEstimated = true; changed = true; }

if (changed) saveBudget(cfg);

if (args.includes('--install-hook')) {
  const dir = process.env.INIT_CWD ?? process.cwd();
  console.log(`
Add this to ~/.claude/settings.json — it runs the guard before every tool call:

{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "${dir}/scripts/vole-guard.sh" }
        ]
      }
    ]
  }
}

The guard denies a call only when a HARD cap has been reached, and fails open on any
error of its own — a monitor has no business bricking an agent because its database
was briefly locked.

Use the wrapper, not 'pnpm run guard': a PreToolUse hook blocks by exiting 2, and
pnpm collapses that to 1, which the contract treats as a non-blocking error. The cap
would look installed and never fire.

OpenCode: its plugin API exposes "permission.ask" with an output status of
"deny", so the same policy can be enforced there. Codex CLI exposes no hook
mechanism in config.toml, so caps are advisory only for it — the spend still
shows in \`pnpm budget\`, but nothing can stop a call mid-flight.
`);
  process.exit(0);
}

const now = Date.now();
const db = openDbReadOnly();
const daily = spendSince(db, startOfLocalDay(now));
const breach = evaluateBudget(cfg, { exact: 0, estimated: 0, unmeasuredCalls: 0, calls: 0 }, daily);
const counted = countedSpend(daily, cfg.includeEstimated);

if (json) {
  console.log(JSON.stringify({ config: cfg, today: daily, counted, breach, file: budgetPath() }, null, 2));
  process.exit(0);
}

const cap = (v: number | null) => (v === null ? '—' : usd(v));
const L: string[] = [];
L.push('');
L.push(`vole budget · ${budgetPath()}`);
L.push('─'.repeat(58));
L.push(`  daily     soft ${cap(cfg.daily.soft)}    hard ${cap(cfg.daily.hard)}`);
L.push(`  session   soft ${cap(cfg.session.soft)}    hard ${cap(cfg.session.hard)}`);
L.push(`  estimated cost counts toward caps: ${cfg.includeEstimated ? 'yes' : 'no'}`);
L.push('');
L.push(`  today: ${usd(counted)} counted  (${usd(daily.exact)} exact` +
  (daily.estimated > 0 ? ` + ${usd(daily.estimated)} estimated` : '') + ')');
if (daily.unmeasuredCalls > 0) {
  // Never let the total look complete when it is not.
  L.push(`  ${daily.unmeasuredCalls} call(s) today have no recorded cost and cannot count toward a cap.`);
}
L.push('');
L.push(
  breach.level === 'hard' ? `  OVER the ${breach.scope} hard cap (${usd(breach.cap)}).`
  : breach.level === 'soft' ? `  Over the ${breach.scope} soft cap (${usd(breach.cap)}) — warning only.`
  : cfg.daily.hard || cfg.daily.soft || cfg.session.hard || cfg.session.soft
    ? '  Within budget.'
    : '  No caps set. Try:  pnpm budget --daily-hard=25 --session-soft=5',
);
if (changed) L.push(`\n  Saved to ${budgetPath()}.`);
L.push('');
L.push('  Hard caps need the guard installed:  pnpm budget --install-hook');
L.push('');
console.log(L.join('\n'));
