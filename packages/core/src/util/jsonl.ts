import { openSync, readSync, closeSync, statSync } from 'node:fs';

export interface ReadResult {
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
