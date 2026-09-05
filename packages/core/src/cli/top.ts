/**
 * `vole top` — the terminal view of what is running right now, htop-style.
 * Every column is read from the collector's database; nothing is estimated.
 */
import { openDb } from '../db';
import { getLiveSessions, type LiveSession } from '../queries';
import { ago, compact, mmss, usd } from '../util/format';

const args = process.argv.slice(2);
const sinceMin = Number(args.find((a) => a.startsWith('--since='))?.split('=')[1] ?? 30);
const once = args.includes('--once');
const db = openDb();

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
const rpad = (s: string, n: number) => s.padStart(n);
const base = (p: string | null) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p : '—');

function ctx(r: LiveSession): string {
  if (r.context === 0) return '—';
  if (!r.context_window) return compact(r.context);
  return `${compact(r.context)}/${compact(r.context_window)} ${Math.round((r.context / r.context_window) * 100)}%`;
}

function cache(r: LiveSession, now: number): string {
  if (r.cache_expires_at === null) return '—';
  const left = r.cache_expires_at - now;
  return left <= 0 ? 'expired' : mmss(left);
}

function flags(r: LiveSession): string {
  const f: string[] = [];
  if (r.incidents.count) f.push(`${r.incidents.worst === 'critical' ? '!!' : '!'} ${r.incidents.count} ${r.incidents.worst}`);
  if (r.errors) f.push(`E${r.errors}`);
  if (r.agents > 1) f.push(`${r.agents} agents`);
  return f.join(' ');
}

function frame(): void {
  const now = Date.now();
  const rows = getLiveSessions(db, { sinceMs: sinceMin * 60_000, now });
  const head =
    `${pad('TOOL', 11)} ${pad('SESSION', 9)} ${pad('PROJECT', 18)} ${pad('MODEL', 24)} ` +
    `${rpad('CONTEXT', 18)} ${rpad('TOK/MIN', 8)} ${rpad('VALUE', 8)} ${rpad('IDLE', 5)} ${rpad('CACHE', 7)}  ${pad('LAST TOOLS', 22)} FLAGS`;
  const lines = rows.map(
    (r) =>
      `${pad(r.tool, 11)} ${pad(r.session_id.slice(0, 8), 9)} ${pad(base(r.project), 18)} ${pad(r.model ?? '—', 24)} ` +
      `${rpad(ctx(r), 18)} ${rpad(compact(r.tokens_per_min), 8)} ${rpad(usd(r.cost), 8)} ${rpad(ago(now - r.last_ts), 5)} ` +
      `${rpad(cache(r, now), 7)}  ${pad(r.last_tools ?? '—', 22)} ${flags(r)}`,
  );
  const out = [
    `vole top · ${rows.length} session${rows.length === 1 ? '' : 's'} active in the last ${sinceMin} min · ${new Date(now).toLocaleTimeString()}`,
    '',
    head,
    ...(lines.length ? lines : ['  (nothing running — is the collector on?  pnpm collect)']),
    '',
    'CONTEXT = tokens the latest call carried / model window.  CACHE = time until the prompt cache expires if nothing is sent.',
  ];
  if (!once) process.stdout.write('\x1b[2J\x1b[H');
  console.log(out.join('\n'));
}

frame();
if (!once) setInterval(frame, 2000);
