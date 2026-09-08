import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Database } from './sqlite';
import type { DB } from './db';

/**
 * Backfill as a declared, resumable step (tier 1 #23).
 *
 * The usage_events upsert only rewrites a row when its tokens grow, so a
 * column a later version starts filling stays NULL on every pre-existing row
 * forever unless something explicitly UPDATEs it. This module is that
 * something, shaped as the migration ledger already is: each step names its
 * still-NULL population, runs over at most `rowsPerPass` rows per call,
 * oldest-first (the rows nearest the evidence horizon fill before their
 * source disappears), and keeps a resumable cursor in collector_state under
 * `backfill/<step>` so a poll interrupted mid-step resumes where it stopped.
 *
 * The cursor is the last usage_events.id processed — a stable rowid, never
 * a now()-derived value. A pass that finds nothing advances nothing, so
 * calling this every poll is free.
 */

export interface BackfillStepResult {
  name: string;
  /** Rows the step examined this pass (the bounded window). */
  rowsExamined: number;
  /** Rows actually filled (still-NULL column gained a value). */
  rowsChanged: number;
  /** Rows whose source can no longer prove the column — permanent unknowns. */
  unbackfillable: number;
  /** Last usage_events.id processed; null when the step has nothing pending. */
  cursor: number | null;
  /** True when no pending rows remain for this step. */
  done: boolean;
  note?: string;
}

export interface BackfillStep {
  name: string;
  /** SELECT id ... naming the still-NULL population, oldest-first, bounded. */
  pending: (db: DB, rowsPerPass: number, cursor: number) => { id: number; raw_ref: string | null }[];
  /** Fill one row's NULL column(s) from evidence. Returns the value change count. */
  apply: (db: DB, rows: { id: number; raw_ref: string | null }[]) => number;
}

// ── the evidence: ~/.codex/state_5.sqlite, the thread registry ───────────────

interface CodexThread {
  id: string;
  rollout_path: string | null;
  git_branch: string | null;
}

/**
 * state_5.sqlite's `threads` table carries the git branch per rollout path —
 * the exact column codex.ts could not see at insert time before this store
 * existed. `first_user_message` is PROMPT CONTENT and is never SELECTed.
 */
export function codexThreads(codexHome = join(homedir(), '.codex')): Map<string, string> {
  const map = new Map<string, string>();
  const dbPath = join(codexHome, 'state_5.sqlite');
  if (!existsSync(dbPath)) return map;
  let src: InstanceType<typeof Database>;
  try {
    src = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return map;
  }
  try {
    const rows = src
      .prepare('SELECT id, rollout_path, git_branch FROM threads WHERE git_branch IS NOT NULL AND rollout_path IS NOT NULL')
      .all() as CodexThread[];
    for (const t of rows) map.set(t.rollout_path!, t.git_branch!);
  } finally {
    src.close();
  }
  return map;
}

/** Step: git_branch for codex rows, from the thread registry keyed by rollout path. */
function makeCodexGitBranch(codexHome: string): BackfillStep {
  return {
    name: 'codex-git-branch',
    pending: (db, rowsPerPass, cursor) =>
      db
        .prepare(
          `SELECT id, raw_ref FROM usage_events
            WHERE tool = 'codex' AND git_branch IS NULL AND raw_ref IS NOT NULL AND id > ?
            ORDER BY id LIMIT ?`,
        )
        .all(cursor, rowsPerPass) as { id: number; raw_ref: string | null }[],
    apply: (db, rows) => {
      const branches = codexThreads(codexHome);
      const upd = db.prepare('UPDATE usage_events SET git_branch = ? WHERE id = ? AND git_branch IS NULL');
      let n = 0;
      for (const r of rows) {
        // raw_ref is "<rollout path>#<index>" — the path is the join key.
        const path = r.raw_ref?.split('#')[0] ?? '';
        const branch = branches.get(path);
        if (branch) n += upd.run(branch, r.id).changes;
      }
      return n;
    },
  };
}

export const BACKFILL_STEPS = (codexHome = join(homedir(), '.codex')): BackfillStep[] => [
  makeCodexGitBranch(codexHome),
];

/** The step's declared cursor, kept in collector_state like every other cursor. */
function stepCursor(db: DB, name: string): number {
  const row = db
    .prepare('SELECT last_offset FROM collector_state WHERE source_path = ?')
    .get(`backfill/${name}`) as { last_offset: number } | undefined;
  return row?.last_offset ?? 0;
}

function setStepCursor(db: DB, name: string, cursor: number): void {
  db.prepare(
    `INSERT INTO collector_state (source_path, tool, last_offset, last_mtime, last_scanned_at)
     VALUES (?, 'backfill', ?, NULL, ?)
     ON CONFLICT(source_path) DO UPDATE SET
       last_offset = excluded.last_offset,
       last_scanned_at = excluded.last_scanned_at`,
  ).run(`backfill/${name}`, cursor, Date.now());
}

/**
 * Runs every declared step once, bounded. Returns each step's result so a
 * Backfill UI can print rows filled / remaining / unbackfillable with the
 * pass cursor — and 'paused — collector busy' is simply the caller choosing
 * not to call this while a pass is holding the write lock.
 */
export function runBackfill(db: DB, rowsPerPass = 500, codexHome = join(homedir(), '.codex')): BackfillStepResult[] {
  const out: BackfillStepResult[] = [];
  for (const step of BACKFILL_STEPS(codexHome)) {
    const cursor = stepCursor(db, step.name);
    const rows = step.pending(db, rowsPerPass, cursor);
    const rowsChanged = step.apply(db, rows);
    // Rows examined this pass that did NOT gain a value: either their evidence
    // is gone (unbackfillable — the rollout path is not in the registry) or
    // the window simply ended. Both advance the cursor; the split is reported.
    let unbackfillable = 0;
    if (rows.length) {
      const stillNull = db
        .prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE id IN (${rows.map(() => '?').join(',')}) AND git_branch IS NULL`)
        .get(...rows.map((r) => r.id)) as { n: number };
      unbackfillable = stillNull.n;
    }
    const newCursor = rows.length ? rows[rows.length - 1]!.id : cursor;
    if (newCursor !== cursor) setStepCursor(db, step.name, newCursor);
    out.push({
      name: step.name,
      rowsExamined: rows.length,
      rowsChanged,
      unbackfillable,
      cursor: newCursor || null,
      done: rows.length < rowsPerPass,
    });
  }
  return out;
}
