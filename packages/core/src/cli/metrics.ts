/**
 * Tier 7 response metrics and detection quality:
 *
 *   tsx packages/core/src/cli/metrics.ts [days]
 *
 * MTTA/MTTR are MEDIANS per rule (one incident left open for a weekend must
 * not drag a mean), computed only from clocks Vole itself wrote, with
 * backfill-stamped rows excluded entirely rather than handed a
 * plausible-looking number. Unattended is a first-class state: a case nobody
 * could have triaged because the queue was never opened is an ABSENCE, not
 * a zero-time response. Beside them: per-rule detection quality with the
 * labelled-fraction floor (precision renders only above 20 labelled cases
 * AND 20% of the rule's cases — below that, an em dash and the literal
 * denominator) and the weekly noise budget naming the rules that blew it.
 * The unmonitored hours print beside the noise count, because a quiet week
 * can be a dead collector rather than a calm one.
 */
import { openDbReadOnly } from '../db';
import { mttaMttr } from '../triage/quality';
import { ruleQuality, QUALITY_FLOOR_CASES } from '../triage/quality';
import { loadNoiseBudget, noiseBudgetRows } from '../triage/noise';
import { deriveEvidenceGaps, collectWitnessTimestamps } from '../triage/custody';

const days = 30;

const db = openDbReadOnly();
const stats = mttaMttr(db);
const quality = ruleQuality(db);
const budget = loadNoiseBudget();
const { rows: noiseRows } = noiseBudgetRows(db, budget);
const gaps = deriveEvidenceGaps(
  db.prepare('SELECT started_at, duration_ms FROM collector_runs').all() as { started_at: number; duration_ms: number }[],
  collectWitnessTimestamps(db),
);
const unmonitoredMinutes = gaps.reduce((s, g) => s + g.minutes, 0);
db.close();

console.log(`Vole response metrics and detection quality (${days}d)`);
console.log('────────────────────────');
console.log('  MTTA / MTTR per rule (medians, Vole clocks only, backfill excluded)');
console.log('  ── unattended = queue never opened; unactioned = queue open, case left alone');
for (const s of stats) {
  const fmt = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)} min`);
  console.log(
    `    ${s.rule.padEnd(28)} MTTA ${fmt(s.mtta_min).padStart(12)}  MTTR ${fmt(s.mttr_min).padStart(12)}  ` +
      `acted ${String(s.with_action).padStart(4)}  unattended ${String(s.unattended).padStart(4)}  unactioned ${String(s.unactioned).padStart(4)}` +
      (s.backfill_excluded > 0 ? `  (backfill-excluded ${s.backfill_excluded})` : ''),
  );
}

console.log('\n  Detection quality per rule (precision only above the labelled-fraction floor)');
for (const q of quality) {
  const precision = q.precision === null
    ? `— (${q.labelled} of ${q.cases} cases labelled)`
    : `${(q.precision * 100).toFixed(0)}%`;
  console.log(
    `    ${q.rule.padEnd(28)} fired ${String(q.findings).padStart(5)}  cases ${String(q.cases).padStart(4)}  ` +
      `labelled ${String(q.labelled).padStart(4)} (single ${q.labelled_single}, bulk ${q.labelled_bulk})  precision ${precision}`,
  );
}
console.log(`    floor: precision renders only above ${QUALITY_FLOOR_CASES} labelled cases AND 20% of the rule's cases;`);
console.log('    recall is never shown — Vole cannot count the findings it failed to produce.');

console.log(`\n  Noise budget per host per week (overall ${budget.overall_per_week} findings/week)`);
const blown = noiseRows.filter((r) => r.exceeded);
for (const r of blown) {
  console.log(`    ${r.iso_week}  ${r.rule.padEnd(28)} ${r.findings} of ${r.budget} budgeted`);
}
if (blown.length === 0) console.log('    no rule over budget this store');
console.log(
  `    unmonitored: ${gaps.length} gap(s), ${Math.round(unmonitoredMinutes)} min total in the run record — ` +
    'silence is not calm.',
);
