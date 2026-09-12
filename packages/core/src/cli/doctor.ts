/**
 * `vole doctor` — is any source lying to you by omission?
 *
 *   pnpm checkup         a pass/warn/fail line per tool, plus the store
 *   pnpm checkup --json
 *
 * Named `checkup`, not `doctor`: pnpm has a built-in `doctor` that would shadow it.
 *
 * Exit code follows the worst finding: 0 healthy, 1 warnings, 2 failures — so it can
 * sit in a script without anyone reading the output.
 *
 * The check that earns this command its place is staleness. A collector whose parser
 * still works against a tool that changed what it writes is indistinguishable from a
 * healthy one: it reports success, inserts rows, and its number quietly stops growing.
 */
import { openDbReadOnly } from '../db';
import { paths } from '../paths';
import { checkTools, checkStore, worstLevel, type HealthLevel } from '../health';

const args = process.argv.slice(2);
const json = args.includes('--json');

const db = openDbReadOnly();
const now = Date.now();
const tools = checkTools(db, now);
const store = checkStore(db, paths.db());
const overall = worstLevel([...tools.map((t) => t.level), store.level]);

// exitCode rather than exit(): process.exit() can truncate buffered stdout on a pipe,
// which made this command print nothing at all when piped.
process.exitCode = overall === 'fail' ? 2 : overall === 'warn' ? 1 : 0;

if (json) {
  console.log(JSON.stringify({ overall, store, tools }, null, 2));
} else {

const MARK: Record<HealthLevel, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
const NAME: Record<string, string> = {
  claude_code: 'Claude Code', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode',
  grok: 'Grok', devin: 'Devin', antigravity: 'Antigravity',
};

const L: string[] = [];
L.push('');
L.push('vole doctor');
L.push('─'.repeat(72));

for (const t of tools) {
  L.push(`  ${MARK[t.level]}  ${(NAME[t.tool] ?? t.tool).padEnd(12)} ${t.verdict}`);
  // The path only earns a line when it is the thing that needs attention.
  if (t.level !== 'ok' || !t.installed) L.push(`        ${t.sourcePath}`);
}

L.push('');
L.push(`  ${MARK[store.level]}  ${'store'.padEnd(12)} ${store.verdict}`);
L.push(`        ${store.path}${store.sizeBytes !== null ? `  (${mb(store.sizeBytes)})` : ''}`);

L.push('');
if (overall === 'ok') {
  L.push('  Everything healthy.');
} else {
  const warns = tools.filter((t) => t.level === 'warn').length + (store.level === 'warn' ? 1 : 0);
  const fails = tools.filter((t) => t.level === 'fail').length + (store.level === 'fail' ? 1 : 0);
  L.push(`  ${fails} failure(s), ${warns} warning(s).`);
  if (tools.some((t) => t.staleDays !== null && t.level === 'warn' && t.installed)) {
    L.push('');
    L.push('  A "no token counts for N days" warning usually means the tool changed what it');
    L.push('  writes, not that you stopped using it. The parser still works; there is simply');
    L.push('  nothing left to measure, and that total will not grow again on its own.');
  }
}
L.push('');
L.push('  Numbers are checked separately:  pnpm verify');
L.push('');
console.log(L.join('\n'));
}

function mb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}
