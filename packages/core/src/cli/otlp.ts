/**
 * Tier 7: the OTLP-style wire contract — a deterministic, versioned shape
 * that a collector/SIEM can consume. Not full protobuf OTLP (that needs a
 * schema registry); this is the JSON mapping of the same semantics: logs
 * with attributes, resource identity, and deterministic ids so replays
 * dedupe. gen_ai.* attribute names follow the OTel semconv convention.
 */
import { openDbReadOnly } from '../db';
import { createHash } from 'node:crypto';

export interface OtlpLogRecord {
  timeUnixNano: string;
  severityText: string;
  body: string;
  attributes: Record<string, string | number>;
}

export interface OtlpExport {
  resource: { 'service.name': string; 'service.version': string; 'device.id': string };
  scopeLogs: { scope: { name: string; version: string }; logRecords: OtlpLogRecord[] }[];
}

/** Deterministic record id: the same incident exports the same id every time. */
function recordId(parts: (string | number)[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

export function otlpExport(): OtlpExport {
  const db = openDbReadOnly();
  const incidents = db
    .prepare(
      `SELECT rule, severity, tool, session_id, window_start, window_end, title, observed, confidence, detected_at
       FROM anomalies WHERE source = 'live' ORDER BY detected_at DESC LIMIT 1000`,
    )
    .all() as {
    rule: string; severity: string; tool: string; session_id: string | null;
    window_start: number; window_end: number; title: string; observed: number;
    confidence: string; detected_at: number;
  }[];

  const records: OtlpLogRecord[] = incidents.map((i) => ({
    timeUnixNano: String(i.detected_at * 1_000_000),
    severityText: i.severity.toUpperCase(),
    body: i.title,
    attributes: {
      'gen_ai.system': i.tool,
      'vole.rule': i.rule,
      'vole.observed': i.observed,
      'vole.confidence': i.confidence,
      ...(i.session_id ? { 'vole.session_id': i.session_id } : {}),
      'vole.window_start_ns': String(i.window_start * 1_000_000),
      'vole.window_end_ns': String(i.window_end * 1_000_000),
      'vole.record_id': recordId([i.rule, i.tool, i.window_start, i.session_id ?? '']),
    },
  }));

  return {
    resource: {
      'service.name': 'vole',
      'service.version': '0.2.1',
      'device.id': 'pseudonymous (HMAC)',
    },
    scopeLogs: [
      {
        scope: { name: 'vole.incidents', version: '1' },
        logRecords: records,
      },
    ],
  };
}

if (process.argv[1]?.endsWith('otlp.ts')) {
  console.log(JSON.stringify(otlpExport(), null, 1));
}
