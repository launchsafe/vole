/**
 * `vole statusline` — one line for an editor or terminal status bar.
 *
 * Reads Claude Code's status-line JSON on stdin (it carries `session_id`), or takes
 * `--session=<id>` for any other tool, and prints the session's live state: context
 * against its window, value so far, pace, the cache countdown, and open incidents.
 */
import { readFileSync } from 'node:fs';
import { openDb } from '../db';
import { getLiveSessions } from '../queries';
import { compact, mmss, usd } from '../util/format';

let sessionId = process.argv.find((a) => a.startsWith('--session='))?.split('=')[1] ?? null;
if (!sessionId && !process.stdin.isTTY) {
  try {
    const input = readFileSync(0, 'utf8').trim();
    if (input) sessionId = (JSON.parse(input) as { session_id?: string }).session_id ?? null;
  } catch {
    /* not JSON, or nothing piped */
  }
}
if (!sessionId) {
  console.log('vole: no session');
  process.exit(0);
}

const now = Date.now();
const [s] = getLiveSessions(openDb(), { sessionId, now });
if (!s) {
  console.log('vole: no data yet');
  process.exit(0);
}

const parts: string[] = [];
if (s.context > 0) {
  parts.push(
    s.context_window
      ? `ctx ${compact(s.context)}/${compact(s.context_window)} ${Math.round((s.context / s.context_window) * 100)}%`
      : `ctx ${compact(s.context)}`,
  );
}
parts.push(usd(s.cost));
if (s.tokens_per_min > 0) parts.push(`${compact(s.tokens_per_min)} tok/min`);
if (s.cache_expires_at !== null) {
  const left = s.cache_expires_at - now;
  parts.push(left > 0 ? `cache ${mmss(left)}` : `cache expired${s.rewarm_cost !== null ? ` (~${usd(s.rewarm_cost)} to rewrite)` : ''}`);
}
if (s.incidents.count) parts.push(`${s.incidents.worst === 'critical' ? '!!' : '!'} ${s.incidents.count} ${s.incidents.worst}`);
if (s.errors) parts.push(`${s.errors} err`);
console.log(`vole · ${parts.join(' · ')}`);
