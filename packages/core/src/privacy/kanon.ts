/**
 * Tier 8: k-anonymity with complementary suppression for aggregate mode.
 * Primary suppression alone leaks: a single suppressed cell is recovered from
 * the published margins by subtraction, and a row with exactly one suppressed
 * cell always is. This is the standard two-pass rule — suppress cells with
 * n < k, then suppress additional cells per row and per column until no
 * suppressed value is derivable from published margins, and never publish a
 * margin whose complement is one suppressed cell.
 *
 * k counts DISTINCT SUBJECTS, not devices and not calls: one person with a
 * laptop and a desktop is one subject. Suppression is computed per
 * publication; differencing successive publications with shifting cell sets
 * can still reconstruct a cell — the docs must state a fixed publication
 * schedule with a stable cell set as a deployment requirement.
 */
import type { DB } from '../db';

/** k from the policy block (`kanon.k`); default 5 when the org declared nothing. */
export function policyK(kanonBlock: { k?: unknown } | null | undefined): number {
  const k = kanonBlock?.k;
  // ponytail: no distributional reasoning — an undeclared k is the roadshow default 5.
  return typeof k === 'number' && k >= 2 && Number.isInteger(k) ? k : 5;
}

export interface DailyCell {
  /** UTC day bucket epoch (floor(ts / 86_400_000)) — stable, never now()-derived. */
  day: number;
  tool: string;
  model: string | null;
  /** The project's basename slug; the full path never enters an aggregate. */
  project_slug: string | null;
  /** Distinct subjects (COALESCE(subject_id, user)) in the cell. */
  n: number;
}

/** The daily rollup the grid is built from: (day, tool, model, project-slug). */
export function dailyRollup(db: DB, from: number, to: number): DailyCell[] {
  return db.prepare(
    `SELECT CAST(ts / 86400000 AS INTEGER) AS day, tool, model, project AS project_raw,
            COUNT(DISTINCT COALESCE(NULLIF(subject_id, ''), user)) AS n
     FROM usage_events
     WHERE source = 'live' AND ts >= ? AND ts < ?
     GROUP BY day, tool, model, project_raw`,
  ).all(from, to).map((r) => {
    const row = r as { day: number; tool: string; model: string | null; project_raw: string | null; n: number };
    const slug = row.project_raw === null ? null : row.project_raw.split('/').pop()?.replace(/\.git$/, '') ?? null;
    return { day: row.day, tool: row.tool, model: row.model, project_slug: slug, n: row.n };
  });
}

export interface Grid {
  rowLabels: string[];
  colLabels: number[];
  /** values[i][j] = distinct subjects for rowLabel i on day colLabels[j]. */
  values: number[][];
}

/** Cells → grid. Row label is tool|model|slug; columns are the UTC days present. */
export function toGrid(cells: DailyCell[]): Grid {
  const rows = new Map<string, Map<number, number>>();
  const days = new Set<number>();
  for (const c of cells) {
    const label = `${c.tool}|${c.model ?? '—'}|${c.project_slug ?? '—'}`;
    let byDay = rows.get(label);
    if (!byDay) rows.set(label, (byDay = new Map()));
    byDay.set(c.day, (byDay.get(c.day) ?? 0) + c.n);
    days.add(c.day);
  }
  const rowLabels = [...rows.keys()].sort();
  const colLabels = [...days].sort((a, b) => a - b);
  const values = rowLabels.map((l) => colLabels.map((d) => rows.get(l)!.get(d) ?? 0));
  return { rowLabels, colLabels, values };
}

export interface SuppressionResult {
  /** suppressed[i][j] = true when the cell must not be published. */
  suppressed: boolean[][];
  /** Cells with n < k (the first pass). */
  primary: number;
  /** Cells suppressed only to protect the margins (the second pass). */
  complementary: number;
  /** Row margins; null = withheld (its complement would be derivable). */
  rowMargins: (number | null)[];
  /** Column (per-day) margins; null = withheld. */
  colMargins: (number | null)[];
  /** The grand total; null = withheld when exactly one cell is suppressed overall. */
  grandTotal: number | null;
  k: number;
}

/**
 * The two-pass rule. Iteratively: any row or column containing exactly one
 * suppressed cell gets one more cell suppressed (the smallest published
 * value), or its margin withheld when it has no other cell; the grand total
 * is withheld while the whole grid has exactly one suppressed cell. End state:
 * every row and column has 0 or ≥2 suppressed cells, so no suppressed value
 * follows from any published margin.
 */
export function twoPassSuppression(values: number[][], k: number): SuppressionResult {
  const nRows = values.length;
  const nCols = nRows === 0 ? 0 : values[0]!.length;
  const suppressed: boolean[][] = values.map((row) => row.map((n) => n < k));
  let primary = 0;
  for (const row of suppressed) for (const s of row) if (s) primary++;
  let complementary = 0;

  const withheldRow = new Set<number>();
  const withheldCol = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    // Row pass: exactly one suppressed cell in the row → suppress the smallest
    // published cell too, or withhold the margin when the row has no other cell.
    for (let i = 0; i < nRows; i++) {
      const supp = suppressed[i]!.filter(Boolean).length;
      if (supp !== 1 || withheldRow.has(i)) continue;
      let best = -1;
      for (let j = 0; j < nCols; j++) {
        if (!suppressed[i]![j] && (best === -1 || values[i]![j]! < values[i]![best]!)) best = j;
      }
      if (best === -1) {
        withheldRow.add(i); // a single-cell row: the margin IS the cell, withhold it
      } else {
        suppressed[i]![best] = true;
        complementary++;
      }
      changed = true;
    }
    // Column pass, same rule.
    for (let j = 0; j < nCols; j++) {
      let supp = 0;
      for (let i = 0; i < nRows; i++) if (suppressed[i]![j]) supp++;
      if (supp !== 1 || withheldCol.has(j)) continue;
      let best = -1;
      for (let i = 0; i < nRows; i++) {
        if (!suppressed[i]![j] && (best === -1 || values[i]![j]! < values[best]![j]!)) best = i;
      }
      if (best === -1) {
        withheldCol.add(j);
      } else {
        suppressed[best]![j] = true;
        complementary++;
      }
      changed = true;
    }
  }

  const rowMargins: (number | null)[] = [];
  for (let i = 0; i < nRows; i++) {
    if (withheldRow.has(i)) rowMargins.push(null);
    else rowMargins.push(values[i]!.reduce((a, b) => a + b, 0));
  }
  const colMargins: (number | null)[] = [];
  for (let j = 0; j < nCols; j++) {
    if (withheldCol.has(j)) colMargins.push(null);
    else {
      let sum = 0;
      for (let i = 0; i < nRows; i++) sum += values[i]![j]!;
      colMargins.push(sum);
    }
  }
  const totalSuppressed = suppressed.reduce((a, row) => a + row.filter(Boolean).length, 0);
  const grandTotal =
    totalSuppressed === 1 ? null : values.flat().reduce((a, b) => a + b, 0);
  return { suppressed, primary, complementary, rowMargins, colMargins, grandTotal, k };
}

/** Renders one cell for the published grid: '— (n<k)' when suppressed. */
export function renderCell(n: number, suppressed: boolean, k: number): string {
  return suppressed ? `— (n<${k})` : String(n);
}
