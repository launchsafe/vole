/**
 * Sink volume and cardinality measured from real serialized bytes (feature
 * 45): before a sink is enabled, serialize the last N days of live rows
 * through THAT sink's exact encoder in memory and report measured bytes/day,
 * events/day, spans/day and the distinct metric series actually present in
 * the data (tool x model x confidence x project), plus a 30-day projection
 * labelled with its window — a sample, never presented as a rate.
 */
import type { DB } from '../../db';
import { readShapeRows, encodeShapeRow, SHAPES, type ShapeRow } from '../shapes';
import type { EncodeCtx } from '../fields';
import { encodeForSink, type SinkId } from './index';
import { buildSpans } from '../spans';

export interface VolumeReport {
  sink: SinkId;
  /** The measured window, labelled — a busy sprint changes the figure. */
  window: { days: number; from: number; to: number };
  bytes: number;
  events: number;
  spans: number;
  /** True cardinality of tool x model x confidence x project in the sample. */
  distinct_series: number;
  per_day: { bytes: number; events: number; spans: number };
  /** Labelled projection — linear over the measured window, nothing smarter. */
  projection_30d: { bytes: number; events: number; spans: number };
}

export function measureSinkVolume(
  db: DB,
  sinkId: SinkId,
  ctx: EncodeCtx,
  opts: { days?: number; now?: number; limit?: number } = {},
): VolumeReport {
  const days = opts.days ?? 7;
  const now = opts.now ?? Date.now();
  const from = now - days * 86_400_000;

  const rows: ShapeRow[] = [];
  for (const shapeName of Object.keys(SHAPES)) {
    for (const r of readShapeRows(db, shapeName, { from, limit: opts.limit })) {
      rows.push(encodeShapeRow(shapeName, r, ctx));
    }
  }
  const encoded = encodeForSink(sinkId, ctx, rows);
  const bytes = encoded.reduce((n, d) => n + Buffer.byteLength(d.bytes), 0);

  // True series cardinality: distinct (tool, model, confidence, project) in
  // the sample — the number a per-series-metered backend will actually bill.
  const series = new Set<string>();
  for (const r of rows) {
    if (r.wire['shape'] !== 'vole.event.v1') continue;
    series.add([r.wire['tool'], r.wire['model'], r.wire['confidence'], r.wire['project_repo']].join('|'));
  }

  const spans = buildSpans(db, ctx, { from, limit: opts.limit }).length;
  const k = 1 / days;
  return {
    sink: sinkId,
    window: { days, from, to: now },
    bytes,
    events: encoded.length,
    spans,
    distinct_series: series.size,
    per_day: { bytes: Math.round(bytes * k), events: Math.round(encoded.length * k), spans: Math.round(spans * k) },
    projection_30d: {
      bytes: Math.round(bytes * k * 30),
      events: Math.round(encoded.length * k * 30),
      spans: Math.round(spans * k * 30),
    },
  };
}
