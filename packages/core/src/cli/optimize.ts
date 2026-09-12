/**
 * `vole optimize` — find waste, propose a fix, and later check whether it helped.
 *
 *   pnpm optimize            detect, report, and judge anything due
 *   pnpm optimize --apply    also apply the fixes that are mechanically applicable
 *   pnpm optimize --json     the same findings as JSON
 *
 * Nothing is applied without `--apply`. Most findings describe a change in how someone
 * works and have no mechanical fix at all; the command says so rather than inventing an
 * action to look busy.
 */
import { openDb } from '../db';
import { detectAll } from '../optimize/detect';
import { recordFindings, listFindings, applyFinding, verifyDueFindings } from '../optimize/store';
import { usd } from '../util/format';

const args = process.argv.slice(2);
const json = args.includes('--json');
const doApply = args.includes('--apply');

const db = openDb();
const now = Date.now();

// Judge first: a finding applied three days ago has an answer waiting, and the user
// should see the verdict on the last round before being shown a new one.
const verified = verifyDueFindings(db, now);

const found = detectAll(db, now);
recordFindings(db, found, now);

const applied: { title: string; note: string; ok: boolean }[] = [];
if (doApply) {
  for (const f of listFindings(db)) {
    if (!f.mechanical || f.applied_at || f.reverted_at) continue;
    const r = applyFinding(db, f, now);
    applied.push({ title: f.title, note: r.note, ok: r.ok });
  }
}

const stored = listFindings(db);

if (json) {
  console.log(JSON.stringify({ findings: stored, verified, applied }, null, 2));
  process.exit(0);
}

const L: string[] = [];
L.push('');
L.push('vole optimize');
L.push('─'.repeat(60));

if (verified.length) {
  L.push('');
  L.push('Results from fixes applied earlier');
  for (const v of verified) {
    const verdict =
      v.outcome === 'worked' ? 'worked'
      : v.outcome === 'under_estimate' ? 'helped, under its estimate'
      : 'did not help';
    L.push(`  ${v.finding.title}`);
    L.push(`    ${verdict} · ${usd(v.realisedUsd)} actually saved vs ${usd(v.finding.predicted_usd ?? 0)} predicted`);
    if (v.reverted) L.push(`    reverted automatically — ${v.note}`);
  }
}

if (!stored.length) {
  L.push('');
  L.push('  No waste found worth reporting.');
} else {
  const totalPredicted = stored
    .filter((f) => !f.applied_at)
    .reduce((n, f) => n + (f.predicted_usd ?? 0), 0);
  L.push('');
  L.push(`${stored.length} finding(s)${totalPredicted > 0 ? ` · up to ${usd(totalPredicted)} / 30 days` : ''}`);

  for (const f of stored) {
    const state =
      f.reverted_at ? ' [reverted]'
      : f.verified_at ? ` [${f.outcome}]`
      : f.applied_at ? ' [applied — verifying]'
      : f.mechanical ? ' [can be applied]' : '';
    L.push('');
    L.push(`── ${f.title}${state}`);
    if ((f.predicted_usd ?? 0) > 0) {
      L.push(`   up to ${usd(f.predicted_usd)} of ${usd(f.baseline_usd)} measured`);
    }
    L.push(`   ${wrap(f.detail, 3)}`);
    if (f.fix) {
      L.push('');
      L.push('   Fix:');
      L.push(indent(f.fix, 5));
    }
  }
}

if (applied.length) {
  L.push('');
  L.push('Applied now');
  for (const a of applied) L.push(`  ${a.ok ? '✓' : '·'} ${a.title} — ${a.note}`);
  L.push('');
  L.push('  These will be checked in 3 days. Anything that did not help is reverted.');
} else if (stored.some((f) => f.mechanical && !f.applied_at)) {
  L.push('');
  L.push('  Re-run with --apply to apply the mechanical fixes above.');
}

L.push('');
L.push('Estimates are checked against reality, not just claimed: an applied fix is');
L.push('re-measured after 3 days and reported as worked, under its estimate, or not.');
L.push('');
console.log(L.join('\n'));

function wrap(s: string, pad: number): string {
  const width = 76 - pad;
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) { lines.push(cur.trim()); cur = w; }
    else cur += ` ${w}`;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.join('\n' + ' '.repeat(pad));
}

/**
 * Indents a fix block, wrapping prose but leaving already-indented lines alone — those
 * are the paste-ready snippets, and reflowing JSON would make it unpasteable.
 */
function indent(s: string, pad: number): string {
  return s
    .split('\n')
    .map((l) => {
      if (!l.trim()) return '';
      if (l.startsWith('    ')) return ' '.repeat(pad) + l.trim();
      return ' '.repeat(pad) + wrap(l, pad);
    })
    .join('\n');
}
