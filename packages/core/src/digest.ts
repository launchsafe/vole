import type { Digest } from './queries';
import { compact, usd } from './util/format';

const TOOL: Record<string, string> = {
  claude_code: 'Claude Code', codex: 'Codex', cursor: 'Cursor', antigravity: 'Antigravity',
  opencode: 'OpenCode', grok: 'Grok', devin: 'Devin',
};
const RULE: Record<string, string> = {
  burn_rate_spike: 'burn spikes', loop_suspected: 'runaway loops', error_storm: 'retry storms',
  rate_limit_pressure: 'rate-limit warnings', context_pressure: 'context-pressure warnings',
};
const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** The digest as markdown — for the CLI, the dashboard's download, and pasting anywhere. */
export function digestMarkdown(d: Digest): string {
  const s = d.summary;
  const L: string[] = [];
  L.push(`## Your agent ${d.range === '7d' ? 'week' : d.range} · ${day(d.from)} → ${day(d.to)}`);
  L.push('');
  L.push(`**${compact(s.tokens)} tokens** across **${s.calls.toLocaleString('en-US')} calls** in ${s.sessions} sessions · equivalent value ${usd(s.cost)}`);
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| Cache hit | ${s.cacheHitRatio === null ? '—' : `${Math.round(s.cacheHitRatio * 100)}%`} |`);
  L.push(`| Cache re-warm | ${compact(d.rewarm.tokens)} tokens after ${d.rewarm.gaps} idle gaps · ${usd(d.rewarm.cost)} |`);
  L.push(`| Errors / truncated | ${s.errors} / ${s.truncated} |`);
  L.push(`| Incidents | ${d.incidents.total} (${d.incidents.critical} critical)${
    Object.keys(d.incidents.byRule).length
      ? ' — ' + Object.entries(d.incidents.byRule).map(([r, n]) => `${n} ${RULE[r] ?? r}`).join(', ')
      : ''} |`);
  if (d.busiestDay) L.push(`| Busiest day | ${day(d.busiestDay.bucket)} · ${compact(d.busiestDay.tokens)} tokens |`);
  if (d.biggestSession) {
    const b = d.biggestSession;
    L.push(`| Biggest session | ${TOOL[b.tool] ?? b.tool} in ${b.project ? base(b.project) : '?'} · ${compact(b.tokens)} tokens · ${usd(b.cost)} |`);
  }
  L.push('');
  if (s.byTool.length) {
    L.push('**By tool**');
    L.push('');
    L.push('| Tool | Calls | Tokens | Value |');
    L.push('|---|---:|---:|---:|');
    for (const t of s.byTool) L.push(`| ${TOOL[t.tool] ?? t.tool} | ${t.calls} | ${compact(t.tokens)} | ${usd(t.cost)} |`);
    L.push('');
  }
  if (d.topProjects.length) {
    L.push('**Top projects**');
    L.push('');
    for (const p of d.topProjects) L.push(`- ${base(p.model ?? '?')} · ${TOOL[p.tool] ?? p.tool} · ${compact(p.tokens)} tokens · ${usd(p.cost)}`);
    L.push('');
  }
  if (d.topModels.length) {
    L.push('**Top models**');
    L.push('');
    for (const m of d.topModels) L.push(`- ${m.model ?? '—'} · ${TOOL[m.tool] ?? m.tool} · ${compact(m.tokens)} tokens · ${usd(m.cost)}`);
    L.push('');
  }
  L.push('_Every number is read verbatim from each tool\'s own logs. Value is equivalent API cost at list price, not a bill. Generated locally by Vole._');
  return L.join('\n');
}
