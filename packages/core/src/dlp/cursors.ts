import { openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { contentOf } from '../content';
import { openRootFile, scanBuffer, type RawSighting } from './engine';

/**
 * The out-of-path cursor machinery (tier 4, #122): a DLP scanner cannot reuse
 * collector_state.last_offset — the collectors already advanced it to EOF — so
 * dlp_scan_state carries its own resumable cursor per sink. The shape is
 * (file path, byte offset, inode): a pass that exhausts its byte budget mid-file
 * resumes at exactly that byte next pass instead of rescanning sink 0 forever —
 * the livelock the cursor design exists to prevent.
 *
 * Within a sink, files are walked in path order (stable across passes — mtime
 * reorders); the ACROSS-sink order is oldest-first, set by the scanner, so
 * backfill captures evidence closest to vendor deletion first.
 */

export interface SinkCursor {
  cursorKind: 'file_offset' | null;
  /** Path of the last file reached (fully or partially). */
  cursorText: string | null;
  /** Byte offset within cursorText. */
  cursorInt: number | null;
  /** inode of cursorText — a rewrite that keeps size but changes inode rewinds. */
  inode: number | null;
  /** True once every pre-existing byte has been covered at least once. */
  backfillDone: boolean;
  /** Epoch-ms of the last completed pass (the tail-scan watermark). */
  lastSeenAt: number | null;
}

export const EMPTY_CURSOR: SinkCursor = {
  cursorKind: null, cursorText: null, cursorInt: null, inode: null,
  backfillDone: false, lastSeenAt: null,
};

export interface SinkScanOutcome {
  sinkKey: string;
  path: string;
  sightings: RawSighting[];
  bytesScanned: number;
  bytesSkipped: number;      // exclusions: measured, never a constant
  bytesUnreadable: number;
  bytesAvailable: number | null; // the denominator: total bytes under the sink
  filesScanned: number;
  filesSkipped: number;
  filesUnreadable: number;
  /** False when the byte budget stopped this sink mid-walk. */
  completed: boolean;
  backfillDone: boolean;
  next: SinkCursor;
  /** Unscanned bytes within EXPIRY_HORIZON_DAYS of the vendor's deletion sweep. */
  expiring: { files: number; bytes: number } | null;
}

const MAX_FILES_PER_SINK = 20000; // ponytail: raise with a manifest-driven priority order
export const EXPIRY_HORIZON_DAYS = 3;

interface SinkFile { path: string; size: number; mtime: number; inode: number }

function walk(root: string): { files: SinkFile[]; listed: boolean } {
  const files: SinkFile[] = [];
  let listed = true;
  const walkDir = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      listed = false;
      return;
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES_PER_SINK) return;
      const p = join(dir, e.name);
      try {
        const st = statSync(p);
        if (e.isDirectory()) walkDir(p);
        else if (e.isFile()) files.push({ path: p, size: st.size, mtime: Math.trunc(st.mtimeMs), inode: Number(st.ino) });
      } catch {
        /* a file that vanishes mid-walk: it contributes nothing */
      }
    }
  };
  try {
    const st = statSync(root);
    if (st.isDirectory()) walkDir(root);
    else if (st.isFile()) files.push({ path: root, size: st.size, mtime: Math.trunc(st.mtimeMs), inode: Number(st.ino) });
  } catch {
    return { files: [], listed: false };
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, listed };
}

/** Reads at most `budget` bytes of `file` starting at byte `start`. */
function readChunk(file: string, start: number, budget: number): string | null {
  if (budget <= 0) return null;
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(budget, 4 * 1024 * 1024));
    let filled = 0;
    while (filled < buf.length) {
      // A resumed offset can land mid-UTF-8-sequence: leading continuation
      // bytes are skipped so the decoder starts on a character boundary.
      const n = readSync(fd, buf, filled, buf.length - filled, start + filled);
      if (n === 0) break;
      filled += n;
    }
    let begin = 0;
    while (begin < filled && (buf[begin]! & 0xc0) === 0x80 && begin < 4) begin++;
    return buf.subarray(begin, filled).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export interface ScanOptions {
  /** Retention in days the vendor itself enforces (Claude cleanupPeriodDays); null = unknown. */
  retentionDays: number | null;
  now?: number;
}

/**
 * Scans one sink resumably under a byte budget. Exclusions are enforced at
 * openRootFile — the single chokepoint — and every skipped byte is counted
 * (bytesSkipped is a measured sum of file sizes, never a constant).
 */
export function scanSinkResumable(
  sinkKey: string,
  sinkPath: string,
  budget: number,
  cursor: SinkCursor,
  opts: ScanOptions,
): SinkScanOutcome {
  const now = opts.now ?? Date.now();
  const { files, listed } = walk(sinkPath);
  const bytesAvailable = listed ? files.reduce((n, f) => n + f.size, 0) : null;

  const out: SinkScanOutcome = {
    sinkKey, path: sinkPath, sightings: [],
    bytesScanned: 0, bytesSkipped: 0, bytesUnreadable: 0,
    bytesAvailable, filesScanned: 0, filesSkipped: 0, filesUnreadable: 0,
    completed: true, backfillDone: cursor.backfillDone,
    next: { ...cursor },
    expiring: null,
  };

  if (!listed || files.length === 0) {
    out.next = { ...EMPTY_CURSOR, backfillDone: true, lastSeenAt: now };
    return out;
  }

  let remaining = budget;
  let stopIndex = files.length; // index of the first file NOT covered this pass
  const expiring = { files: 0, bytes: 0 };

  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;

    // Budget gone: this file and everything after it is unscanned this pass.
    if (remaining <= 0) {
      out.completed = false;
      stopIndex = i;
      break;
    }

    let start = 0;

    if (cursor.backfillDone) {
      // Tail pass: only files the vendor (or the user) touched since the last
      // pass. An in-place rewrite that preserves both size and mtime is missed
      // until the file grows — the spec's stated limit, priced in bytes not
      // in hangs. ponytail: content-hash watermarks if silent rewrites matter.
      if (f.mtime <= (cursor.lastSeenAt ?? 0)) { continue; }
    } else if (cursor.cursorText) {
      if (f.path < cursor.cursorText) continue;                       // covered by an earlier pass
      if (f.path === cursor.cursorText) {
        const sameFile = cursor.inode !== null && cursor.inode === f.inode;
        start = sameFile ? Math.min(cursor.cursorInt ?? 0, f.size) : 0; // inode change: rewind
        if (start >= f.size) continue;                                 // fully covered
      }
    }

    // Expiry, for bytes this pass did NOT reach: stopIndex is updated below.
    const opened = openRootFile(f.path);
    if (opened.kind === 'excluded') {
      out.bytesSkipped += opened.size; // measured, never a constant
      out.filesSkipped++;
      continue;
    }
    if (opened.kind === 'unreadable') {
      out.bytesUnreadable += opened.size ?? 0;
      out.filesUnreadable++;
      continue; // the honest denominator
    }

    const chunk = readChunk(f.path, start, remaining);
    if (chunk === null) {
      out.bytesUnreadable += f.size - start;
      out.filesUnreadable++;
      continue;
    }
    const scanBytes = Buffer.byteLength(chunk, 'utf8');
    out.bytesScanned += scanBytes;
    out.filesScanned++;
    remaining -= scanBytes;

    for (const s of scanBuffer(contentOf(chunk), start)) out.sightings.push(s);

    out.next = {
      cursorKind: 'file_offset',
      cursorText: f.path,
      cursorInt: start + scanBytes,
      inode: f.inode,
      backfillDone: false,
      lastSeenAt: null,
    };

    if (start + scanBytes < f.size) {
      // Budget stopped mid-file: resume here next pass.
      out.completed = false;
      stopIndex = i;
      break;
    }
    stopIndex = i + 1;
    if (remaining <= 0 && i + 1 < files.length) {
      out.completed = false;
      break;
    }
  }

  // Evidence expiry (tier 4, #133): unscanned bytes within the horizon of the
  // vendor's own deletion sweep. Vole can warn but never preserve — the
  // constraints forbid copying third-party stores.
  if (opts.retentionDays !== null) {
    for (let i = stopIndex; i < files.length; i++) {
      const f = files[i]!;
      const age = (now - f.mtime) / 86_400_000;
      if (opts.retentionDays - age <= EXPIRY_HORIZON_DAYS) {
        expiring.files++;
        expiring.bytes += f.size;
      }
    }
    if (expiring.files > 0) out.expiring = expiring;
  }

  if (out.completed && !cursor.backfillDone) out.backfillDone = true;
  if (out.completed) out.next = { ...out.next, backfillDone: true, lastSeenAt: now };
  return out;
}
