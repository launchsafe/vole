import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db';

/**
 * The processing_terms pack and its as-of-the-evidence lookup (tier 6 #42).
 * Every field is a DATED ASSERTION with a citation, never a measurement: Vole
 * cannot verify what a vendor does with received bytes. The in_force_from/to
 * interval is the whole point — `termsAsOf` returns the terms that were
 * published when the bytes moved, not the terms published today.
 */

export interface TermsPackEntry {
  /** Recipient identity, e.g. 'anthropic', 'github-copilot' (resolved, never the model name). */
  recipient_id: string;
  legal_entity: string | null;
  processing_regions: string[] | null;
  trains_on_input: boolean | null;
  /** The vendor's published retention default (the cleanupPeriodDays-style fact). */
  retention_days: number | null;
  sub_processor_of: string | null;
  /** The plan token this entry applies to; null = the default entry. */
  plan_condition: string | null;
  /** 'consumer' | 'team' | 'enterprise' | the vendor's own scope token. */
  contract_scope: string | null;
  citation_url: string | null;
  /** ISO date — when the pack author recorded the assertion. */
  asserted_as_of: string | null;
  /** Epoch-ms, NULL = open-ended. */
  in_force_from: number | null;
  in_force_to: number | null;
}

export interface ProcessingTermsPack {
  version: number;
  entries: TermsPackEntry[];
  /** Where the pack was read from; NULL = the empty built-in floor. */
  path: string | null;
}

/** The floor every hunt and every register render falls back to: nothing asserted. */
export const EMPTY_TERMS_PACK: ProcessingTermsPack = { version: 0, entries: [], path: null };

/**
 * Reads the highest-version processing_terms.<version>.json across the pack
 * directories (later directories win, the same precedence packPaths uses).
 * A malformed file is ignored — terms must never break a hunt.
 */
export function loadProcessingTermsPack(packDirs: string[]): ProcessingTermsPack {
  let best: ProcessingTermsPack | null = null;
  for (const dir of packDirs) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const m = n.match(/^processing_terms\.(\d+)\.(json|jsonc)$/);
      if (!m) continue;
      const version = Number(m[1]);
      if (best && version < best.version) continue;
      try {
        const entries = JSON.parse(readFileSync(join(dir, n), 'utf8')) as TermsPackEntry[];
        if (Array.isArray(entries)) best = { version, entries, path: join(dir, n) };
      } catch {
        // malformed candidate: skip, the previous best stands
      }
    }
  }
  return best ?? EMPTY_TERMS_PACK;
}

function inForceAt(e: TermsPackEntry, ts: number): boolean {
  return (e.in_force_from === null || e.in_force_from <= ts) && (e.in_force_to === null || ts < e.in_force_to);
}

/**
 * The as-of resolver: the terms that were in force when the evidence moved.
 * A plan-specific entry wins over the default; NULL when nothing was in force
 * at that instant (the register then says 'no entry in force', never 'today's').
 */
export function termsAsOf(
  pack: ProcessingTermsPack,
  recipient_id: string,
  plan_token: string | null,
  evidence_ts: number,
): TermsPackEntry | null {
  const applicable = pack.entries.filter((e) => e.recipient_id === recipient_id && inForceAt(e, evidence_ts));
  // A plan-specific entry wins over the default; within the chosen condition
  // set, the latest in_force_from wins.
  const condition = plan_token !== null ? plan_token : null;
  const shaped = applicable.filter((e) => e.plan_condition === condition);
  const pool = shaped.length ? shaped : applicable.filter((e) => e.plan_condition === null);
  return pool.reduce<TermsPackEntry | null>(
    (best, e) => (best === null || (e.in_force_from ?? 0) > (best.in_force_from ?? 0) ? e : best),
    null,
  );
}

// ── The vendor retention clock (tier 6 #48) ─────────────────────────────────

export type RetentionChip = '14d' | '7d' | '48h' | 'elapsed' | 'uncomputable';

export interface RetentionClockRow {
  evidence_ts: number;
  recipient_id: string;
  plan_token: string | null;
  retention_days: number | null;
  deletion_window_ends_at: number | null;
  days_until_deletion: number | null;
  chip: RetentionChip;
  /** The figures that fired: pack version, in-force interval, retention days, citation. */
  basis: string | null;
}

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * `deletion_window_ends_at = evidence_ts + retention_days(recipient,
 * contract_scope, in_force_at(evidence_ts))`, plus the stepped chip the Leak
 * Ledger column renders. Retention days are the vendor's published default —
 * a legal hold or training snapshot outlives the window invisibly, so the chip
 * never claims a deletion happened, only that a request falls inside it.
 */
export function vendorRetentionClock(
  rows: Array<{ evidence_ts: number; recipient_id: string; plan_token?: string | null }>,
  pack: ProcessingTermsPack,
  now: number,
): RetentionClockRow[] {
  return rows.map((r) => {
    const entry = termsAsOf(pack, r.recipient_id, r.plan_token ?? null, r.evidence_ts);
    const days = entry?.retention_days ?? null;
    const ends_at = days !== null && Number.isFinite(days) ? r.evidence_ts + days * 86_400_000 : null;
    const days_left = ends_at !== null ? (ends_at - now) / 86_400_000 : null;
    const chip: RetentionChip =
      days_left === null
        ? 'uncomputable'
        : days_left < 0
          ? 'elapsed'
          : days_left >= 14
            ? '14d'
            : days_left >= 7
              ? '7d'
              : '48h';
    const basis = entry
      ? `pack v${pack.version} in force ${fmtDate(entry.in_force_from ?? r.evidence_ts)}–` +
        `${entry.in_force_to === null ? 'open' : fmtDate(entry.in_force_to)}, retention ${days}d` +
        (entry.citation_url ? `, cited ${entry.citation_url}` : '')
      : null;
    return {
      evidence_ts: r.evidence_ts,
      recipient_id: r.recipient_id,
      plan_token: r.plan_token ?? null,
      retention_days: days,
      deletion_window_ends_at: ends_at,
      days_until_deletion: days_left,
      chip,
      basis,
    };
  });
}

// ── The per-surface projection the processing register reads ────────────────

export type ProcessingTermsKind =
  | 'legal_entity'
  | 'processing_region'
  | 'trains_on_input'
  | 'retention_days'
  | 'sub_processor_of'
  | 'contract_scope';

export interface ProcessingTermsRow {
  surface_key: string;
  kind: ProcessingTermsKind;
  value: string | null;
  /** The evidence timestamp the as-of lookup resolved against. */
  as_of: number | null;
  now?: number;
}

const INSERT_TERMS = `
INSERT INTO processing_terms (surface_key, kind, value, as_of, first_seen, last_seen)
VALUES (@surface_key, @kind, @value, @as_of, @now, @now)
ON CONFLICT(surface_key, kind) DO UPDATE SET
  value     = COALESCE(processing_terms.value, excluded.value),
  as_of     = COALESCE(processing_terms.as_of, excluded.as_of),
  last_seen = MAX(processing_terms.last_seen, excluded.last_seen)`;

/** Idempotent NULL-only widening upsert into the processing_terms table. */
export function recordProcessingTerms(db: DB, rows: ProcessingTermsRow[]): number {
  if (!rows.length) return 0;
  const stmt = db.prepare(INSERT_TERMS);
  const run = db.transaction((rs: ProcessingTermsRow[]) => {
    let changed = 0;
    const now = rs[0]?.now ?? Date.now();
    for (const r of rs) {
      changed += stmt.run({
        surface_key: r.surface_key,
        kind: r.kind,
        value: r.value,
        as_of: r.as_of,
        now: r.now ?? now,
      }).changes;
    }
    return changed;
  });
  return run(rows);
}

/** Flattens one resolved pack entry into the per-surface rows the register renders. */
export function processingTermsRowsFor(
  surface_key: string,
  entry: TermsPackEntry,
  as_of: number,
): ProcessingTermsRow[] {
  const rows: ProcessingTermsRow[] = [
    { surface_key, kind: 'legal_entity', value: entry.legal_entity, as_of },
    { surface_key, kind: 'trains_on_input', value: entry.trains_on_input === null ? null : String(entry.trains_on_input), as_of },
    { surface_key, kind: 'retention_days', value: entry.retention_days === null ? null : String(entry.retention_days), as_of },
    { surface_key, kind: 'sub_processor_of', value: entry.sub_processor_of, as_of },
    { surface_key, kind: 'contract_scope', value: entry.contract_scope, as_of },
  ];
  if (entry.processing_regions?.length) {
    // One row per kind (the UNIQUE key): multiple regions comma-join in value.
    rows.push({ surface_key, kind: 'processing_region', value: entry.processing_regions.join(','), as_of });
  }
  return rows;
}
