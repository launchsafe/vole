import { openSync, readSync, closeSync, statSync } from 'node:fs';

export interface ReadResult {
  /** Raw transcript lines. */
  lines: string[];
  /** Byte offset to resume from next poll. Never points into a partial line. */
  newOffset: number;
  mtimeMs: number;
}

/**
 * Reads only the bytes appended since `fromOffset`, so polling a large log stays cheap.
 *
 * A trailing partial line (the agent is mid-write) is deliberately left unconsumed and
 * re-read next poll. If the file shrank it was rotated or truncated, so we restart at 0.
 */
export function readNewLines(path: string, fromOffset: number): ReadResult {
  const st = statSync(path);
  let start = fromOffset;
  if (st.size < fromOffset) start = 0;
  if (st.size === start) return { lines: [], newOffset: start, mtimeMs: st.mtimeMs };

  const length = st.size - start;
  const buf = Buffer.allocUnsafe(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, length, start);
  } finally {
    closeSync(fd);
  }

  const text = buf.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) {
    // No complete line yet; wait for more bytes.
    return { lines: [], newOffset: start, mtimeMs: st.mtimeMs };
  }

  const complete = text.slice(0, lastNewline);
  const consumedBytes = Buffer.byteLength(complete, 'utf8') + 1;
  const lines = complete.split('\n').filter((l) => l.length > 0);
  return { lines, newOffset: start + consumedBytes, mtimeMs: st.mtimeMs };
}

/** Parses a JSONL line, returning null instead of throwing on malformed input. */
export function parseLine<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

/// A token count read from someone else's log, coerced to a number we can do
/// arithmetic on. `?? 0` guards null and undefined but NOT type: a string makes
/// `+` concatenate ("123" + 7 = "1237", which SQLite's INTEGER affinity then
/// silently stores as 1237), and an object or array produces a value
/// better-sqlite3 cannot bind, throwing out of insertEvents — which aborts the
/// whole pass before any cursor commits, so the next pass throws at the same
/// byte offset, forever.
///
/// Returns 0 for anything that is not a finite number, so an unreadable field
/// contributes nothing rather than fabricating a total. Callers that want the
/// row to degrade to activity_only should check `isCount` first.
export function count(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  const n = Math.floor(v);
  // Out-of-range is rejected, not clamped: rows parked at MAX_SAFE_INTEGER make
  // SUM() unreadable back out of SQLite, trading one bad row for a store whose
  // every aggregate throws. A negative count is not a measurement either — it
  // priced to a NEGATIVE cost, quietly reducing reported spend.
  return Number.isSafeInteger(n) ? n : 0;
}

/// Adds counts and keeps the total inside the safe-integer range.
///
/// Sanitising each field is not enough: several fields at the ceiling sum past it,
/// and SQLite stores that 64-bit integer happily — it is the read back that fails
/// ("Value is too large to be represented as a JavaScript number"), so the row
/// poisons every later pass rather than the one that wrote it.
export function sumCounts(...counts: unknown[]): number {
  let total = 0;
  for (const c of counts) total += count(c);
  return Math.min(total, Number.MAX_SAFE_INTEGER);
}

/// Whether a usage field is a real measurement, as opposed to absent or
/// unreadable. Lets a caller tell "the source recorded 0" from "the source
/// recorded something we cannot trust".
export function isCount(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v));
}
