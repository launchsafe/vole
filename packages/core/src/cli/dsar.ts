/**
 * Tier 8: the completed DSAR and the privacy exports that hang off the same
 * machinery. Art. 15 asks for more than rows: categories, recipients, the
 * retention period, and for anything resembling automated evaluation,
 * meaningful information about the logic involved — the same three figures
 * the 'Why this fired' disclosure shows.
 *
 *   pnpm dsar [--subject <principal_key>]        the Art. 15 export (self by default)
 *   pnpm dsar --recipients <principal_key>       the Art. 15(1)(c) recipients answer
 *   pnpm dsar --art30                            the org-level record of processing
 *   pnpm dsar --literacy [<principal_key>]       the AI-literacy record (Art. 4 evidence)
 *   pnpm dsar --works-council                    the DPIA pre-filled with measured facts
 */
import { openDb } from '../db';
import { buildDsar, processingRegister, recipientsAnswer, worksCouncilPack } from '../privacy/register';
import { literacyRecord } from '../privacy/literacy';
import { policyK } from '../privacy/kanon';
import { kanonBlock } from '../privacy/register';
import { dailyRollup, toGrid, twoPassSuppression } from '../privacy/kanon';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] && !args[i + 1]!.startsWith('--') ? args[i + 1] : '') : undefined;
};

const db = openDb();

if (flag('--art30') !== undefined) {
  const reg = processingRegister(db);
  console.log(
    `Art. 30 record of processing activities — ${reg.rows.length} surface(s); ` +
    `${reg.unresolved_recipients} with an unresolved recipient, ` +
    `${reg.egress_rows_without_in_force_terms} egress row(s) with no in-force terms entry`,
  );
  console.log(reg.note);
  console.log(JSON.stringify(reg, null, 1));
  process.exit(0);
}

const recipients = flag('--recipients');
if (recipients !== undefined) {
  console.log(JSON.stringify(recipientsAnswer(db, recipients), null, 1));
  process.exit(0);
}

if (flag('--literacy') !== undefined) {
  const subject = flag('--literacy') || undefined;
  const rows = literacyRecord(db, { principalKey: subject });
  console.log(
    `AI literacy and tool-usage record${subject ? ` — subject ${subject}` : ' (aggregate)'} — ` +
    `${rows.length} tool/model pair(s). It proves use, never competence; tools with no ` +
    `collector are absent, not zero.`,
  );
  console.log(JSON.stringify(rows, null, 1));
  process.exit(0);
}

if (flag('--works-council') !== undefined) {
  // The k achieved for the aggregate is a measured fact the council argues with.
  const k = policyK(kanonBlock());
  const cells = dailyRollup(db, Date.now() - 30 * 86_400_000, Date.now());
  const supp = twoPassSuppression(toGrid(cells).values, k);
  const pack = worksCouncilPack(db, { kanon: { k, primary: supp.primary, complementary: supp.complementary } });
  console.log(JSON.stringify(pack, null, 1));
  process.exit(0);
}

const subject = flag('--subject');
console.log(JSON.stringify(buildDsar(db, { principalKey: subject || undefined }), null, 1));
