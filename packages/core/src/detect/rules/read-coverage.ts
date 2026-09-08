/**
 * Read completeness (tier 5 #35): the keying that makes a re-read after an edit
 * NOT inflate coverage. Coverage is keyed on distinct (file, line-range) — the
 * same window read twice counts once; two windows of one file count twice.
 *
 * Pure: the collector extracts {file_path, startLine, numLines, totalLines,
 * truncatedByTokenCap} from toolUseResult.file; this module reduces them.
 */

export interface ReadWindow {
  file_path: string;
  start_line: number | null;
  num_lines: number | null;
  total_lines: number | null;
  truncated_by_token_cap: boolean | null;
}

/** The coverage key: one file, one line window. start NULL = whole-file read. */
export function lineRangeKey(w: ReadWindow): string {
  const start = w.start_line ?? 1;
  const end = w.num_lines !== null ? start + w.num_lines - 1 : null;
  return `${w.file_path}#${start}-${end ?? 'eof'}`;
}

/**
 * The covered fraction of a file over a set of read windows: the union of line
 * ranges over the largest totalLines any window reported. Returns null when no
 * window carried a totalLines figure — coverage is unknown, never zero.
 */
export function coveredFraction(windows: ReadWindow[]): { covered: number; total: number | null; fraction: number | null } {
  const total = windows.reduce<number | null>((t, w) => (w.total_lines !== null ? Math.max(t ?? 0, w.total_lines) : t), null);
  if (total === null || total === 0) return { covered: 0, total, fraction: null };
  const covered = new Set<number>();
  for (const w of windows) {
    if (w.num_lines === null || w.num_lines <= 0) continue;
    const start = w.start_line ?? 1;
    // ponytail: a set of ints per window; a run-length list is the upgrade if
    // files ever get large enough that this loop is measurable.
    for (let i = start; i < start + w.num_lines && i <= total; i++) covered.add(i);
  }
  return { covered: covered.size, total, fraction: covered.size / total };
}

/** True when the window list shows paging: several truncated reads of one file. */
export function isPagedBulkRead(windows: ReadWindow[]): boolean {
  const byFile = new Map<string, ReadWindow[]>();
  for (const w of windows) {
    const arr = byFile.get(w.file_path);
    if (arr) arr.push(w);
    else byFile.set(w.file_path, [w]);
  }
  for (const [, ws] of byFile) {
    const distinct = new Set(ws.map(lineRangeKey));
    if (distinct.size >= 2 && ws.some((w) => w.truncated_by_token_cap)) return true;
  }
  return false;
}
