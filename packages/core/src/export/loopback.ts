/**
 * Loopback OTLP receiver with parser-fidelity reconciliation (feature 49).
 *
 * Claude Code's own opt-in telemetry emits things the JSONL never records
 * (claude_code.lines_of_code.count, tool_decision with its source,
 * permission_mode_changed, mcp_server_connection, …). `vole collect
 * --otel-listen` binds 127.0.0.1:4318 ONLY — the bind is not a parameter,
 * any other host is refused by construction — and writes to a separate
 * agent_telemetry table, never into usage_events: these numbers are
 * tool-reported rather than parsed and must keep a different provenance
 * badge.
 *
 * Accepts OTLP/JSON (http/json). OTLP/protobuf is refused with 415 and an
 * honest message: parsing protobuf needs a dependency Vole will not add.
 */
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { DB } from '../db';
import { insertAnomalies } from '../db';
import type { Anomaly, Tool } from '../types';

export interface AgentTelemetryRow {
  telemetry_key: string;
  tool: string;
  session_id: string | null;
  event_name: string;
  ts: number;
  attrs_json: string;
  source: 'live';
}

/** The receiver's own table, created lazily (the egress.ts pattern). */
function ensureTable(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_telemetry (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    telemetry_key TEXT NOT NULL UNIQUE,
    tool          TEXT NOT NULL,
    session_id    TEXT,
    event_name    TEXT NOT NULL,
    ts            INTEGER NOT NULL,
    attrs_json    TEXT NOT NULL,
    source        TEXT NOT NULL DEFAULT 'live'
  )`);
}

export function parseOtlpJson(body: string): AgentTelemetryRow[] {
  const req = JSON.parse(body) as {
    resourceLogs?: {
      resource?: { attributes?: { key: string; value: { stringValue?: string; intValue?: string | number } }[] };
      scopeLogs?: {
        logRecords?: {
          timeUnixNano?: string;
          body?: { stringValue?: string };
          attributes?: { key: string; value: { stringValue?: string; intValue?: string | number; boolValue?: boolean } }[];
        }[];
      }[];
    }[];
  };
  const rows: AgentTelemetryRow[] = [];
  for (const rl of req.resourceLogs ?? []) {
    const attrs = Object.fromEntries(
      (rl.resource?.attributes ?? []).map((a) => [
        a.key,
        a.value.stringValue ?? String(a.value.intValue ?? ''),
      ]),
    );
    // Claude Code identifies itself via service.name; absent = honest unknown.
    const tool = attrs['service.name'] ?? 'unknown';
    for (const sl of rl.scopeLogs ?? []) {
      for (const rec of sl.logRecords ?? []) {
        const recAttrs = Object.fromEntries(
          (rec.attributes ?? []).map((a) => [
            a.key,
            a.value.stringValue ?? (a.value.boolValue !== undefined ? String(a.value.boolValue) : String(a.value.intValue ?? '')),
          ]),
        );
        const sessionId =
          recAttrs['gen_ai.conversation.id'] ??
          recAttrs['session_id'] ??
          recAttrs['vole.session_id'] ??
          null;
        const eventName =
          rec.body?.stringValue ??
          recAttrs['event_name'] ??
          recAttrs['event.name'] ??
          'unknown';
        const ts = Math.floor(Number(rec.timeUnixNano ?? 0) / 1_000_000);
        const attrsJson = JSON.stringify(recAttrs);
        const key = createHash('sha256')
          .update([tool, sessionId ?? '', eventName, rec.timeUnixNano ?? '0', attrsJson].join('|'))
          .digest('hex');
        rows.push({ telemetry_key: key, tool, session_id: sessionId, event_name: eventName, ts, attrs_json: attrsJson, source: 'live' });
      }
    }
  }
  return rows;
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
}

export function insertTelemetry(db: DB, rows: AgentTelemetryRow[]): IngestResult {
  ensureTable(db);
  const upsert = db.prepare(`
    INSERT INTO agent_telemetry (telemetry_key, tool, session_id, event_name, ts, attrs_json, source)
    VALUES (?, ?, ?, ?, ?, ?, 'live')
    ON CONFLICT (telemetry_key) DO NOTHING
  `);
  let accepted = 0;
  for (const r of rows) accepted += upsert.run(r.telemetry_key, r.tool, r.session_id, r.event_name, r.ts, r.attrs_json).changes;
  return { accepted, duplicates: rows.length - accepted };
}

/**
 * Parser-fidelity reconciliation: for sessions that carry BOTH tool-reported
 * telemetry and parsed rows, compare the two figures and emit a
 * 'reconcile_gap' anomaly naming the session, both figures and the delta.
 * A spot check on the subset where someone turned telemetry on — shown as
 * such, never as fleet-wide assurance.
 */
export function reconcileTelemetry(db: DB, now: number = Date.now()): Anomaly[] {
  try {
    const has = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_telemetry'`,
    ).get();
    if (!has) return [];
  } catch {
    return [];
  }
  const reported = db.prepare(`
    SELECT session_id, tool, COUNT(*) AS reported, MIN(ts) AS first_ts
    FROM agent_telemetry WHERE event_name != 'unknown' GROUP BY session_id, tool
  `).all() as { session_id: string | null; tool: string; reported: number; first_ts: number }[];
  const out: Anomaly[] = [];
  for (const r of reported) {
    if (!r.session_id) continue;
    const parsed = (
      db.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE session_id = ?').get(r.session_id) as { n: number }
    ).n;
    if (parsed === r.reported) continue;
    const bucket = Math.floor(r.first_ts / 600_000);
    out.push({
      anomaly_key: `reconcile_gap:${r.tool}:${r.session_id}:${bucket}`,
      rule: 'reconcile_gap',
      severity: 'info',
      // ponytail: machine/telemetry-level incident, no Tool literal exists
      // for 'the tool as it reports itself' — placeholder until the union
      // widens.
      tool: 'claude_code' as Tool,
      session_id: r.session_id,
      model: null,
      window_start: r.first_ts,
      window_end: now,
      title: `Telemetry and transcript disagree: ${r.tool} session ${r.session_id.slice(0, 8)}…`,
      detail: `The tool reported ${r.reported} telemetry events for this session; Vole parsed ${parsed} usage rows. Both figures are tool-reported and parsed counts over a telemetry-enabled subset, not a fleet-wide check — the delta is either events the JSONL never records or rows telemetry did not see.`,
      observed: r.reported,
      baseline: parsed,
      threshold: null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }
  return out;
}

export interface LoopbackHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/**
 * Start the receiver on 127.0.0.1 only. The host is not a parameter: binding
 * anything but loopback is the mistake this feature exists to make
 * impossible.
 */
export function startLoopback(
  db: DB,
  opts: { port?: number } = {},
): Promise<LoopbackHandle> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/logs')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'OTLP logs endpoint is /v1/logs' }));
        return;
      }
      const ct = req.headers['content-type'] ?? '';
      if (ct.includes('protobuf')) {
        res.writeHead(415, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: 'OTLP/protobuf is not accepted: parsing it needs a dependency Vole will not add. Point the exporter at http/json.',
        }));
        return;
      }
      try {
        const rows = parseOtlpJson(body);
        const result = insertTelemetry(db, rows);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ partialSuccess: {}, accepted: result.accepted, duplicates: result.duplicates }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e) }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? 4318, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        port: typeof addr === 'object' && addr ? addr.port : (opts.port ?? 4318),
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
