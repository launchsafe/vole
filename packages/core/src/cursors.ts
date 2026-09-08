import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import type { DB } from './db';
import { insertAnomalies } from './db';
import type { Anomaly } from './types';

/**
 * The declared-cursor plane (tier 1 #14 + tier 7 #31).
 *
 * Every collector declares WHERE it stopped, in collector_state — the store's
 * one per-source cursor table — and now carries the integrity columns the
 * foundation added: prefix_sha256 (a chained digest over the bytes actually
 * consumed), head_sha256 (first 4 KiB, the O(1) rewritten-probe), inode and
 * birthtime. A byte offset alone cannot tell a truncated-and-regrown file
 * from an appended one; the chained prefix digest can, and a mismatch is the
 * `source_rewritten` incident — the stored rows sourced from that file are
 * then in question, which is a fact an auditor must see rather than infer.
 *
 * Cursor keys are source-stable (paths, db-table ids, UTC bucket epochs).
 * Nothing here ever bakes Date.now() into a key.
 */

export interface CursorRecord {
  source_path: string;
  tool: string;
  last_offset: number;
  last_mtime: number | null;
  last_scanned_at: number | null;
  prefix_sha256: string | null;
  head_sha256: string | null;
  inode: number | null;
  birthtime: number | null;
}

/** The declared cursor for one source key. The key is the collector's contract. */
export function getCursor(db: DB, sourceKey: string): CursorRecord | undefined {
  return db
    .prepare('SELECT * FROM collector_state WHERE source_path = ?')
    .get(sourceKey) as CursorRecord | undefined;
}

/** sha256 of the first `bytes` of a file — the O(1) per-poll rewritten probe. */
export function headSha(path: string, bytes = 4096): string | null {
  try {
    const buf = Buffer.alloc(Math.min(bytes, statSync(path).size));
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buf, 0, buf.length, 0);
    } finally {
      closeSync(fd);
    }
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/**
 * The chained prefix digest: prefix' = sha256(prefix || new_bytes), computed
 * only over bytes not yet consumed — O(new bytes), never a re-read. `prev` is
 * the stored hex digest (null on first sight), `chunk` the newly consumed
 * bytes. Note this chains the *running* digest, not the per-chunk one: the
 * stored value is the digest of everything consumed so far.
 */
export function chainDigest(prev: string | null, chunk: Buffer): string {
  return createHash('sha256').update(prev ? Buffer.from(prev, 'hex') : Buffer.alloc(0)).update(chunk).digest('hex');
}

/**
 * Reads exactly the bytes in [from, to) of a file, for digest chaining when
 * the parse loop already consumed them via another reader.
 */
export function readSlice(path: string, from: number, to: number): Buffer | null {
  const len = to - from;
  if (len <= 0) return null;
  try {
    const buf = Buffer.allocUnsafe(len);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buf, 0, len, from);
    } finally {
      closeSync(fd);
    }
    return buf;
  } catch {
    return null;
  }
}

export interface AdvanceCursor {
  sourceKey: string;
  tool: string;
  /** New byte offset the cursor should hold after this pass. */
  offset: number;
  mtimeMs: number;
  /** Bytes consumed this pass — chained into prefix_sha256. */
  newBytes?: Buffer | null;
  stat?: { ino: number; birthtimeMs: number } | null;
  /** Tool stamped on the source_rewritten anomaly; omit for non-file cursors. */
  anomalyTool?: import('./types').Tool;
}

export interface AdvanceResult {
  /** The stored cursor was replaced or created. */
  stored: boolean;
  /** The source was rewritten under the cursor (offset went backwards or the head digest changed). */
  rewritten: boolean;
}

/**
 * Persists a declared cursor with its integrity columns. Detects the rewrite
 * case — offset beyond current size, a changed head digest, or a changed
 * inode — and fires one `source_rewritten` anomaly per rewrite (the key is
 * the path + the post-rewrite head digest, so a re-detection of the same
 * rewrite is a no-op and a second, later rewrite is a new incident).
 *
 * On rewrite the cursor resets to 0 so the next pass re-reads from the start;
 * the anomaly, not the collector, carries the fact that the old rows are in
 * question.
 */
export function advanceCursor(db: DB, c: AdvanceCursor): AdvanceResult {
  const prev = getCursor(db, c.sourceKey);
  const st = c.stat ?? null;
  let rewritten = false;
  if (prev) {
    if (c.offset < prev.last_offset) rewritten = true;
    else if (st && prev.inode !== null && st.ino !== prev.inode) rewritten = true;
    else if (prev.head_sha256) {
      const now = headSha(c.sourceKey);
      if (now && now !== prev.head_sha256 && c.offset === prev.last_offset) {
        // Same size, same offset, different content: the file was rewritten
        // in place. (A pure append also changes the head only past 4 KiB of
        // growth, which the offset guard below disambiguates — an append
        // grows the offset, so it never reaches this branch.)
        rewritten = true;
      }
    }
  }

  const startOffset = rewritten ? 0 : (prev?.last_offset ?? 0);
  const bytes = c.newBytes ?? (rewritten ? null : readSlice(c.sourceKey, startOffset, c.offset));
  const prefix = bytes ? chainDigest(prev && !rewritten ? prev.prefix_sha256 : null, bytes) : null;

  db.prepare(
    `INSERT INTO collector_state
       (source_path, tool, last_offset, last_mtime, last_scanned_at,
        prefix_sha256, head_sha256, inode, birthtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_path) DO UPDATE SET
       last_offset   = excluded.last_offset,
       last_mtime    = excluded.last_mtime,
       last_scanned_at = excluded.last_scanned_at,
       prefix_sha256 = COALESCE(excluded.prefix_sha256, collector_state.prefix_sha256),
       head_sha256   = COALESCE(excluded.head_sha256, collector_state.head_sha256),
       inode         = COALESCE(excluded.inode, collector_state.inode),
       birthtime     = COALESCE(excluded.birthtime, collector_state.birthtime)`,
  ).run(
    c.sourceKey,
    c.tool,
    c.offset,
    Math.trunc(c.mtimeMs),
    Date.now(), // last_scanned_at is a fact about this pass, not a key — now() is fine here
    prefix,
    headSha(c.sourceKey),
    st ? st.ino : null,
    st ? Math.trunc(st.birthtimeMs) : null,
  );

  if (rewritten && c.anomalyTool) {
    const headNow = headSha(c.sourceKey);
    const anomaly: Anomaly = {
      // Stable per rewrite event: the path plus the post-rewrite head. A
      // re-detection of the same rewrite upserts nothing; a genuinely new
      // rewrite changes the head digest and lands as a new incident.
      anomaly_key: `source_rewritten:${c.sourceKey}:${headNow ?? 'unknown'}`,
      rule: 'source_rewritten',
      severity: 'warn',
      tool: c.anomalyTool ?? 'claude_code',
      session_id: null,
      model: null,
      window_start: Date.now(),
      window_end: Date.now(),
      title: `Source file changed under the cursor: ${c.sourceKey}`,
      detail:
        `The transcript shrank or was rewritten in place below the collector's byte cursor ` +
        `(offset was ${prev!.last_offset}, digest ${prev!.prefix_sha256 ?? 'none'}; ` +
        `stored rows from this file are in question until re-read).`,
      observed: 1,
      baseline: null,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: Date.now(),
    };
    insertAnomalies(db, [anomaly]);
  }
  return { stored: true, rewritten };
}
