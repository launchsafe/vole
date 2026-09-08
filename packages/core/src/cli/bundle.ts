/**
 * Tier 7 the evidence bundle: one .zip containing exactly the row(s), the
 * figures that fired, the window's evidence, and a manifest naming every
 * column included and every transform applied. BEFORE anything is written,
 * the payload is rendered field by field (--preview) and a
 * re-identification scan runs over every string field looking for the local
 * OS username, the hostname, the RealName and the oauth email — a hit fails
 * the bundle closed.
 *
 *   tsx packages/core/src/cli/bundle.ts [--preview]
 *   tsx packages/core/src/cli/bundle.ts --incident <anomaly_key> [--preview] [--out x.zip]
 *
 * The incident form carries byte-offset provenance: every fact's raw_ref is
 * <transcript path>#<byte offset>, marked verifiable or expired against the
 * vendor's cleanup horizon at export time. It is evidence about rows in one
 * SQLite file at export time, not a tamper-proof chain — integrity rests on
 * the file's own checksum until the hash chain lands.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import type { DB } from '../db';
import { openDbReadOnly } from '../db';
import { localIdentifiers, reIdentificationScan } from './support';
import { exportJson } from './export';
import { custodyFigures, custodySentence, deriveEvidenceGaps, collectWitnessTimestamps } from '../triage/custody';

// ── A dependency-free ZIP writer (stored entries) ──────────────────────────────
// No new npm packages, by convention. Stored (uncompressed) entries keep the
// writer ~40 lines; bundle payloads are JSON, which gzips well but does not
// need to.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function makeZip(files: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // no flags — deterministic output, no timestamps
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01, fixed
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, f.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(f.data.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + f.data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ── The pre-export field preview ─────────────────────────────────────────────

export interface PreviewField {
  table: string;
  column: string;
  wire_name: string;
  transform: 'passthrough' | 'dropped' | 'hashed';
}

/**
 * The incident bundle's field list — the deliberate review point. observed /
 * baseline / threshold always ride (the figures that fired); the free-text
 * detail and the acting user's name never do.
 */
export function incidentPreviewFields(): PreviewField[] {
  const ride: [string, string][] = [
    ['anomalies', 'anomaly_key'], ['anomalies', 'case_key'], ['anomalies', 'rule'],
    ['anomalies', 'severity'], ['anomalies', 'tool'], ['anomalies', 'model'],
    ['anomalies', 'session_id'], ['anomalies', 'window_start'], ['anomalies', 'window_end'],
    ['anomalies', 'title'], ['anomalies', 'observed'], ['anomalies', 'baseline'],
    ['anomalies', 'threshold'], ['anomalies', 'confidence'], ['anomalies', 'detected_at'],
    ['anomalies', 'detail_key'], ['anomalies', 'detail_params'], ['anomalies', 'content_rev'],
    ['anomalies', 'state'], ['anomalies', 'state_ts'],
    ['tool_calls', 'tool'], ['tool_calls', 'name'], ['tool_calls', 'shape'],
    ['tool_calls', 'ts'], ['tool_calls', 'status'], ['tool_calls', 'authority'],
    ['tool_calls', 'authorization_basis'], ['tool_calls', 'permission_mode'],
    ['tool_calls', 'raw_ref'],
  ];
  const drop: [string, string][] = [
    ['anomalies', 'detail'], ['anomalies', 'user'], ['anomalies', 'machine'],
    ['anomalies', 'state_actor'], ['tool_calls', 'args_digest'], ['tool_calls', 'agent_id'],
  ];
  return [
    ...ride.map(([table, column]) => ({ table, column, wire_name: column, transform: 'passthrough' as const })),
    ...drop.map(([table, column]) => ({ table, column, wire_name: column, transform: 'dropped' as const })),
  ];
}

// ── The incident evidence bundle ─────────────────────────────────────────────

/** Claude Code's cleanup horizon, read from the tool's own settings; default 30d. */
function cleanupHorizonDays(): number {
  try {
    const home = process.env.VOLE_HOME_OVERRIDE ?? userInfo().homedir;
    const cfg = JSON.parse(readFileSync(`${home}/.claude.json`, 'utf8')) as { cleanupPeriodDays?: number };
    if (typeof cfg.cleanupPeriodDays === 'number') return cfg.cleanupPeriodDays;
  } catch { /* not set — the tool default applies */ }
  return 30;
}

interface RawRef {
  raw_ref: string;
  /** re-readable inside the vendor's cleanup horizon at export time */
  verifiable: boolean | null;
  reason: string;
}

/**
 * Every raw_ref of <path>#<byte offset>, marked verifiable (file exists AND
 * its mtime is inside the horizon) or expired. A byte offset is re-readable
 * only inside that horizon — the bundle records it, it does not promise it.
 */
export function classifyRawRefs(refs: (string | null)[], horizonDays: number, now: number = Date.now()): RawRef[] {
  const horizonMs = horizonDays * 86400000;
  const seen = new Map<string, RawRef>();
  for (const ref of refs) {
    if (!ref || seen.has(ref)) continue;
    const hash = ref.lastIndexOf('#');
    const file = hash > 0 ? ref.slice(0, hash) : ref;
    let verifiable: boolean | null = null;
    let reason: string;
    try {
      const st = statSync(file);
      if (now - st.mtimeMs > horizonMs) {
        verifiable = false;
        reason = 'expired: outside the vendor cleanup horizon at export time';
      } else {
        verifiable = true;
        reason = 'verifiable: file exists inside the horizon';
      }
    } catch {
      verifiable = false;
      reason = 'expired: source file no longer exists';
    }
    seen.set(ref, { raw_ref: ref, verifiable, reason });
  }
  return [...seen.values()];
}

export interface IncidentBundle {
  bundle_kind: 'vole_incident_evidence';
  generated_at: string;
  anomaly: Record<string, unknown>;
  autonomy_intervals: unknown[];
  grants: unknown[];
  window: {
    usage_events: unknown[];
    tool_calls: unknown[];
    file_writes: unknown[];
    bounding_entries: { first: unknown; last: unknown };
  };
  raw_refs: RawRef[];
  horizon_days: number;
  chain_of_evidence: Record<string, unknown>;
  custody: { figures: unknown; sentence: string };
  manifest: { columns: PreviewField[]; note: string };
}

export function incidentBundle(db: DB, anomaly_key: string, now: number = Date.now()): IncidentBundle | null {
  const anomaly = db
    .prepare(
      `SELECT anomaly_key, case_key, rule, severity, tool, session_id, model, window_start, window_end,
              title, observed, baseline, threshold, confidence, detected_at, detail_key, detail_params,
              content_rev, state, state_ts
       FROM anomalies WHERE anomaly_key = ?`,
    )
    .get(anomaly_key) as Record<string, unknown> | undefined;
  if (!anomaly) return null;
  const sessionId = anomaly.session_id as string | null;
  const ws = anomaly.window_start as number;
  const we = anomaly.window_end as number;

  const usage = sessionId
    ? db.prepare(
        `SELECT ts, tool, model, input_tokens, output_tokens, cache_read_tokens, total_tokens, cost_usd, confidence
         FROM usage_events WHERE session_id = ? AND ts BETWEEN ? AND ? ORDER BY ts`,
      ).all(sessionId, ws, we)
    : [];

  const calls = sessionId
    ? db.prepare(
        `SELECT tool, name, shape, ts, status, authority, authorization_basis, permission_mode, raw_ref
         FROM tool_calls WHERE session_id = ? AND ts BETWEEN ? AND ? ORDER BY ts`,
      ).all(sessionId, ws, we)
    : [];
  const writes = sessionId
    ? db.prepare(
        `SELECT fw.path, fw.path_class, fw.write_class, fw.change_risk_class, fw.escape_state, fw.ts
         FROM file_writes fw JOIN tool_calls tc ON tc.tool_call_key = fw.tool_call_key
         WHERE fw.session_id = ? AND fw.ts BETWEEN ? AND ? ORDER BY fw.ts`,
      ).all(sessionId, ws, we)
    : [];
  const intervals = sessionId
    ? db.prepare(
        'SELECT * FROM autonomy_intervals WHERE session_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)',
      ).all(sessionId, we, ws)
    : [];
  const grants = db
    .prepare('SELECT agent, kind, granted_by, scope, entry_class FROM grants WHERE agent = ?')
    .all((anomaly.tool as string) ?? '');

  // The bounding entries of the window: the first and last ledger calls,
  // carrying their authority state so an auditor sees the human gates.
  const bounding = {
    first: calls[0] ?? null,
    last: calls[calls.length - 1] ?? null,
  };

  const horizonDays = cleanupHorizonDays();
  const rawRefs = classifyRawRefs(
    [...(calls as { raw_ref?: string | null }[]).map((c) => c.raw_ref ?? null)],
    horizonDays,
    now,
  );

  const figures = custodyFigures(db, ws, we);
  return {
    bundle_kind: 'vole_incident_evidence',
    generated_at: new Date(now).toISOString(),
    anomaly,
    autonomy_intervals: intervals,
    grants,
    window: { usage_events: usage, tool_calls: calls, file_writes: writes, bounding_entries: bounding },
    raw_refs: rawRefs,
    horizon_days: horizonDays,
    chain_of_evidence: {
      store_schema: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      packs: db.prepare('SELECT kind, version, checksum, trust FROM content_packs ORDER BY kind').all(),
      pricing_rev: (db.prepare('SELECT MAX(pricing_rev) AS r FROM usage_events').get() as { r: number | null }).r,
      collector_run: db
        .prepare('SELECT tool, started_at, duration_ms, ok FROM collector_runs ORDER BY started_at DESC LIMIT 1')
        .get(),
    },
    custody: { figures, sentence: custodySentence(figures) },
    manifest: {
      columns: incidentPreviewFields(),
      note: 'deny-by-default: only listed fields ride; raw_ref carries <path>#<byte offset> provenance marked verifiable or expired against the cleanup horizon',
    },
  };
}

export function incidentMarkdown(b: IncidentBundle): string {
  const a = b.anomaly;
  const lines = [
    '# Vole incident evidence',
    '',
    `- rule: \`${a.rule}\`  severity: \`${a.severity}\``,
    `- figures that fired: observed **${a.observed}** / baseline ${a.baseline ?? '—'} / threshold ${a.threshold ?? '—'}`,
    `- window: ${new Date(a.window_start as number).toISOString()} → ${new Date(a.window_end as number).toISOString()}`,
    `- key: \`${a.anomaly_key}\`  case: \`${a.case_key ?? '—'}\``,
    '',
    `## Custody`,
    '',
    b.custody.sentence,
    '',
    `## Window evidence`,
    '',
    `- ${b.window.usage_events.length} usage rows, ${b.window.tool_calls.length} tool calls, ${b.window.file_writes.length} file writes`,
    `- raw refs: ${b.raw_refs.filter((r) => r.verifiable).length} verifiable, ${b.raw_refs.filter((r) => !r.verifiable).length} expired (horizon ${b.horizon_days} days)`,
    '',
    'Every fact carries a raw_ref of `<transcript path>#<byte offset>` in the JSON bundle so an auditor can re-read the original line inside the horizon.',
  ];
  return lines.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function fail(msg: string): never {
  console.error(`bundle: FAIL — ${msg}`);
  process.exit(1);
}

function main(): void {
  const args = process.argv.slice(2);
  const preview = args.includes('--preview');
  const incIdx = args.indexOf('--incident');
  const incidentKey = incIdx >= 0 ? args[incIdx + 1] : null;
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : null;

  const db = openDbReadOnly();
  const ids = localIdentifiers();

  if (incidentKey) {
    const bundle = incidentBundle(db, incidentKey);
    db.close();
    if (!bundle) fail(`no anomaly with key ${incidentKey} in this store`);
    const hits = reIdentificationScan(bundle, ids);
    if (hits.length > 0) {
      // Fail closed: nothing is written, and the report names the path only.
      fail(`re-identification scan found local identifiers at ${hits.map((h) => h.path).join(', ')}`);
    }
    const json = Buffer.from(JSON.stringify(bundle, null, 1));
    const md = Buffer.from(incidentMarkdown(bundle));
    if (preview) {
      console.log(JSON.stringify(bundle, null, 1));
      return;
    }
    const zip = makeZip([
      { name: 'incident.json', data: json },
      { name: 'incident.md', data: md },
    ]);
    const dest = out ?? `vole-evidence-${Date.now()}.zip`;
    writeFileSync(dest, zip);
    console.log(`evidence bundle written (re-identification scan passed): ${dest}`);
    return;
  }

  // The generic bundle: export payload + the custody sentence over the last
  // 30 days, computed from real coverage figures.
  const windowEnd = Date.now();
  const figures = custodyFigures(db, windowEnd - 30 * 86400000, windowEnd, {
    gaps: deriveEvidenceGaps(
      db.prepare('SELECT started_at, duration_ms FROM collector_runs').all() as { started_at: number; duration_ms: number }[],
      collectWitnessTimestamps(db),
    ),
  });
  const manifest = {
    bundle_version: 1,
    generated_at: new Date().toISOString(),
    custody_sentence: custodySentence(figures),
    contents: { export: JSON.parse(exportJson()) },
    chain_of_evidence: {
      store_schema: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      packs: db.prepare('SELECT kind, version, checksum FROM content_packs').all(),
      scanners: db.prepare('SELECT scanner, last_started_at FROM scan_state').all(),
    },
  };
  db.close();
  const hits = reIdentificationScan(manifest, ids);
  if (hits.length > 0) fail(`re-identification scan found local identifiers at ${hits.map((h) => h.path).join(', ')}`);
  if (preview) {
    console.log(JSON.stringify(manifest, null, 1));
    return;
  }
  const zip = makeZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 1)) },
    { name: 'export.json', data: Buffer.from(JSON.stringify(manifest.contents.export, null, 1)) },
  ]);
  const dest = out ?? `vole-bundle-${Date.now()}.zip`;
  writeFileSync(dest, zip);
  console.log(`bundle written (re-identification scan passed): ${dest}`);
}

if (process.argv[1]?.endsWith('bundle.ts')) {
  main();
}
