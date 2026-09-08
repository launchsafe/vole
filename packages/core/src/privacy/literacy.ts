/**
 * Tier 8: the AI literacy and tool-usage record per subject. EU AI Act
 * Art. 4 has been enforceable since 2026-08-02 and obliges deployers to
 * ensure staff have sufficient AI literacy; the evidence an auditor asks
 * for is a per-person record of which AI systems each employee actually
 * uses, which the store already holds.
 *
 * It proves use, never competence — the record shows a person ran a model,
 * not that they understood it. The training column is imported from an
 * org-supplied CSV, never derived. Tools Vole has no collector for are
 * absent from the record rather than zero, so the coverage screen must
 * ship alongside it or the record reads as a false negative.
 */
import type { DB } from '../db';

export interface LiteracyRow {
  tool: string;
  model: string | null;
  first_seen: number;
  last_seen: number;
  /** COUNT(DISTINCT session_id) — the sessions this tool/model pair ran in. */
  sessions: number;
  /** Imported training record, where the org supplied one. Never derived. */
  training_completed_at: number | null;
  training_source: string | null;
}

/**
 * The per-subject record: DISTINCT (tool, model) with MIN/MAX(ts) and the
 * distinct session count. Unscoped (no principal) it is the aggregate the
 * fleet view shows; scoped it is the self card.
 */
export function literacyRecord(
  db: DB,
  opts: { principalKey?: string; now?: number } = {},
): LiteracyRow[] {
  const scope = opts.principalKey
    ? `source = 'live' AND (subject_id = ? OR session_id IN
         (SELECT session_id FROM session_identity WHERE principal_key = ?))`
    : `source = 'live'`;
  const params = opts.principalKey ? [opts.principalKey, opts.principalKey] : [];
  const raw = db.prepare(
    `SELECT tool, model, MIN(ts) AS first_seen, MAX(ts) AS last_seen,
            COUNT(DISTINCT session_id) AS sessions
     FROM usage_events WHERE ${scope}
     GROUP BY tool, model ORDER BY tool, model`,
  ).all(...params) as (Omit<LiteracyRow, 'training_completed_at' | 'training_source'>)[];
  return raw.map((r) => ({ ...r, training_completed_at: null, training_source: null }));
}

// ── the org-supplied training column ────────────────────────────────────────

export interface TrainingRecord {
  tool: string;
  completed_at: number | null;
}

/**
 * Parses the org's training CSV. Two shapes accepted: `tool,completed_at`
 * (ISO date or epoch-ms) or a bare first header line the caller names. A
 * missing or unparseable date is NULL, never zero — an unknown completion.
 */
export function parseTrainingCsv(text: string): TrainingRecord[] {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out: TrainingRecord[] = [];
  for (const line of lines) {
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const tool = cells[0] ?? '';
    if (!tool || /^tool$/i.test(tool)) continue; // header
    const raw = cells[1] ?? '';
    const t = /^\d{10,}$/.test(raw) ? Number(raw) : Date.parse(raw);
    out.push({ tool, completed_at: Number.isFinite(t) ? t : null });
  }
  return out;
}

/** Joins the imported training records onto a literacy record by tool name. */
export function withTraining(rows: LiteracyRow[], training: TrainingRecord[], source: string): LiteracyRow[] {
  const byTool = new Map(training.map((t) => [t.tool.toLowerCase(), t]));
  return rows.map((r) => {
    const t = byTool.get(r.tool.toLowerCase());
    return t
      ? { ...r, training_completed_at: t.completed_at, training_source: source }
      : r;
  });
}
