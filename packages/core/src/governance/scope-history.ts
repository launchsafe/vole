import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { DB } from '../db';
import { paths } from '../paths';
import { COLLECTOR_REGISTRY } from '../collectors';

/**
 * The scope-change ledger (§ 87(1) Nr. 6 BetrVG co-determination attaches to
 * changes, not only to introduction). At every collector start Vole hashes
 * everything that defines its monitoring scope — every table:column the store
 * holds, every policy file's content, every collector in the vocabulary — and
 * writes a scope_history row only when the hash CHANGES. The diff is
 * field-level (added and removed field names), so the Privacy Center can render
 * "these are the fields Vole started recording since you last looked".
 *
 * Idempotent by construction: an unchanged scope produces no row, so a
 * collector restarted ten times an hour writes nothing. Timestamps are
 * "first seen", never "changed on" — Vole cannot observe a change made while
 * it was off, and the UI must say so.
 *
 * The schema (migration 23) has no field-list column, so each row's `diff`
 * JSON carries the field list it captured (`fields`); the next capture diffs
 * against that snapshot. First row: diff null — it is the baseline, not a change.
 */

export interface ScopeDiff {
  added: string[];
  removed: string[];
}

export interface StoredDiff extends ScopeDiff {
  /** The full field list this row captured — the next row's diff baseline. */
  fields?: string[];
  /** Present only on deliberate events (appendScopeEvent), not detected changes. */
  event?: string;
}

export interface ScopeHistoryRow {
  id: number;
  captured_at: number;
  sha256: string;
  diff: string | null;
  source: string | null;
}

/** The collector vocabulary = the real collector registry. A new tool IS a scope change. */
const COLLECTOR_VOCABULARY: readonly string[] = COLLECTOR_REGISTRY.map((r) => r.tool);

/**
 * The field set that defines monitoring scope, one string per field:
 *   schema:<table>.<column>   — the store's own shape
 *   policy:<file>:<sha>       — the content of each existing policy input
 *   collector:<tool>          — the collector vocabulary
 */
export function scopeFields(db: DB, policyFiles: string[] = defaultPolicyFiles()): string[] {
  const fields: string[] = [];
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
  ).map((t) => t.name);
  for (const t of tables) {
    const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    for (const c of cols) fields.push(`schema:${t}.${c}`);
  }
  for (const f of policyFiles) {
    if (!existsSync(f)) continue;
    try {
      fields.push(`policy:${f}:${createHash('sha256').update(readFileSync(f)).digest('hex')}`);
    } catch {
      /* unreadable policy file: absent from scope, not a crash */
    }
  }
  for (const tool of COLLECTOR_VOCABULARY) fields.push(`collector:${tool}`);
  return fields.sort();
}

/** The policy inputs whose CONTENT is part of scope — a threshold edit is a scope change. */
function defaultPolicyFiles(): string[] {
  return [
    ...paths.identityPolicyPaths(),
    ...paths.assetsPolicyPaths(),
    ...paths.rulePolicyPaths(),
    ...paths.exclusionPaths(),
    ...paths.surfacePolicyPaths(),
    ...paths.budgetPaths(),
  ];
}

export function scopeSha256(fields: string[]): string {
  return createHash('sha256').update(fields.join('\n')).digest('hex');
}

/** Field-level diff of two field lists (order-insensitive). */
export function scopeDiff(prev: string[], next: string[]): ScopeDiff {
  const a = new Set(prev);
  const b = new Set(next);
  return {
    added: next.filter((f) => !a.has(f)),
    removed: prev.filter((f) => !b.has(f)),
  };
}

export interface CaptureResult {
  sha256: string;
  diff: ScopeDiff | null;
  /** false when the scope was unchanged — nothing was written. */
  changed: boolean;
}

/**
 * Captures the current scope into the ledger. Writes a row only when the
 * sha256 differs from the newest existing row (idempotent restart contract).
 */
export function captureScope(
  db: DB,
  opts: { source?: string; now?: number; policyFiles?: string[] } = {},
): CaptureResult {
  const now = opts.now ?? Date.now();
  const fields = scopeFields(db, opts.policyFiles);
  const sha = scopeSha256(fields);
  const last = latestRow(db);
  if (last && last.sha256 === sha) return { sha256: sha, diff: null, changed: false };
  let diff: ScopeDiff | null = null;
  let stored: StoredDiff | null = null;
  if (last) {
    const prevFields = parseStored(last.diff)?.fields ?? [];
    diff = scopeDiff(prevFields, fields);
    if (diff.added.length || diff.removed.length) stored = { ...diff, fields };
  }
  db.prepare('INSERT INTO scope_history (captured_at, sha256, diff, source) VALUES (?, ?, ?, ?)').run(
    now,
    sha,
    stored ? JSON.stringify(stored) : JSON.stringify({ added: [], removed: [], fields } satisfies StoredDiff),
    opts.source ?? 'collector-start',
  );
  return { sha256: sha, diff, changed: true };
}

function latestRow(db: DB): ScopeHistoryRow | undefined {
  return db
    .prepare('SELECT id, captured_at, sha256, diff, source FROM scope_history ORDER BY id DESC LIMIT 1')
    .get() as ScopeHistoryRow | undefined;
}

function parseStored(s: string | null): StoredDiff | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as StoredDiff;
  } catch {
    return null;
  }
}

/**
 * Appends a deliberate scope event (not a detected change): e.g. the
 * shell-history scanner being switched on, which the spec requires to record
 * who enabled it and when. `what` is a human-readable one-liner.
 */
export function appendScopeEvent(db: DB, what: string, opts: { source?: string; now?: number } = {}): void {
  const fields = scopeFields(db);
  db.prepare('INSERT INTO scope_history (captured_at, sha256, diff, source) VALUES (?, ?, ?, ?)').run(
    opts.now ?? Date.now(),
    scopeSha256(fields),
    JSON.stringify({ added: [], removed: [], event: what } satisfies StoredDiff),
    opts.source ?? 'manual',
  );
}

/** The Privacy Center timeline, newest first, parsed. */
export function scopeTimeline(db: DB): (ScopeHistoryRow & { parsed: StoredDiff | null })[] {
  return (
    db
      .prepare('SELECT id, captured_at, sha256, diff, source FROM scope_history ORDER BY id DESC')
      .all() as ScopeHistoryRow[]
  ).map((r) => ({ ...r, parsed: parseStored(r.diff) }));
}
