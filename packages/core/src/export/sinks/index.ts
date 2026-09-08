/**
 * The sink family (features 28, 47, 48): one capability matrix stating each
 * destination's delivery semantics TRUTHFULLY — the roadmap-v1 claim that
 * Splunk HEC, Elastic bulk and Datadog Logs are all 'idempotent via event_key
 * doc ids' is false for two of the three, and a SIEM team that plans around
 * an exactly-once promise Vole cannot keep is a broken deployment.
 *
 * Every encoder here iterates the field registry: a column that cannot
 * leave over OTLP cannot leave over syslog or CEF either. Network sinks are
 * opt-in and default-off; a real send routes through egress() (the CLI wires
 * that — nothing in this module touches the network).
 */
import { digestOf, type EncodeCtx } from '../fields';
import { encodeShapeRow, SHAPES, type ShapeRow } from '../shapes';

export type SinkId = 'otlp' | 'elastic' | 'splunk' | 'datadog' | 'syslog' | 'cef' | 'sentinel';

export interface SinkDescriptor {
  id: SinkId;
  label: string;
  transport: string;
  delivery: 'exactly-once-by-id' | 'at-least-once' | 'at-most-once';
  guarantee: string;
  /** True sinks cross the network: opt-in, default-off, egress()-gated. */
  network: boolean;
  /** Which shapes this sink accepts (CEF is incidents only). */
  shapes: string[];
}

export const SINKS: Record<SinkId, SinkDescriptor> = {
  otlp: {
    id: 'otlp', label: 'OTLP/HTTP (JSON)', transport: 'http/protobuf or http/json',
    delivery: 'at-least-once',
    guarantee: 'at-least-once; deduped only if the backend dedupes at all — deterministic ids make re-sends recognisable, not impossible',
    network: true, shapes: Object.keys(SHAPES),
  },
  elastic: {
    id: 'elastic', label: 'Elastic _bulk', transport: 'https',
    delivery: 'exactly-once-by-id',
    guarantee: 'exactly-once by _id — and only as good as the id: Codex event_keys collide across parent/sub-agent rollouts, so Codex rows can overwrite each other in the index until that key is fixed',
    network: true, shapes: Object.keys(SHAPES),
  },
  splunk: {
    id: 'splunk', label: 'Splunk HEC', transport: 'https',
    delivery: 'at-least-once',
    guarantee: 'at-least-once; HEC has no client-supplied document id, so replays and retries produce duplicates',
    network: true, shapes: Object.keys(SHAPES),
  },
  datadog: {
    id: 'datadog', label: 'Datadog Logs', transport: 'https',
    delivery: 'at-least-once',
    guarantee: 'at-least-once; the API carries no document id — dedupe, if any, is the backend\'s business',
    network: true, shapes: Object.keys(SHAPES),
  },
  syslog: {
    id: 'syslog', label: 'Syslog (RFC 5424)', transport: 'tcp+tls (udp possible, worse)',
    delivery: 'at-most-once',
    guarantee: 'at-most-once: no acknowledgement and no document id; over UDP messages are lost silently, over TCP a relay may truncate at 1024–2048 bytes, cutting long attribute sets mid-field',
    network: true, shapes: Object.keys(SHAPES),
  },
  cef: {
    id: 'cef', label: 'ArcSight CEF', transport: 'tcp',
    delivery: 'at-most-once',
    guarantee: 'at-most-once, incidents only, no acknowledgement; the extension line is length-limited by the collector',
    network: true, shapes: ['vole.incident.v1'],
  },
  sentinel: {
    id: 'sentinel', label: 'Microsoft Sentinel (Logs Ingestion API)', transport: 'https',
    delivery: 'at-least-once',
    guarantee: 'at-least-once; the DCR has no per-record id, so the outbox checkpoint is the only delivery evidence',
    network: true, shapes: Object.keys(SHAPES),
  },
};

export function capabilityMatrix(): SinkDescriptor[] {
  return Object.values(SINKS);
}

/** The sink's device-scoped document id — the dedupe key a backend may or may not honour. */
export function sinkDocId(ctx: EncodeCtx, row: ShapeRow): string {
  return `${ctx.device_id}:${row.doc_id}`;
}

export interface EncodedDoc {
  doc_id: string;
  bytes: string;
}

/** Encode registry-bound rows for a sink. Pure: no network, no DB. */
export function encodeForSink(sinkId: SinkId, ctx: EncodeCtx, rows: ShapeRow[]): EncodedDoc[] {
  const sink = SINKS[sinkId];
  const accepted = rows.filter((r) => sink.shapes.includes(r.wire['shape'] as string));
  switch (sinkId) {
    case 'elastic':
      // {"index":{"_id": …}}\n{doc}\n — the one exactly-once shape.
      return accepted.map((r) => ({
        doc_id: sinkDocId(ctx, r),
        bytes: `{"index":{"_id":${JSON.stringify(sinkDocId(ctx, r))}}}\n${JSON.stringify({ ...r.sync_key, ...r.wire })}\n`,
      }));
    case 'splunk':
      // HEC event object per line; no client id exists.
      return accepted.map((r) => ({
        doc_id: sinkDocId(ctx, r),
        bytes: `${JSON.stringify({ event: { ...r.sync_key, ...r.wire }, sourcetype: 'vole:export', host: ctx.device_id })}\n`,
      }));
    case 'datadog':
      return accepted.map((r) => ({
        doc_id: sinkDocId(ctx, r),
        bytes: `${JSON.stringify({ message: JSON.stringify({ ...r.sync_key, ...r.wire }), ddsource: 'vole', ddtags: `device:${ctx.device_id}` })}\n`,
      }));
    case 'syslog':
      return accepted.map((r) => ({ doc_id: sinkDocId(ctx, r), bytes: rfc5424Message(ctx, r) + '\n' }));
    case 'cef':
      return accepted.map((r) => ({ doc_id: sinkDocId(ctx, r), bytes: cefMessage(ctx, r) + '\n' }));
    case 'otlp':
    case 'sentinel':
      // Both are structured-JSON bodies built by their own modules; the raw
      // wire object per doc is the measurable unit here.
      return accepted.map((r) => ({
        doc_id: sinkDocId(ctx, r),
        bytes: `${JSON.stringify({ ...r.sync_key, ...r.wire })}\n`,
      }));
  }
}

// ── RFC 5424 (feature 47) ────────────────────────────────────────────────

// ponytail: no IANA Private Enterprise Number is assigned to Vole yet; PEN 0
// is the private placeholder. Replace with the assigned number when obtained.
export const VOLE_PEN = 0;

const SYSLOG_SEVERITY: Record<string, number> = { critical: 2, warn: 4, info: 6 };
// local0 (facility 16) — a monitoring appliance, not a system component.
const FACILITY = 16;

function sdEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/]/g, '\\]');
}

/**
 * `<PRI>1 TIMESTAMP HOST APP PROCID MSGID [vole@PEN k="v" …] MESSAGE`
 * built by iterating the wire object the registry produced — never a
 * hand-picked attribute list, and no free-text message body beyond the title.
 */
export function rfc5424Message(ctx: EncodeCtx, row: ShapeRow): string {
  const wire = row.wire;
  const sev = SYSLOG_SEVERITY[String(wire['severity'] ?? 'info')] ?? 6;
  const pri = FACILITY * 8 + sev;
  const ts = new Date(Number(wire['ts'] ?? wire['detected_at'] ?? wire['first_seen'] ?? 0)).toISOString();
  const msgid = String(wire['rule'] ?? wire['shape']);
  const sd = Object.entries(wire)
    .filter(([k, v]) => v !== null && v !== undefined && k !== 'shape' && k !== 'title')
    .map(([k, v]) => `${k}="${sdEscape(String(v))}"`)
    .join(' ');
  const msg = String(wire['title'] ?? msgid); // rule name / title only, never detail
  return `<${pri}>1 ${ts} ${ctx.device_id} vole - ${msgid} [vole@${VOLE_PEN} ${sd}] ${msg}`;
}

// ── CEF (feature 47) ─────────────────────────────────────────────────────

const CEF_SEVERITY: Record<string, number> = { critical: 10, warn: 6, info: 3 };

function cefEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * `CEF:0|Vole|vole|<version>|<rule>|<title>|<sev>|<extensions>` — incidents
 * only. Extensions map registry fields onto CEF keys: cn1/cn2 the figures,
 * cs1..cs5 the identity fields, rt the detection time (epoch ms).
 */
export function cefMessage(ctx: EncodeCtx, row: ShapeRow, version = '0.2.2'): string {
  const w = row.wire;
  const rule = cefEscape(String(w['rule'] ?? w['shape']));
  const title = cefEscape(String(w['title'] ?? rule));
  const sev = CEF_SEVERITY[String(w['severity'] ?? 'info')] ?? 3;
  const ext: string[] = [`rt=${w['detected_at'] ?? w['ts'] ?? w['first_seen'] ?? 0}`];
  if (w['observed'] !== undefined) ext.push(`cn1=${w['observed']}`, 'cn1Label=observed');
  if (w['baseline'] !== undefined) ext.push(`cn2=${w['baseline']}`, 'cn2Label=baseline');
  if (w['threshold'] !== undefined) ext.push(`cn3=${w['threshold']}`, 'cn3Label=threshold');
  ext.push(`cs1=${ctx.device_id}`, 'cs1Label=device_id', `cs2=${cefEscape(String(w['event_key'] ?? w['anomaly_key'] ?? w['tool_call_key'] ?? w['fingerprint'] ?? row.doc_id))}`, 'cs2Label=event_key');
  if (w['session_id'] !== undefined) ext.push(`cs3=${cefEscape(String(w['session_id']))}`, 'cs3Label=session_id');
  if (w['tool'] !== undefined) ext.push(`cs4=${cefEscape(String(w['tool']))}`, 'cs4Label=tool');
  return `CEF:0|Vole|vole|${version}|${rule}|${title}|${sev}|${ext.join(' ')}`;
}

/** The pseudonymous syslog HOST: the device id, never the hostname. */
export function syslogHost(ctx: EncodeCtx): string {
  return digestOf(ctx.device_id);
}
