/**
 * The OTLP wire contract (features 22, 25, 26, 29, 42): incidents as logs
 * carrying the figures that fired (observed AND baseline AND threshold — the
 * same three numbers the analyst sees), a pinned semconv snapshot with
 * schema_url on the resource and deterministic ids, gen_ai.provider.name
 * normalisation with an explicit unknown bucket, vole.heartbeat records with
 * pack inventory as vole.content.* resource attributes, and the span model
 * with real execute_tool durations and honestly zero-length chat spans.
 *
 * This is the JSON mapping of OTLP semantics (http/json encoding shape) —
 * full protobuf would need a schema dependency Vole will not add.
 *
 *   pnpm otlp [--semconv=2026-09-01] [--dual-emit] [--limit 1000]
 */
import { openDbReadOnly } from '../db';
import { deviceKey } from '../identity';
import {
  loadSemconv, providerForModel, type EncodeCtx, type SemconvSnapshot,
} from '../export/fields';
import { readShapeRows, encodeShapeRow, deterministicId } from '../export/shapes';
import { heartbeatDoc, packRecords, packResourceAttributes } from '../export/heartbeat';
import { buildSpans } from '../export/spans';

export const SERVICE_VERSION = '0.2.2';

export interface OtlpLogRecord {
  timeUnixNano: string;
  severityText: string;
  body: string;
  attributes: Record<string, string | number>;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number>;
}

export interface OtlpExport {
  resource: {
    'service.name': string;
    'service.version': string;
    'device.id': string;
    'schema_url': string;
    attributes: Record<string, string | number>;
  };
  scopeLogs: { scope: { name: string; version: string }; logRecords: OtlpLogRecord[] }[];
  scopeSpans: { scope: { name: string; version: string }; spans: OtlpSpan[] }[];
}

export interface OtlpOpts {
  semconv?: string;
  /** Emit the legacy gen_ai.system attribute beside gen_ai.provider.name (migration window). */
  dualEmit?: boolean;
  limit?: number;
  now?: number;
}

export function otlpExport(opts: OtlpOpts = {}): OtlpExport {
  const db = openDbReadOnly();
  const snapshot = loadSemconv(opts.semconv);
  const deviceId = deviceKey();
  const ctx: EncodeCtx = { device_id: deviceId, identity_mode: 'pseudonymous', opt_in: new Set() };
  const now = opts.now ?? Date.now();

  // ── incidents as logs, carrying the figures that fired ─────────────────
  const incidentRows = readShapeRows(db, 'vole.incident.v1', { limit: opts.limit });
  const incidents: OtlpLogRecord[] = incidentRows.map((row) => {
    const enc = encodeShapeRow('vole.incident.v1', row, ctx);
    const w = enc.wire;
    const provider = providerForModel((row['model'] as string | null) ?? null);
    const attrs: Record<string, string | number> = {
      'vole.rule': String(w['rule']),
      'vole.observed': Number(w['observed']),
      // baseline/threshold travel BESIDE observed — the analyst and the
      // alert must not be able to disagree about what fired. NULLs omitted.
      ...(w['baseline'] !== undefined ? { 'vole.baseline': Number(w['baseline']) } : {}),
      ...(w['threshold'] !== undefined ? { 'vole.threshold': Number(w['threshold']) } : {}),
      'vole.severity': String(w['severity']),
      'vole.confidence': String(w['confidence']),
      'vole.device_id': deviceId,
      'vole.event_key': String(w['anomaly_key']),
      ...(w['case_key'] !== undefined ? { 'vole.case_key': String(w['case_key']) } : {}),
      ...(w['content_rev'] !== undefined ? { 'vole.content_rev': Number(w['content_rev']) } : {}),
      ...(w['asset_tier'] !== undefined ? { 'vole.asset_tier': Number(w['asset_tier']) } : {}),
      'vole.record_id': deterministicId(w['anomaly_key'], deviceId),
      'vole.window_start_ns': String(Number(w['window_start']) * 1_000_000),
      'vole.window_end_ns': String(Number(w['window_end']) * 1_000_000),
      ...(w['session_id'] !== undefined ? { 'vole.session_id': String(w['session_id']) } : {}),
      ...(provider !== 'unknown' ? { 'gen_ai.provider.name': provider } : { 'vole.provider': 'unknown' }),
    };
    return {
      timeUnixNano: String(Number(w['detected_at']) * 1_000_000),
      severityText: String(w['severity']).toUpperCase(),
      body: String(w['title']),
      attributes: attrs,
    };
  });

  // ── heartbeat + pack inventory on the wire ────────────────────────────
  const beat = heartbeatDoc(db, deviceId, { now, collectorVersion: SERVICE_VERSION });
  const packs = packRecords(db, now);
  const heartbeat: OtlpLogRecord[] = [
    {
      timeUnixNano: String(beat.record.ts * 1_000_000),
      severityText: 'INFO',
      body: 'vole.heartbeat',
      attributes: { ...beat.record.attributes, 'vole.record_id': deterministicId(beat.doc_id) },
    },
    ...packs.map((p): OtlpLogRecord => ({
      timeUnixNano: String(now * 1_000_000),
      severityText: 'INFO',
      body: `vole.content ${p.kind}`,
      attributes: {
        'vole.content.kind': p.kind,
        'vole.content.version': p.version,
        'vole.content.sha256': p.sha256,
        ...(p.built_at !== null ? { 'vole.content.built_at': p.built_at } : {}),
        ...(p.age_days !== null ? { 'vole.content.age_days': p.age_days } : {}),
        ...(p.ring !== null ? { 'vole.content.ring': p.ring } : {}),
        ...(p.load_state !== null ? { 'vole.content.load_state': p.load_state } : {}),
        ...(p.trust !== null ? { 'vole.content.trust': p.trust } : {}),
        'vole.record_id': deterministicId('content-pack', p.kind, p.version),
      },
    })),
  ];

  // ── spans: real tool durations, honestly zero-length chat spans ───────
  const spans = buildSpans(db, ctx, { limit: opts.limit }).map((s): OtlpSpan => ({
    traceId: s.trace_id,
    spanId: s.span_id,
    parentSpanId: s.parent_span_id,
    name: s.name,
    kind: s.kind === 'internal' ? 1 : 2,
    startTimeUnixNano: s.start_time_unix_nano,
    endTimeUnixNano: s.end_time_unix_nano,
    attributes: s.attributes,
  }));

  // Legacy dual-emit (migration window): add the deprecated gen_ai.system
  // name beside gen_ai.provider.name — validated against the snapshot's
  // legacy_attributes, so the window is explicit, not habitual.
  if (opts.dualEmit) {
    for (const rec of incidents) {
      if (rec.attributes['gen_ai.provider.name'] !== undefined && rec.attributes['gen_ai.system'] === undefined) {
        rec.attributes['gen_ai.system'] = String(rec.attributes['gen_ai.provider.name']);
      }
    }
  }

  return {
    resource: {
      'service.name': 'vole',
      'service.version': SERVICE_VERSION,
      'device.id': deviceId,
      'schema_url': snapshot.schema_url,
      attributes: packResourceAttributes(packs),
    },
    scopeLogs: [
      { scope: { name: 'vole.incidents', version: '1' }, logRecords: incidents },
      { scope: { name: 'vole.heartbeat', version: '1' }, logRecords: heartbeat },
    ],
    scopeSpans: [{ scope: { name: 'vole.traces', version: '1' }, spans }],
  };
}

/**
 * The pinned-semconv test (feature 25): every gen_ai.* attribute the
 * serializer can produce must exist in the vendored snapshot with the same
 * type. vole.* attributes are non-portable by definition and exempt.
 */
export function validateAgainstSnapshot(
  exp: OtlpExport,
  snapshot: SemconvSnapshot,
  opts: { legacyAllowed?: boolean } = {},
): string[] {
  const errors: string[] = [];
  const known = snapshot.attributes;
  const legacy = snapshot.legacy_attributes ?? {};
  const check = (attrs: Record<string, string | number>, where: string): void => {
    for (const [k, v] of Object.entries(attrs)) {
      if (!k.startsWith('gen_ai.')) continue;
      const spec = known[k] ?? (opts.legacyAllowed ? legacy[k] : undefined);
      if (!spec) { errors.push(`${where}: ${k} not in snapshot ${snapshot.version}`); continue; }
      if (spec.type === 'int' && typeof v !== 'number') {
        errors.push(`${where}: ${k} must be int, got ${typeof v}`);
      }
      if (spec.type === 'string' && typeof v !== 'string') {
        errors.push(`${where}: ${k} must be string, got ${typeof v}`);
      }
    }
  };
  for (const sl of exp.scopeLogs) {
    sl.logRecords.forEach((r, i) => check(r.attributes, `logRecord[${i}]`));
  }
  for (const ss of exp.scopeSpans) {
    ss.spans.forEach((s, i) => check(s.attributes, `span[${i}]`));
  }
  return errors;
}

if (process.argv[1]?.endsWith('otlp.ts')) {
  const args = new Map(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? 'true'] : [a.replace(/^--/, ''), 'true'];
  }));
  console.log(JSON.stringify(otlpExport({
    semconv: args.get('semconv'),
    dualEmit: args.has('dual-emit'),
    limit: args.has('limit') ? Number(args.get('limit')) : undefined,
  }), null, 1));
}
