/**
 * Versioned export shapes (feature 35): one wire shape per ledger, bound by
 * the field registry. `vole.secret_sighting.v1` and `vole.tool_call.v1`
 * replace the blanket exclusion the first exporter used: the ledgers can now
 * leave in a reviewed, versioned form — no value, no path, deliberately no
 * byte offset.
 *
 * Every row carries the device-scoped sync key (device_id, event_key): event
 * keys are NOT globally unique (Codex keys on session + line index and
 * sub-agent rollouts replay the parent session_meta), so (device_id, key)
 * is the only safe dedupe key at a sink.
 */
import type { DB } from '../db';
import {
  encodeFields, selectColumns, digestOf, dirPrefixOf, fieldsFor,
  type EncodeCtx,
} from './fields';

export interface ShapeDef {
  /** The wire shape name, e.g. 'vole.event.v1'. */
  shape: string;
  table: string;
  /** The column whose value is the doc id (with the shape prefix). */
  key_column: string;
  /** Additional columns the doc id needs (never exported themselves). */
  doc_id_columns?: string[];
  /** Tables with a source column are read source='live' only. */
  live_only: boolean;
  /** The ts column used for range replay. */
  ts_column: string;
}

export const SHAPES: Record<string, ShapeDef> = {
  'vole.event.v1': { shape: 'vole.event.v1', table: 'usage_events', key_column: 'event_key', live_only: true, ts_column: 'ts' },
  'vole.incident.v1': { shape: 'vole.incident.v1', table: 'anomalies', key_column: 'anomaly_key', live_only: true, ts_column: 'detected_at' },
  'vole.tool_call.v1': { shape: 'vole.tool_call.v1', table: 'tool_calls', key_column: 'tool_call_key', live_only: false, ts_column: 'ts' },
  // secret_sightings has no source column (the DLP scanner is live-only by
  // construction) and its identity is (fingerprint, sink_key).
  'vole.secret_sighting.v1': {
    shape: 'vole.secret_sighting.v1', table: 'secret_sightings', key_column: 'fingerprint',
    doc_id_columns: ['sink_key'], live_only: false, ts_column: 'first_seen',
  },
};

export const SHAPE_NAMES = Object.keys(SHAPES);

/**
 * '|' separates components because keys themselves contain ':' (an event_key
 * is 'claude_code:msg_…', a fingerprint 'fp123:…'). The doc id must parse
 * back into (shape, key, extras) unambiguously — the outbox re-derives the
 * payload from it at drain time.
 */
export const DOC_ID_SEP = '|';

export function docIdFor(shape: ShapeDef, row: Record<string, unknown>): string {
  const parts = [shape.shape, String(row[shape.key_column])];
  for (const c of shape.doc_id_columns ?? []) parts.push(String(row[c]));
  // The tool rides the doc id so the outbox's drop audit can name the agent
  // whose rows were lost — export_outbox has no tool column of its own.
  if (row['tool'] != null) parts.push(String(row['tool']));
  return parts.join(DOC_ID_SEP);
}

export interface ShapeRow {
  doc_id: string;
  /** The device-scoped sync key: (device_id, event_key). */
  sync_key: { device_id: string; event_key: string };
  wire: Record<string, string | number>;
}

/** Columns a store actually has — a pre-migration store honestly lacks later columns. */
export function existingColumns(db: DB, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** Rows from the store for one shape: live partition only, registry columns only. */
export function readShapeRows(
  db: DB,
  shapeName: string,
  opts: { from?: number; to?: number; limit?: number } = {},
): Record<string, unknown>[] {
  const shape = SHAPES[shapeName];
  if (!shape) throw new Error(`Unknown shape ${shapeName}; known: ${SHAPE_NAMES.join(', ')}`);
  // A store written before a foundation migration honestly lacks those
  // columns; the encoder omits them rather than failing the whole export.
  const have = existingColumns(db, shape.table);
  const cols = [...new Set([shape.key_column, ...(shape.doc_id_columns ?? []), ...selectColumns(shape.table)])]
    .filter((c) => have.has(c));
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (shape.live_only && have.has('source')) {
    where.push("source = 'live'");
  }
  if (opts.from !== undefined) { where.push(`${shape.ts_column} >= :from`); params.from = opts.from; }
  if (opts.to !== undefined) { where.push(`${shape.ts_column} <= :to`); params.to = opts.to; }
  const sql =
    `SELECT ${cols.join(', ')} FROM ${shape.table}` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY ${shape.ts_column} DESC, ${shape.key_column}` +
    (opts.limit ? ` LIMIT ${Math.floor(opts.limit)}` : '');
  return db.prepare(sql).all(params) as Record<string, unknown>[];
}

/**
 * Encode one row through the registry and stamp the sync key. The wire
 * object is built ONLY by iterating the registry — encodeFields — so a
 * column that cannot leave cannot appear here at any setting.
 */
export function encodeShapeRow(
  shapeName: string,
  row: Record<string, unknown>,
  ctx: EncodeCtx,
): ShapeRow {
  const shape = SHAPES[shapeName];
  if (!shape) throw new Error(`Unknown shape ${shapeName}`);
  const wire = encodeFields(shape.table, row, ctx);
  if (shapeName === 'vole.secret_sighting.v1') {
    // The shape's coarse extras: the agent-home dir prefix (public vocabulary,
    // never a user path) and the key epoch a sighting's fingerprint implies.
    const path = row['path'] as string | null;
    const prefix = path ? dirPrefixOf(path) : null;
    if (prefix) wire['dir_prefix'] = prefix;
    const epoch = (row['fingerprint'] as string | null)?.match(/^fp(\d+):/);
    if (epoch) wire['key_epoch'] = Number(epoch[1]);
  }
  const key = String(row[shape.key_column]);
  return {
    doc_id: docIdFor(shape, row),
    sync_key: { device_id: ctx.device_id, event_key: key },
    wire: { shape: shape.shape, ...wire },
  };
}

/**
 * Replay-safe range reader: the same encoder, over a ts window. Because doc
 * ids are content-keyed (shape + key), re-encoding an unchanged row yields
 * the same doc id and a sink that dedupes by id is never rewound; the change
 * cursor (outbox.ts) is monotone over outbox seq and cannot be reset by this.
 */
export function shapeRowsForRange(
  db: DB,
  shapeName: string,
  ctx: EncodeCtx,
  opts: { from?: number; to?: number },
): ShapeRow[] {
  return readShapeRows(db, shapeName, opts).map((r) => encodeShapeRow(shapeName, r, ctx));
}

/** Deterministic, stable record id for OTLP/logs dedupe (no now() ever). */
export function deterministicId(...parts: (string | number | null | undefined)[]): string {
  return digestOf(parts.map((p) => p ?? '').join('|')).slice('sha256:'.length);
}

/** Registry columns per shape, for panels and the Sentinel generator. */
export function wireFieldsFor(shapeName: string): { wire_name: string; export: string; justification: string }[] {
  const shape = SHAPES[shapeName];
  if (!shape) throw new Error(`Unknown shape ${shapeName}`);
  return fieldsFor(shape.table).map((f) => ({ wire_name: f.wire_name, export: f.export, justification: f.justification }));
}
