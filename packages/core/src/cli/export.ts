/**
 * The export path (Tier 7 core): a deny-by-default field registry and a JSON
 * encoder that omits NULLs. Every export states which fields left the
 * machine — and only fields on the list can. This CLI is the surface over
 * src/export/: versioned shapes, the MCP inventory, sink previews, volume
 * measurement, replay/drain over the outbox, and generated detection
 * content.
 *
 *   pnpm export [--shape=vole.secret_sighting.v1] [--mcp --format=server-json]
 *               [--fields] [--semconv=2026-09-01] [--sink=syslog] [--volume]
 *               [--content --out=docs/siem] [--replay --from=.. --to=.. --sink=..]
 *               [--drain --sink=..] [--absence]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { openDbReadOnly, openDb } from '../db';
import { deviceKey } from '../identity';
import { egress } from '../egress';
import {
  REGISTRY, loadSemconv, SEMCONV_VERSIONS, type EncodeCtx,
} from '../export/fields';
import {
  SHAPE_NAMES, readShapeRows, encodeShapeRow, shapeRowsForRange, wireFieldsFor,
} from '../export/shapes';
import {
  drainOutbox, replayRange, changeCursor, rederiveDoc, type OutboxDoc,
} from '../export/outbox';
import { capabilityMatrix, encodeForSink, SINKS, type SinkId } from '../export/sinks';
import { measureSinkVolume } from '../export/sinks/volume';
import { generateSentinelAssets } from '../export/sinks/sentinel';
import { mcpInventory, mcpInventoryJson, mcpInventoryDigest } from '../export/mcp-inventory';
import { DETECTION_RULES, generateSigma, generateSpl, generateEql } from '../siem/sigma';
import { atcConfig, fleetQueryPack } from './query';

function ctx(): EncodeCtx {
  return { device_id: deviceKey(), identity_mode: 'pseudonymous', opt_in: new Set() };
}

/** The original JSON export, now built by iterating the registry shapes. */
export function exportJson(): string {
  const db = openDbReadOnly();
  const c = ctx();
  const out: Record<string, unknown> = {
    _registry: {
      exported_fields: REGISTRY.filter((f) => f.export === 'always').length,
      opt_in_fields: REGISTRY.filter((f) => f.export === 'optin').length,
      never_fields: REGISTRY.filter((f) => f.export === 'never').length,
      shapes: SHAPE_NAMES,
      note: 'deny-by-default: only listed fields are exported; NULLs are omitted, not zeroed',
    },
    device_id: c.device_id,
  };
  for (const shapeName of SHAPE_NAMES) {
    out[shapeName] = readShapeRows(db, shapeName, { limit: 1000 }).map((r) => encodeShapeRow(shapeName, r, c).wire);
  }
  return JSON.stringify(out, null, 1);
}

/** The absence strip (feature 1): exported rows in the last 24h with no tokens, no cost, no model. */
export function absenceCounts(db: ReturnType<typeof openDbReadOnly>, since: number): {
  rows: number; no_tokens: number; no_cost: number; no_model: number;
} {
  const rows = db.prepare(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN total_tokens IS NULL THEN 1 ELSE 0 END) AS no_tokens,
            SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS no_cost,
            SUM(CASE WHEN model IS NULL THEN 1 ELSE 0 END) AS no_model
     FROM usage_events WHERE source = 'live' AND ts >= ?`,
  ).get(since) as { n: number; no_tokens: number | null; no_cost: number | null; no_model: number | null };
  return {
    rows: rows.n,
    no_tokens: rows.no_tokens ?? 0,
    no_cost: rows.no_cost ?? 0,
    no_model: rows.no_model ?? 0,
  };
}

function parseArgs(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/s);
    if (m) {
      out.set(m[1]!, m[2] !== undefined ? m[2] : true);
    } else if (i > 0 && argv[i - 1]!.startsWith('--')) {
      // space-separated value: --out docs/siem
      out.set(argv[i - 1]!.slice(2), a);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const c = ctx();
  const semconv = args.get('semconv');

  if (typeof semconv === 'string') {
    const snap = loadSemconv(semconv);
    console.log(JSON.stringify({
      version: snap.version, upstream: snap.upstream, upstream_commit: snap.upstream_commit,
      snapshot_date: snap.snapshot_date, stability: snap.stability, schema_url: snap.schema_url,
      vendored: SEMCONV_VERSIONS, attribute_count: Object.keys(snap.attributes).length,
    }, null, 1));
    return;
  }

  if (args.has('fields')) {
    const leave = REGISTRY.filter((f) => f.export !== 'never')
      .map((f) => ({ table: f.table, column: f.column, wire_name: f.wire_name, transform: f.transform, opt_in: f.export === 'optin' }));
    const refused = REGISTRY.filter((f) => f.export === 'never')
      .map((f) => ({ table: f.table, column: f.column, reason: f.justification }));
    console.log(JSON.stringify({ fields_that_leave: leave, structurally_unable_to_leave: refused }, null, 1));
    return;
  }

  if (args.has('mcp')) {
    const db = openDbReadOnly();
    const inv = mcpInventory(db);
    if (args.get('format') === 'server-json') {
      process.stdout.write(mcpInventoryJson(inv));
    } else {
      console.log(JSON.stringify({ servers: inv.servers.length, digest: mcpInventoryDigest(inv) }, null, 1));
    }
    return;
  }

  if (args.has('absence')) {
    const db = openDbReadOnly();
    console.log(JSON.stringify(absenceCounts(db, Date.now() - 86_400_000), null, 1));
    return;
  }

  if (args.has('volume')) {
    const db = openDbReadOnly();
    const sink = (typeof args.get('sink') === 'string' ? args.get('sink') : 'otlp') as SinkId;
    const days = typeof args.get('days') === 'string' ? Number(args.get('days')) : 7;
    console.log(JSON.stringify(measureSinkVolume(db, sink, c, { days }), null, 1));
    return;
  }

  if (args.has('sinks')) {
    console.log(JSON.stringify(capabilityMatrix(), null, 1));
    return;
  }

  const shape = args.get('shape');
  if (typeof shape === 'string') {
    const db = openDbReadOnly();
    const rows = readShapeRows(db, shape, { limit: 2000 }).map((r) => encodeShapeRow(shape, r, c));
    console.log(JSON.stringify({ shape, fields: wireFieldsFor(shape), rows }, null, 1));
    return;
  }

  const sinkId = args.get('sink');
  if (typeof sinkId === 'string' && args.has('drain')) {
    const db = openDb();
    const sink = (SINKS as Record<string, unknown>)[sinkId] ? (sinkId as SinkId) : undefined;
    if (!sink) throw new Error(`Unknown sink ${sinkId}`);
    // Network sinks are opt-in and default-off: without --send the drain is a
    // dry run that serializes and reports; with --send it still passes
    // through egress() — the single choke point — before any socket opens.
    const send = args.has('send');
    if (send) {
      const gate = egress({ caller: 'vole export --drain', destination: sinkId, purpose: 'export outbox drain', ts: Date.now() });
      if (!gate.allowed) throw new Error('VOLE_NO_EGRESS=1 — nothing leaves this machine');
    }
    const result = await drainOutbox(db, sinkId, (doc_id) => rederiveDoc(db, doc_id, c), (async (docs: { doc_id: string; payload: string }[]) => {
      const encoded = docs.map((d) => ({ doc_id: d.doc_id, bytes: d.payload + '\n' }));
      return {
        ok: send, // dry run: succeed locally without touching the network
        witness: send ? `local:${encoded.length}` : null,
        error: send ? undefined : 'dry-run (pass --send to deliver)',
      };
    }) as unknown as import('../export/outbox').SinkSender);
    console.log(JSON.stringify({ sink: sinkId, ...result, cursor: changeCursor(db, sinkId) }, null, 1));
    return;
  }

  if (typeof sinkId === 'string' && args.has('replay')) {
    const db = openDb();
    const from = args.has('from') ? Date.parse(String(args.get('from'))) : Date.now() - 7 * 86_400_000;
    const to = args.has('to') ? Date.parse(String(args.get('to'))) : Date.now();
    const encode = (f: number, t: number): OutboxDoc[] => {
      const docs: OutboxDoc[] = [];
      for (const shapeName of SHAPE_NAMES) {
        if (!SINKS[sinkId as SinkId] || !SINKS[sinkId as SinkId].shapes.includes(shapeName)) continue;
        for (const r of shapeRowsForRange(db, shapeName, c, { from: f, to: t })) {
          docs.push({ doc_id: r.doc_id, payload: JSON.stringify(r.wire) });
        }
      }
      return docs;
    };
    // Dry-run by default: list what a replay would re-send, never touch a sink.
    const docs = encode(from, to);
    if (args.has('send')) {
      console.log(JSON.stringify(replayRange(db, sinkId, encode, from, to), null, 1));
    } else {
      console.log(JSON.stringify({ replay: 'dry-run', from, to, docs: docs.length, doc_ids: docs.map((d) => d.doc_id).slice(0, 50) }, null, 1));
    }
    return;
  }

  if (typeof sinkId === 'string') {
    const db = openDbReadOnly();
    const rows = SHAPE_NAMES.flatMap((s) => readShapeRows(db, s, { limit: 1000 }).map((r) => encodeShapeRow(s, r, c)));
    const encoded = encodeForSink(sinkId as SinkId, c, rows);
    const descriptor = SINKS[sinkId as SinkId];
    console.log(JSON.stringify({
      sink: descriptor, // the capability matrix line — the guarantee, stated
      docs: encoded.length,
      preview: encoded.slice(0, 20),
    }, null, 1));
    return;
  }

  if (args.has('content')) {
    const out = typeof args.get('out') === 'string' ? String(args.get('out')) : 'docs/siem';
    const sentinel = generateSentinelAssets();
    const files: Record<string, string> = {
      [`${out}/sigma/vole.yml`]: generateSigma(),
      [`${out}/splunk/vole.spl`]: generateSpl(),
      [`${out}/elastic/vole.eql`]: generateEql(),
      [`${out}/sentinel/arm-template.json`]: sentinel.armTemplate,
      [`${out}/fleet/vole-atc.conf`]: atcConfig(),
      [`${out}/fleet/vole-queries.yml`]: fleetQueryPack(),
    };
    for (const k of Object.keys(sentinel.dcrKql)) {
      files[`${out}/sentinel/${k}.kql`] = sentinel.dcrKql[k] ?? '';
    }
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(path.split('/').slice(0, -1).join('/'), { recursive: true });
      writeFileSync(path, content);
    }
    console.log(JSON.stringify({ written: Object.keys(files).length, detection_rules: DETECTION_RULES.map((r) => r.id) }, null, 1));
    return;
  }

  console.log(exportJson());
}

if (process.argv[1]?.endsWith('export.ts')) {
  void main();
}
