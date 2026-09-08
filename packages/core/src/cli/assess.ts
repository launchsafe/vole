import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDbReadOnly } from '../db';
import type { DB } from '../db';
import { consoleBlindShare } from '../scanners/coverage';

/**
 * `vole assess [--wedge]` (tier 2 feature 10): the competitor-coverage annex
 * computed on the buyer's own machine rather than asserted in a deck. Three
 * facts, all local: which agent surfaces each incumbent category is documented
 * to cover (from the shipped, dated data/console_coverage.json, with a URL and
 * read date per claim); the local row counts proving the uncovered cells are
 * non-empty; and the content-boundary line. One laptop, never a fleet.
 */

/** The shipped, dated vendor-coverage claims pack (versioned like every pack). */
export interface ConsoleCoverageData {
  pack_version: number;
  read_date: string;
  note: string;
  categories: {
    category: string;
    label: string;
    claims: {
      vendor: string;
      url: string;
      read_date: string;
      documented_coverage: string[];
      documented_exclusions: string[];
    }[];
  }[];
}

export function loadConsoleCoverage(): ConsoleCoverageData {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'console_coverage.json');
  return JSON.parse(readFileSync(file, 'utf8')) as ConsoleCoverageData;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/** Local facts proving the uncovered cells are non-empty. */
export function localWedgeFacts(db: DB): { surfaces: { kind: string; n: number }[]; blind: ReturnType<typeof consoleBlindShare>; usageRows: number } {
  const surfaces = db
    .prepare('SELECT kind, COUNT(*) AS n FROM ai_surfaces GROUP BY kind ORDER BY n DESC')
    .all() as { kind: string; n: number }[];
  const blind = consoleBlindShare(db);
  const usageRows = (
    db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE source = 'live'").get() as { n: number }
  ).n;
  return { surfaces, blind, usageRows };
}

/** Pure: the report text, so the annex is testable without a live store. */
export function renderAssessment(db: DB, cov: ConsoleCoverageData, now = Date.now()): string {
  const facts = localWedgeFacts(db);
  const lines: string[] = [];
  lines.push(`Vole assessment — ${new Date(now).toISOString().slice(0, 10)} · this Mac only, live rows only`);
  lines.push('');
  lines.push('Local facts (computed here, not asserted):');
  lines.push(`  usage rows: ${fmt(facts.usageRows)}`);
  if (facts.surfaces.length) {
    lines.push(`  AI surfaces by kind: ${facts.surfaces.map((s) => `${s.kind} ${s.n}`).join(', ')}`);
  } else {
    lines.push('  AI surfaces: none recorded yet — run the collector first');
  }
  for (const b of facts.blind) {
    const pct = b.rows ? Math.round((b.blind / b.rows) * 100) : 0;
    lines.push(
      `  console-blind (${b.tool}): ${fmt(b.blind)} of ${fmt(b.rows)} token-bearing rows (${pct}%) — no vendor console reports these`,
    );
  }
  lines.push('');
  lines.push('Wedge annex — competitor coverage, as documented:');
  for (const cat of cov.categories) {
    lines.push(`  ${cat.label}`);
    for (const c of cat.claims) {
      lines.push(`    ${c.vendor} — as documented on ${c.read_date} (${c.url})`);
      for (const k of c.documented_coverage) lines.push(`      covers: ${k}`);
      for (const x of c.documented_exclusions) lines.push(`      excludes: ${x}`);
    }
  }
  const nonEmpty =
    facts.usageRows > 0 || facts.surfaces.some((s) => s.n > 0)
      ? 'non-empty: the cells the matrix shades as uncovered are populated by rows this store already holds'
      : 'empty so far — the annex describes documentation, not this machine, until the collector has run';
  lines.push(`  Uncovered cells on this machine: ${nonEmpty}`);
  lines.push('');
  lines.push(
    'Content boundary: this store holds metadata, hashes and counts only — no prompt, tool-arg or message content. ' +
      'Re-prove it any time with `vole verify --content`.',
  );
  lines.push(cov.note);
  return lines.join('\n');
}

function main(): void {
  const wedge = process.argv.includes('--wedge');
  const db = openDbReadOnly();
  const report = renderAssessment(db, loadConsoleCoverage());
  if (wedge) {
    // The annex alone, for pasting into a security review doc.
    const from = report.indexOf('Wedge annex');
    const to = report.indexOf('Content boundary');
    console.log(report.slice(from, to === -1 ? undefined : to).trimEnd());
    return;
  }
  console.log(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
