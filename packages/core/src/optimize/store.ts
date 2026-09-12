/**
 * Persistence for optimize findings, and the apply/revert journal.
 *
 * Everything this command changes is written down before it is done and kept after it
 * is undone, so "what did this tool do to my machine, and can I put it back" always has
 * an answer. A fix that cannot be reverted is not applied.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths } from '../paths';
import type { DB } from '../db';
import type { Finding } from './detect';
import { compareOutcome, isDueForVerification, shouldRevert, VERIFY_AFTER_MS, type Outcome } from './outcome';

export interface StoredFinding {
  id: number;
  finding_key: string;
  kind: string;
  title: string;
  detail: string;
  fix: string | null;
  mechanical: number;
  predicted_usd: number | null;
  baseline_usd: number | null;
  detected_at: number;
  applied_at: number | null;
  applied_payload: string | null;
  verify_after: number | null;
  verified_at: number | null;
  outcome: string | null;
  realised_usd: number | null;
  reverted_at: number | null;
  revert_reason: string | null;
}

/** Upserts findings, preserving anything already known about one that was applied. */
export function recordFindings(db: DB, findings: Finding[], now: number): void {
  const stmt = db.prepare(
    `INSERT INTO optimize_findings
       (finding_key, kind, title, detail, fix, mechanical, predicted_usd, baseline_usd, detected_at)
     VALUES (@key, @kind, @title, @detail, @fix, @mechanical, @predicted, @baseline, @now)
     ON CONFLICT(finding_key) DO UPDATE SET
       title = excluded.title, detail = excluded.detail, fix = excluded.fix,
       predicted_usd = excluded.predicted_usd, baseline_usd = excluded.baseline_usd,
       detected_at = excluded.detected_at`,
  );
  const run = db.transaction((rows: Finding[]) => {
    for (const f of rows) {
      stmt.run({
        key: f.key, kind: f.kind, title: f.title, detail: f.detail, fix: f.fix,
        mechanical: f.mechanical ? 1 : 0, predicted: f.predictedUsd, baseline: f.baselineUsd, now,
      });
    }
  });
  run(findings);
}

export function listFindings(db: DB): StoredFinding[] {
  return db
    .prepare('SELECT * FROM optimize_findings ORDER BY predicted_usd DESC, detected_at DESC')
    .all() as StoredFinding[];
}

/**
 * Applies a mechanical fix.
 *
 * Today that is exactly one shape: an entry in the pricing override. The file is backed
 * up before the first write, the previous value is journaled, and an existing rate is
 * never overwritten — a user's own number always outranks one this tool proposes.
 */
export function applyFinding(db: DB, f: StoredFinding, now: number): { ok: boolean; note: string } {
  if (!f.mechanical) return { ok: false, note: 'not mechanically applicable — proposal only' };
  if (f.applied_at) return { ok: false, note: 'already applied' };
  if (f.kind !== 'unpriced_model') return { ok: false, note: `no apply path for ${f.kind}` };

  const model = f.finding_key.split(':').slice(2).join(':');
  if (!model) return { ok: false, note: 'could not read the model from the finding key' };

  const file = paths.pricingOverride();
  let doc: Record<string, unknown> = {};
  if (existsSync(file)) {
    // Back up once, beside the file, before this tool's first write to it.
    const backup = `${file}.vole-backup`;
    if (!existsSync(backup)) copyFileSync(file, backup);
    try {
      doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      return { ok: false, note: 'the existing pricing override is not valid JSON — not touching it' };
    }
  } else {
    mkdirSync(dirname(file), { recursive: true });
  }

  const models = (doc.models && typeof doc.models === 'object' ? doc.models : {}) as Record<string, unknown>;
  if (models[model]) return { ok: false, note: 'a rate for this model already exists — leaving it alone' };

  // Zeros, not a guess. A fabricated rate is exactly the thing this product refuses to
  // produce; the placeholder makes the model visible and asks the user for the number.
  models[model] = { input: 0, output: 0, effective_from: new Date(now).toISOString().slice(0, 10) };
  doc.models = models;
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);

  db.prepare(
    `UPDATE optimize_findings
        SET applied_at = ?, applied_payload = ?, verify_after = ?
      WHERE id = ?`,
  ).run(now, JSON.stringify({ file, model, previous: null }), now + VERIFY_AFTER_MS, f.id);

  return { ok: true, note: `added a placeholder rate for ${model} in ${file} (backup beside it)` };
}

/** Undoes an applied fix, using the payload written when it was applied. */
export function revertFinding(db: DB, f: StoredFinding, reason: string, now: number): { ok: boolean; note: string } {
  if (!f.applied_at || !f.applied_payload) return { ok: false, note: 'nothing to revert' };
  let payload: { file: string; model: string };
  try {
    payload = JSON.parse(f.applied_payload) as { file: string; model: string };
  } catch {
    return { ok: false, note: 'the revert payload is unreadable' };
  }
  if (!existsSync(payload.file)) return { ok: false, note: 'the file is gone; nothing to undo' };

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(readFileSync(payload.file, 'utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, note: 'the file is no longer valid JSON — leaving it for a human' };
  }
  const models = (doc.models ?? {}) as Record<string, unknown>;
  const current = models[payload.model] as { input?: number; output?: number } | undefined;
  // If the user has since filled in a real rate, that is theirs. Do not remove it.
  if (current && (current.input !== 0 || current.output !== 0)) {
    return { ok: false, note: 'the rate has been edited since — keeping the user\'s value' };
  }
  delete models[payload.model];
  doc.models = models;
  writeFileSync(payload.file, `${JSON.stringify(doc, null, 2)}\n`);

  db.prepare('UPDATE optimize_findings SET reverted_at = ?, revert_reason = ? WHERE id = ?')
    .run(now, reason, f.id);
  return { ok: true, note: `removed the placeholder rate for ${payload.model}` };
}

export interface VerificationResult {
  finding: StoredFinding;
  outcome: Outcome;
  realisedUsd: number;
  reverted: boolean;
  note: string;
}

/**
 * Judges every applied fix whose follow-up window has closed.
 *
 * The comparison is over equal-length windows either side of the apply, so a longer
 * follow-up cannot flatter the result.
 */
export function verifyDueFindings(db: DB, now: number = Date.now()): VerificationResult[] {
  const due = db
    .prepare(
      `SELECT * FROM optimize_findings
        WHERE applied_at IS NOT NULL AND verified_at IS NULL AND reverted_at IS NULL`,
    )
    .all() as StoredFinding[];

  const out: VerificationResult[] = [];
  for (const f of due) {
    if (!f.applied_at || !isDueForVerification(f.applied_at, now)) continue;
    const span = now - f.applied_at;
    const before = costBetween(db, f.applied_at - span, f.applied_at);
    const after = costBetween(db, f.applied_at, now);
    const verdict = compareOutcome({
      predictedUsd: f.predicted_usd ?? 0,
      baselineUsd: before,
      actualUsd: after,
    });

    let reverted = false;
    let note = '';
    if (shouldRevert(verdict.outcome, f.applied_at !== null)) {
      const r = revertFinding(db, f, 'verified as no help', now);
      reverted = r.ok;
      note = r.note;
    }
    db.prepare('UPDATE optimize_findings SET verified_at = ?, outcome = ?, realised_usd = ? WHERE id = ?')
      .run(now, verdict.outcome, verdict.realisedUsd, f.id);

    out.push({ finding: f, outcome: verdict.outcome, realisedUsd: verdict.realisedUsd, reverted, note });
  }
  return out;
}

function costBetween(db: DB, from: number, to: number): number {
  const r = db
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage_events WHERE source='live' AND ts >= ? AND ts < ?")
    .get(from, to) as { c: number };
  return r.c ?? 0;
}
