/**
 * Tier 8: store_budget — measured bytes per table and index — and the
 * measured reclaim. One row per schema object, refreshed on the scanner
 * cadence, never in the 5-second loop. dbstat is a compile-time option: the
 * probe runs at runtime and per-object bytes go NULL, never estimated or
 * divided evenly, when the SQLite that froze into the binary lacks it —
 * leaving only the file total, which every surface can always show.
 *
 * The reclaim gate is NOT freelist_count (it reads 0 while a full VACUUM
 * still reclaims pages by defragmentation alone): the honest sequence is
 * check free disk ≥ file size, VACUUM INTO a scratch copy, compare, delete
 * the scratch, and run the in-place VACUUM only when the measured delta
 * clears a threshold. The reclaimed figure reported is the one observed on
 * this machine's own data, never a rule of thumb.
 */
import { rmSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db';

export interface StoreFileSizes {
  db: number | null;
  wal: number | null;
  shm: number | null;
}

export function storeFileSizes(dbPath: string): StoreFileSizes {
  const size = (p: string): number | null => {
    try {
      return statSync(p).size;
    } catch {
      return null;
    }
  };
  return { db: size(dbPath), wal: size(`${dbPath}-wal`), shm: size(`${dbPath}-shm`) };
}

export interface PageFacts {
  page_count: number;
  page_size: number;
  freelist_count: number;
  /** page_count × page_size — the only figure every surface can show today. */
  file_bytes: number;
}

export function pageFacts(db: DB): PageFacts {
  const page_count = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  const page_size = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  const freelist_count = (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;
  return { page_count, page_size, freelist_count, file_bytes: page_count * page_size };
}

/** dbstat is a compile-time option — probed at runtime, never assumed. */
export function dbstatAvailable(db: DB): boolean {
  try {
    db.prepare('SELECT 1 FROM dbstat LIMIT 1').get();
    return true;
  } catch {
    return false;
  }
}

export interface BudgetRow {
  object: string;
  kind: 'table' | 'index';
  bytes: number | null;
  rows: number | null;
  bytes_per_row: number | null;
}

/** Measured bytes per table and index via dbstat; rows via COUNT. NULL when unmeasurable. */
export function measureObjects(db: DB): { rows: BudgetRow[]; dbstat: boolean } {
  const dbstat = dbstatAvailable(db);
  const tables = (db.prepare(
    `SELECT name FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%'`,
  ).all() as { name: string }[]).map((r) => r.name);
  const tableSet = new Set(tables);
  const out: BudgetRow[] = [];
  if (dbstat) {
    const sizes = db.prepare(
      `SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name`,
    ).all() as { name: string; bytes: number }[];
    for (const s of sizes) {
      const kind: 'table' | 'index' = tableSet.has(s.name) ? 'table' : 'index';
      const rows =
        kind === 'table'
          ? (db.prepare(`SELECT COUNT(*) AS n FROM "${s.name}"`).get() as { n: number }).n
          : null; // an index holds no rows of its own; NULL, never zero
      out.push({
        object: s.name,
        kind,
        bytes: s.bytes,
        rows,
        bytes_per_row: rows !== null && rows > 0 ? s.bytes / rows : null,
      });
    }
  } else {
    for (const t of tables) {
      const rows = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
      out.push({ object: t, kind: 'table', bytes: null, rows, bytes_per_row: null });
    }
  }
  return { rows: out, dbstat };
}

/** Refreshes the store_budget table: one row per object, measured_at stamped. */
export function measureStoreBudget(db: DB, now: number = Date.now()): {
  rows: BudgetRow[]; dbstat: boolean; pages: PageFacts;
} {
  const measured = measureObjects(db);
  const pages = pageFacts(db);
  const upsert = db.prepare(
    `INSERT INTO store_budget (object, kind, bytes, rows, bytes_per_row, measured_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(object, kind) DO UPDATE SET
       bytes = excluded.bytes, rows = excluded.rows,
       bytes_per_row = excluded.bytes_per_row, measured_at = excluded.measured_at`,
  );
  const run = db.transaction((rows: BudgetRow[]) => {
    for (const r of rows) {
      upsert.run(r.object, r.kind, r.bytes, r.rows, r.bytes_per_row, now);
    }
  });
  run(measured.rows);
  return { ...measured, pages };
}

export type ReclaimState = 'not_measured' | 'measured' | 'reclaimed';

export interface ReclaimResult {
  state: ReclaimState;
  /** Why a skipped run is reported as skipped, never as success. */
  detail: string;
  file_bytes: number | null;
  free_bytes: number | null;
  vacuumed_bytes: number | null;
  /** The delta observed on the scratch copy (the measurement). */
  reclaimable_bytes: number | null;
  /** Whether the in-place VACUUM ran. */
  applied: boolean;
}

/**
 * Measured reclaim. statfs gate first (free ≥ file size), VACUUM INTO scratch,
 * compare, delete the scratch, and run the in-place VACUUM only when the
 * measured delta clears the threshold. VACUUM takes an exclusive lock — at
 * 30K rows that is tens of milliseconds; a fleet store that grows needs the
 * ponytail upgrade path: run it from a maintenance window, not a poll.
 */
export function measuredReclaim(
  db: DB,
  dbPath: string,
  opts: { thresholdBytes?: number; apply?: boolean } = {},
): ReclaimResult {
  const threshold = opts.thresholdBytes ?? 262_144; // ponytail: 256 KiB default, pass a policy value when it matters
  let fileBytes: number | null;
  try {
    fileBytes = statSync(dbPath).size;
  } catch {
    return { state: 'not_measured', detail: 'store file not found', file_bytes: null, free_bytes: null, vacuumed_bytes: null, reclaimable_bytes: null, applied: false };
  }
  let freeBytes: number | null;
  try {
    const fs = statfsSync(dbPath);
    freeBytes = fs.bavail * fs.bsize;
  } catch {
    freeBytes = null; // unknown, never zero
  }
  if (freeBytes !== null && freeBytes < fileBytes) {
    return {
      state: 'not_measured',
      detail: `not measured — ${fileBytes} required, ${freeBytes} free`,
      file_bytes: fileBytes, free_bytes: freeBytes, vacuumed_bytes: null, reclaimable_bytes: null, applied: false,
    };
  }
  // Checkpoint the WAL first so the main file holds the store: otherwise the
  // scratch copy (which checkpoints by construction) measures larger than a
  // main file whose data still sits in -wal, and the delta reads as negative.
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    fileBytes = statSync(dbPath).size;
  } catch {
    /* a busy checkpoint is not fatal: the delta is then conservative */
  }
  const scratch = `${dbPath}.reclaim-probe`;
  try {
    db.prepare('VACUUM INTO ?').run(scratch);
  } catch (e) {
    return {
      state: 'not_measured',
      detail: `VACUUM INTO failed: ${e instanceof Error ? e.message : String(e)}`,
      file_bytes: fileBytes, free_bytes: freeBytes, vacuumed_bytes: null, reclaimable_bytes: null, applied: false,
    };
  }
  let scratchBytes: number | null = null;
  try {
    scratchBytes = statSync(scratch).size;
  } catch {
    /* measured null below */
  } finally {
    try {
      rmSync(scratch);
    } catch {
      /* best effort: the scratch is inert */
    }
  }
  if (scratchBytes === null) {
    return { state: 'not_measured', detail: 'scratch copy vanished before stat', file_bytes: fileBytes, free_bytes: freeBytes, vacuumed_bytes: null, reclaimable_bytes: null, applied: false };
  }
  const delta = fileBytes - scratchBytes;
  const applied = opts.apply === true && delta >= threshold;
  if (applied) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    db.exec('PRAGMA optimize');
  }
  return {
    state: applied ? 'reclaimed' : 'measured',
    detail: applied
      ? `in-place VACUUM run: ${delta} bytes measured reclaimable on the scratch copy`
      : `measured ${delta} bytes reclaimable (threshold ${threshold}); pass --apply to run the in-place VACUUM`,
    file_bytes: fileBytes,
    free_bytes: freeBytes,
    vacuumed_bytes: applied ? statSync(dbPath).size : null,
    reclaimable_bytes: delta,
    applied,
  };
}
