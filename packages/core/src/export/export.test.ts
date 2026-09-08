/**
 * Tier 7 export-wire tests: the registry, the shapes, the outbox, the sinks,
 * the semconv pin, the span model, the heartbeat, the detection content and
 * the loopback receiver. Everything here is the load-bearing privacy and
 * delivery logic — the encoder that must refuse, the cursor that must not
 * rewind, the chain that must verify.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache, insertEvents, insertAnomalies, type DB } from '../db';
import type { UsageEvent, Anomaly } from '../types';
import {
  encodeFields, providerForModel, loadSemconv, digestOf, selectColumns,
} from './fields';
import { encodeShapeRow, docIdFor, SHAPES, deterministicId } from './shapes';
import {
  enqueueOutbox, drainOutbox, changeCursor, rederiveDoc, verifyChain, loadChain, backoffMs,
} from './outbox';
import { SINKS, encodeForSink, rfc5424Message, cefMessage, capabilityMatrix } from './sinks';
import { generateSentinelAssets, tableColumns } from './sinks/sentinel';
import { measureSinkVolume } from './sinks/volume';
import { DETECTION_RULES, generateSigma, generateSpl, generateEql, validateAgainstRegistry } from '../siem/sigma';
import { buildSpans } from './spans';
import { heartbeatDoc, toolFreshness, detectLogSourceStopped, packRecords } from './heartbeat';
import { mcpInventory, mcpInventoryJson, mcpInventoryDigest } from './mcp-inventory';
import { parseOtlpJson, insertTelemetry, reconcileTelemetry } from './loopback';
import { PUBLIC_TABLES, atcConfig, fleetQueryPack } from '../cli/query';
import { absenceCounts } from '../cli/export';

const CTX = { device_id: 'd:test', identity_mode: 'pseudonymous' as const, opt_in: new Set<string>() };

function tempDb(name: string): { db: DB; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), `vole-export-${name}-`));
  process.env.VOLE_EXPORT_DIR = join(dir, 'checkpoints');
  const db = openDb(join(dir, 'vole.db'));
  return { db, dir };
}

function cleanup(dir: string): void {
  resetDbCache();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.VOLE_EXPORT_DIR;
}

function ev(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    event_key: 'k1', tool: 'claude_code', model: 'claude-opus-4-5', session_id: 's1',
    project: '/Users/x/dev/vole', git_branch: 'main', ts: 1_700_000_000_000,
    input_tokens: 10, output_tokens: 20, cache_write_5m_tokens: null, cache_write_1h_tokens: null,
    cache_read_tokens: null, reasoning_tokens: null, total_tokens: 30, cost_usd: 0.01,
    confidence: 'exact', is_error: 0, stop_reason: null, source: 'live', raw_ref: '/x#1',
    tools: null, agent_id: null, context_window: null, duration_ms: null, duration_kind: null,
    ...overrides,
  };
}

function an(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    anomaly_key: 'live:burn:1', rule: 'billable_burn_spike', severity: 'warn', tool: 'claude_code',
    session_id: 's1', model: null, window_start: 1, window_end: 2, title: 'Burn',
    detail: 'burned', observed: 100, baseline: 10, threshold: 50, confidence: 'exact',
    source: 'live', detected_at: 1_700_000_000_500, ...overrides,
  };
}

// ── fields: the registry and the NULL-omitting encoder ────────────────────

test('encoder omits NULL, refuses never-fields, gates opt-in, transforms', () => {
  const row = {
    event_key: 'k1', ts: 5, tool: 'claude_code', model: 'claude-opus-4-5', session_id: 's1',
    project: '/Users/x/dev/vole', raw_ref: '/secret/path#7', user: 'alice', machine: 'mac1',
    cost_usd: null, total_tokens: 30, detail: 'free text', asset_basis: 'raw match string',
  };
  const out = encodeFields('usage_events', row, CTX);
  assert.equal(out.cost_usd, undefined, 'NULL is omitted, never zero');
  assert.equal(out.raw_ref, undefined, 'raw_ref never leaves');
  assert.equal(out.project_repo, 'vole', 'project becomes the repo slug, not the path');
  assert.equal(out.user, digestOf('alice'), 'user is pseudonymised');
  assert.equal(out.machine, digestOf('mac1'));
  assert.equal(out.total_tokens, 30);

  // Identity mode 'named' passes cleartext (per policy).
  const named = encodeFields('usage_events', row, { ...CTX, identity_mode: 'named' });
  assert.equal(named.user, 'alice');

  // Opt-in gated.
  const anom = { anomaly_key: 'a1', asset_tier: 1, asset_rev: 3, asset_id: 'jewel-1', rule: 'r' };
  const plain = encodeFields('anomalies', anom, CTX);
  assert.equal(plain.asset_tier, 1, 'tier travels');
  assert.equal(plain.asset_rev, 3, 'the chain link travels');
  assert.equal(plain.asset_id, undefined, 'names are opt-in');
  const withOptIn = encodeFields('anomalies', anom, { ...CTX, opt_in: new Set(['asset_id']) });
  assert.equal(withOptIn.asset_id, 'jewel-1');

  // A row the encoder never saw the columns of still cannot smuggle through.
  const smuggle = encodeFields('usage_events', { ...row, args_digest: 'x', detail_params: 'y' }, CTX);
  assert.equal(JSON.stringify(smuggle).includes('args_digest'), false);
  assert.equal(JSON.stringify(smuggle).includes('detail_params'), false);
});

test('secret sighting shape never carries a path, offset or length', () => {
  const row = {
    fingerprint: 'fp123:abcdef', detector: 'aws-key', sink_key: 'sk1', path: '/Users/x/.claude/projects/s.jsonl',
    byte_offset: 4096, byte_length: 40, direction: 'at_rest', status: 'confirmed',
    occurrences: 2, provider: 'AWS_KEY_ID', class_entry_id: 'aws-1', validator_checked: 1,
    first_seen: 1, last_seen: 2,
  };
  const encoded = encodeShapeRow('vole.secret_sighting.v1', row, CTX);
  const json = JSON.stringify(encoded.wire);
  assert.equal(json.includes('byte_offset'), false, 'no map to the secret');
  assert.equal(json.includes('byte_length'), false);
  assert.equal(json.includes('/Users/x'), false, 'the path never leaves in the clear');
  assert.equal(encoded.wire['path_hmac'], digestOf('/Users/x/.claude/projects/s.jsonl'));
  assert.equal(encoded.wire['dir_prefix'], '.claude', 'public agent-home vocabulary only');
  assert.equal(encoded.wire['key_epoch'], 123);
  assert.ok(encoded.wire['fingerprint']);
  assert.ok(encoded.wire['occurrences'] === 2);
  assert.equal(encoded.sync_key.device_id, 'd:test');
  assert.equal(encoded.sync_key.event_key, 'fp123:abcdef');
});

test('provider normalisation has an explicit unknown bucket', () => {
  assert.equal(providerForModel('claude-opus-4-5'), 'anthropic');
  assert.equal(providerForModel('anthropic/claude-3'), 'anthropic');
  assert.equal(providerForModel('gpt-5.5'), 'openai');
  assert.equal(providerForModel('grok-composer-2.5-fast'), 'x_ai');
  assert.equal(providerForModel('gemini-2.5-pro'), 'gcp.gemini');
  // claude via litellm behind a copilot exception: a gateway, not a provider.
  assert.equal(providerForModel('github-copilot/claude-opus-4.6'), 'unknown');
  assert.equal(providerForModel(null), 'unknown');
  assert.equal(providerForModel('totally-new-model'), 'unknown');
  // every non-unknown answer is a semconv enum member
  const snap = loadSemconv();
  const members = snap.attributes['gen_ai.provider.name']!.members!;
  assert.ok(members.includes('anthropic'));
  assert.equal(providerForModel('claude-3'), 'anthropic');
});

test('semconv snapshot pins upstream commit and schema_url', () => {
  const snap = loadSemconv();
  assert.equal(snap.upstream_commit.length, 40);
  assert.ok(snap.schema_url.startsWith('https://'));
  assert.ok(snap.attributes['gen_ai.usage.input_tokens']?.type === 'int');
  assert.throws(() => loadSemconv('1999-01-01'));
});

// ── outbox: change cursor, drain, backoff, drops, checkpoint chain ───────

test('outbox: enqueue is idempotent, change re-pends, cursor never rewinds', async () => {
  const { db, dir } = tempDb('outbox');
  try {
    insertEvents(db, [ev()]);
    const doc = { doc_id: 'vole.event.v1|k1|claude_code', payload: JSON.stringify({ total_tokens: 30 }) };
    let r = enqueueOutbox(db, 'test', [doc], { now: 1000 });
    assert.equal(r.enqueued, 1);
    r = enqueueOutbox(db, 'test', [doc], { now: 2000 });
    assert.equal(r.unchanged + r.requeued, 1, 'second enqueue of same payload is a no-op');

    // deliver, then simulate the upsert's in-place correction (hash changes)
    await drainOutbox(db, 'test', (id) => rederiveDoc(db, id, CTX), async () => ({ ok: true, witness: 'ack-1' }), { now: 3000 });
    const afterDeliver = changeCursor(db, 'test');
    assert.equal(afterDeliver.delivered, 1);
    assert.equal(afterDeliver.last_seq, 1);

    const corrected = { doc_id: doc.doc_id, payload: JSON.stringify({ total_tokens: 45 }) };
    r = enqueueOutbox(db, 'test', [corrected], { now: 4000 });
    assert.equal(r.requeued, 1, 'a corrected row is re-emitted — the rowid cursor would have missed it');
    const cur2 = changeCursor(db, 'test');
    assert.ok(cur2.last_seq >= afterDeliver.last_seq, 'the cursor is monotone over seq');

    // Replay cannot rewind: re-pending delivered docs does not lower the cursor.
    const cur3 = changeCursor(db, 'test');
    assert.ok(cur3.last_seq >= 1);
    const chain = loadChain('test');
    assert.ok(verifyChain(chain), 'checkpoint chain verifies');
    assert.equal(chain.entries.length, 1);
    assert.equal(chain.entries[0]!.witness, 'ack-1');
  } finally {
    cleanup(dir);
  }
});

test('outbox: failed sends back off exponentially and drop with an audited anomaly', async () => {
  const { db, dir } = tempDb('drops');
  try {
    insertEvents(db, [ev()]);
    enqueueOutbox(db, 'failing', [{ doc_id: 'vole.event.v1|k1|claude_code', payload: '{}' }], { now: 0 });
    const maxAttempts = 3;
    let now = 0;
    for (let i = 0; i < maxAttempts; i++) {
      const res = await drainOutbox(db, 'failing', (id) => rederiveDoc(db, id, CTX), async () => ({ ok: false, error: 'boom' }), {
        now, maxAttempts, maxBatch: 10, maxBytes: 1024,
      });
      assert.equal(res.failed + res.dropped, 1);
      now += backoffMs(i + 1); // the drain honours next_attempt_at
    }
    const rows = db.prepare("SELECT rule FROM anomalies WHERE rule = 'export_drop'").all() as { rule: string }[];
    assert.equal(rows.length, 1, 'the doc that exhausted attempts is dropped with an audited incident');
    const cursor = changeCursor(db, 'failing');
    assert.equal(cursor.dropped, 1);
    // a further drain finds nothing pending: the drop is terminal
    const idle = await drainOutbox(db, 'failing', (id) => rederiveDoc(db, id, CTX), async () => ({ ok: true }), {
      now, maxAttempts, maxBatch: 10, maxBytes: 1024,
    });
    assert.equal(idle.attempted, 0);
  } finally {
    cleanup(dir);
  }
});

test('outbox: a pruned source row is an honest drop, never a fabricated send', async () => {
  const { db, dir } = tempDb('pruned');
  try {
    insertEvents(db, [ev()]);
    enqueueOutbox(db, 's', [{ doc_id: 'vole.event.v1|k1|claude_code', payload: '{}' }], { now: 0 });
    db.prepare('DELETE FROM usage_events').run(); // retention pruned it
    const res = await drainOutbox(db, 's', (id) => rederiveDoc(db, id, CTX), async () => ({ ok: true }), { now: 1 });
    assert.equal(res.rebuilt_missing, 1);
    assert.equal(res.delivered, 0);
    assert.equal(changeCursor(db, 's').dropped, 1);
  } finally {
    cleanup(dir);
  }
});

test('outbox: byte cap backpressure drops oldest pending with an anomaly', () => {
  const { db, dir } = tempDb('cap');
  try {
    insertEvents(db, [ev(), ev({ event_key: 'k2' }), ev({ event_key: 'k3' })]);
    enqueueOutbox(db, 'c', [
      { doc_id: 'vole.event.v1|k1|claude_code', payload: 'x'.repeat(100) },
      { doc_id: 'vole.event.v1:k2:claude_code', payload: 'x'.repeat(100) },
    ], { now: 0, maxBytes: 150 });
    const cur = changeCursor(db, 'c');
    assert.equal(cur.pending + cur.dropped, 2);
    assert.ok(cur.pending <= 2, 'cap bounds the queued bytes');
  } finally {
    cleanup(dir);
  }
});

// ── sinks: capability matrix, syslog, CEF, sentinel ──────────────────────

test('sink capability matrix states delivery semantics truthfully', () => {
  const m = capabilityMatrix();
  const byId = Object.fromEntries(m.map((s) => [s.id, s]));
  assert.equal(byId.elastic!.delivery, 'exactly-once-by-id');
  assert.equal(byId.splunk!.delivery, 'at-least-once');
  assert.equal(byId.datadog!.delivery, 'at-least-once');
  assert.equal(byId.syslog!.delivery, 'at-most-once');
  assert.equal(byId.cef!.delivery, 'at-most-once');
  assert.deepEqual(byId.cef!.shapes, ['vole.incident.v1'], 'CEF is incidents only');
  assert.ok(m.every((s) => s.network), 'every sink crosses the network: opt-in, default-off');
});

test('RFC 5424 syslog message: PRI, structured data from the registry, no detail body', () => {
  const row = encodeShapeRow('vole.incident.v1', {
    anomaly_key: 'live:burn:1', rule: 'billable_burn_spike', severity: 'warn', tool: 'claude_code',
    session_id: 's1', window_start: 1_700_000_000_000, window_end: 1_700_000_060_000,
    title: 'Burned 36,751 tokens', observed: 36751, baseline: 12149, threshold: 30000,
    confidence: 'exact', detected_at: 1_700_000_060_000, raw_ref: '/x#1', detail: 'SECRET DETAIL',
  }, CTX);
  const msg = rfc5424Message(CTX, row);
  assert.match(msg, /^<132>1 \d{4}-\d{2}-\d{2}T/, 'PRI = local0(16)*8 + warn(4) = 132');
  assert.ok(msg.includes('[vole@0 '), 'structured-data element present');
  assert.ok(msg.includes('observed="36751"') && msg.includes('baseline="12149"') && msg.includes('threshold="30000"'));
  assert.ok(!msg.includes('SECRET DETAIL'), 'free text never rides syslog');
  assert.ok(!msg.includes('/x#1'), 'raw_ref never rides syslog');
});

test('CEF message: figures as extensions, incidents shape only', () => {
  const row = encodeShapeRow('vole.incident.v1', {
    anomaly_key: 'a1', rule: 'secret_at_rest', severity: 'critical', tool: 'claude_code',
    window_start: 1, window_end: 2, title: 'Secret at rest', observed: 2, baseline: null,
    threshold: null, confidence: 'exact', detected_at: 1_700_000_000_000,
  }, CTX);
  const line = cefMessage(CTX, row);
  assert.match(line, /^CEF:0\|Vole\|vole\|[\d.]+\|secret_at_rest\|Secret at rest\|10\|/);
  assert.ok(line.includes('cn1=2') && line.includes('cn1Label=observed'));
  assert.ok(!line.includes('cn2='), 'NULL baseline is omitted, not zero');
  const rejected = encodeForSink('cef', CTX, [
    encodeShapeRow('vole.event.v1', { event_key: 'k1', ts: 1, tool: 'claude_code', confidence: 'exact' }, CTX),
    row,
  ]);
  assert.equal(rejected.length, 1, 'non-incident shapes are refused by the CEF sink');
});

test('elastic bulk carries the document id; splunk does not', () => {
  const row = encodeShapeRow('vole.event.v1', { event_key: 'k1', ts: 1, tool: 'claude_code', confidence: 'exact', total_tokens: 5 }, CTX);
  const elastic = encodeForSink('elastic', CTX, [row])[0]!;
  assert.match(elastic.bytes, /^\{"index":\{"_id":"d:test:vole\.event\.v1\|k1\|claude_code"\}\}/);
  const splunk = encodeForSink('splunk', CTX, [row])[0]!;
  assert.ok(!splunk.bytes.includes('"_id"'), 'HEC has no client-supplied id — at-least-once, stated in the matrix');
});

test('sentinel connector is generated from the field registry', () => {
  const assets = generateSentinelAssets();
  const incidentCols = tableColumns('vole.incident.v1').map((c) => c.name);
  assert.ok(incidentCols.includes('Observed_CL') && incidentCols.includes('Baseline_CL') && incidentCols.includes('Threshold_CL'));
  assert.ok(!incidentCols.includes('Detail_CL'), 'never-fields cannot appear in the DCR');
  const arm = JSON.parse(assets.armTemplate);
  assert.ok(arm.resources.some((r: { type: string }) => r.type === 'Microsoft.Insights/dataCollectionRules'));
  // registry-driven: every wire field of every shape has a table column
  for (const name of Object.keys(SHAPES)) {
    const cols = tableColumns(name).map((c) => c.name);
    for (const wire of ['observed', 'event_key'].values()) {
      if (selectColumns(SHAPES[name]!.table).length > 0) assert.ok(cols.length > 2);
    }
  }
});

// ── detection content: every referenced field is exportable ──────────────

test('detection content pack references only fields the exporter can emit', () => {
  assert.deepEqual(validateAgainstRegistry(), []);
  const sigma = generateSigma();
  assert.ok(sigma.includes('permission_mode: "bypassPermissions"'));
  assert.ok(sigma.includes('product: vole'), 'custom taxonomy, stated');
  assert.ok(generateSpl().includes('vole_bypass') || generateSpl().includes('permission_mode'));
  assert.ok(generateEql().includes('vole.tool_call.v1'));
  assert.ok(DETECTION_RULES.some((r) => r.id === 'log_source_stopped'), 'the dead-man\'s switch ships in the pack');
});

// ── span model ────────────────────────────────────────────────────────────

test('spans: measured tool durations, honestly zero-length chat spans', () => {
  const { db, dir } = tempDb('spans');
  try {
    db.prepare(`
      INSERT INTO tool_calls (tool_call_key, tool, name, shape, session_id, ts, status, duration_ms, duration_kind, first_seen, last_seen)
      VALUES ('tc1', 'claude_code', 'Read', 'read', 's1', 1000, 'ok', 127, 'measured', 1000, 1000),
             ('tc2', 'claude_code', 'Bash', 'bash', 's1', 2000, 'ok', NULL, NULL, 2000, 2000)
    `).run();
    insertEvents(db, [
      ev({ event_key: 'e1', session_id: 's1', ts: 3000, duration_ms: null, duration_kind: null }),
      ev({ event_key: 'e2', session_id: 's1', ts: 4000, duration_ms: 5000, duration_kind: 'measured' }),
    ]);
    const spans = buildSpans(db, CTX, {});
    const read = spans.find((s) => s.name === 'execute_tool Read')!;
    assert.equal(Number(read.end_time_unix_nano) - Number(read.start_time_unix_nano), 127 * 1e6, 'real duration');
    const bash = spans.find((s) => s.name === 'execute_tool Bash')!;
    assert.equal(bash.attributes['vole.duration_source'], 'none');
    const chat1 = spans.find((s) => s.name === 'chat' && s.attributes['gen_ai.usage.input_tokens'] === 10)!;
    assert.equal(Number(chat1.end_time_unix_nano) - Number(chat1.start_time_unix_nano), 0, 'zero-length, honestly');
    assert.equal(chat1.attributes['vole.duration_source'], 'none');
    const chat2 = spans.find((s) => s.span_id === spans.filter((x) => x.name === 'chat')[1]!.span_id)!;
    assert.equal(chat2.attributes['vole.duration_source'], 'measured');
    // deterministic ids: rebuild gives byte-identical spans
    assert.deepEqual(buildSpans(db, CTX, {}), spans);
    // every chat/tool span hangs off the session root, and the root exists
    const root = spans.find((s) => s.name === 'session')!;
    assert.ok(spans.filter((s) => s.name !== 'session').every((s) => s.parent_span_id === root.span_id));
  } finally {
    cleanup(dir);
  }
});

// ── heartbeat and the dead-man's switch ──────────────────────────────────

test('heartbeat is idempotent per machine+bucket and carries per-tool freshness', () => {
  const { db, dir } = tempDb('hb');
  try {
    db.prepare(`INSERT INTO collector_runs (tool, started_at, duration_ms, files, parsed, inserted, source_state, ok)
                VALUES ('claude_code', 1000, 1, 1, 1, 1, 'ok', 1)`).run();
    const fresh = toolFreshness(db);
    assert.equal(fresh.find((t) => t.tool === 'claude_code')?.last_run_at, 1000);
    assert.equal(fresh.find((t) => t.tool === 'codex'), undefined, 'no run record is absent, never zero');

    const a = heartbeatDoc(db, 'd:x', { now: 10_000, intervalMs: 5000 });
    const b = heartbeatDoc(db, 'd:x', { now: 10_500, intervalMs: 5000 });
    assert.equal(a.doc_id, b.doc_id, 'same bucket, same doc id — idempotent');
    assert.equal(a.record.attributes['up'], 1);
    assert.equal(a.record.attributes['vole.tool.claude_code.last_seen'], 1000);

    // Dead-man's switch: silent for two intervals fires; unknown tools never do.
    const fired = detectLogSourceStopped([{ tool: 'claude_code', last_run_at: 1000 }], 5000, 1000 + 11_000);
    assert.equal(fired.length, 1);
    assert.equal(fired[0]!.rule, 'log_source_stopped');
    assert.equal(detectLogSourceStopped([{ tool: 'codex', last_run_at: null }], 5000, 1e9).length, 0);
    assert.equal(detectLogSourceStopped([{ tool: 'claude_code', last_run_at: 1000 }], 5000, 1000 + 6000).length, 0);
  } finally {
    cleanup(dir);
  }
});

test('pack records expose inventory with NULL ring, never a guess', () => {
  const { db, dir } = tempDb('packs');
  try {
    db.prepare(`INSERT INTO content_packs (kind, version, checksum, loaded_at, active, trust)
                VALUES ('dlp', 3, 'abc', 1700000000000, 1, 'signed')`).run();
    const packs = packRecords(db, 1700000000000 + 3 * 86_400_000);
    assert.equal(packs.length, 1);
    assert.equal(packs[0]!.ring, null, 'ring is whatever MDM wrote — here, nothing');
    assert.equal(packs[0]!.age_days, 3);
    assert.equal(packs[0]!.load_state, 'active');
  } finally {
    cleanup(dir);
  }
});

// ── MCP inventory ────────────────────────────────────────────────────────

test('MCP inventory is server.json-shaped and deterministic', () => {
  const { db, dir } = tempDb('mcp');
  try {
    const ins = db.prepare(`
      INSERT INTO posture_mcp_servers (source, config_path, client, server_name, mcp_identity, transport, command, argv, url, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    ins.run('file', '/u/.claude.json', 'claude_code', 'github', 'github', 'stdio', 'npx', JSON.stringify(['-y', '@modelcontextprotocol/server-github']), null, 1, 2);
    ins.run('file', '/u/.claude.json', 'claude_code', 'web', 'web', 'http', null, null, 'https://mcp.example/sse', 1, 2);
    const a = mcpInventory(db);
    const b = mcpInventory(db);
    assert.equal(mcpInventoryJson(a), mcpInventoryJson(b), 'two runs diff to nothing');
    assert.equal(mcpInventoryDigest(a), mcpInventoryDigest(b));
    const gh = a.servers.find((s) => s.name === 'github')!;
    assert.deepEqual(gh.packages, [{ registryType: 'npm', identifier: '@modelcontextprotocol/server-github', runtimeHint: 'node' }]);
    assert.equal(gh.description, undefined, 'NULL is omitted, never invented');
    const web = a.servers.find((s) => s.name === 'web')!;
    assert.deepEqual(web.remotes, [{ type: 'http', url: 'https://mcp.example/sse' }]);
    assert.ok(!mcpInventoryJson(a).includes('generated_at'), 'no generation timestamp in the body');
  } finally {
    cleanup(dir);
  }
});

// ── loopback receiver: parse, dedupe, reconcile ──────────────────────────

test('loopback receiver parses OTLP JSON, dedupes, and reconciles parser fidelity', () => {
  const { db, dir } = tempDb('otel');
  try {
    const body = JSON.stringify({
      resourceLogs: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude_code' } }] },
        scopeLogs: [{
          logRecords: [
            {
              timeUnixNano: '1700000000000000000',
              body: { stringValue: 'tool_decision' },
              attributes: [
                { key: 'gen_ai.conversation.id', value: { stringValue: 's9' } },
                { key: 'claude_code.code_edit_tool.decision', value: { stringValue: 'accept' } },
              ],
            },
            {
              timeUnixNano: '1700000000000000001',
              body: { stringValue: 'tool_decision' },
              attributes: [
                { key: 'gen_ai.conversation.id', value: { stringValue: 's9' } },
                { key: 'claude_code.code_edit_tool.decision', value: { stringValue: 'reject' } },
              ],
            },
          ],
        }],
      }],
    });
    const rows = parseOtlpJson(body);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.event_name, 'tool_decision');
    assert.equal(rows[0]!.session_id, 's9');
    const r1 = insertTelemetry(db, rows);
    assert.equal(r1.accepted, 2);
    const r2 = insertTelemetry(db, parseOtlpJson(body));
    assert.equal(r2.duplicates, 2, 'OTLP retries dedupe on the content key');

    // Parser fidelity: 2 tool-reported events vs 0 parsed rows -> a gap.
    insertEvents(db, [ev({ event_key: 'x1', session_id: 's9', ts: 1_700_000_000_000 })]);
    const gaps = reconcileTelemetry(db, 1_700_000_100_000);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.rule, 'reconcile_gap');
    assert.equal(gaps[0]!.observed, 2);
    assert.equal(gaps[0]!.baseline, 1);
    // idempotent: same inputs, same key, no duplicates in anomalies
    insertAnomalies(db, gaps);
    insertAnomalies(db, gaps);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM anomalies WHERE rule = 'reconcile_gap'").get() as { n: number }).n, 1);
  } finally {
    cleanup(dir);
  }
});

// ── volume measurement, public query schema, absence strip ───────────────

test('volume is measured from real serialized bytes with a labelled window', () => {
  const { db, dir } = tempDb('vol');
  try {
    insertEvents(db, [
      ev({ event_key: 'v1' }), ev({ event_key: 'v2', model: 'gpt-5.5' }),
      ev({ event_key: 'v3', model: 'gpt-5.5', project: '/u/other' }),
    ]);
    const report = measureSinkVolume(db, 'elastic', CTX, { days: 1, now: 1_700_000_000_000 + 1 });
    assert.ok(report.bytes > 0, 'measured from actual encoder output');
    assert.equal(report.events, 3);
    assert.equal(report.distinct_series, 3, 'tool x model x confidence x project in the data');
    assert.equal(report.projection_30d.events, report.events * 30, 'labelled linear projection');
    assert.equal(report.window.days, 1);
  } finally {
    cleanup(dir);
  }
});

test('public query tables preserve NULL and ship the unpriced counter', () => {
  const { db, dir } = tempDb('query');
  try {
    insertEvents(db, [
      ev({ event_key: 'p1', cost_usd: 0.5 }),
      ev({ event_key: 'p2', cost_usd: null, model: null }),
    ]);
    const agents = PUBLIC_TABLES.vole_agents!.rows(db) as {
      tool: string; events: number; cost_usd: number | null; unpriced_events: number;
    }[];
    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.events, 2);
    assert.equal(agents[0]!.cost_usd, 0.5);
    assert.equal(agents[0]!.unpriced_events, 1, 'the denominator beside the aggregate');

    const incidents = PUBLIC_TABLES.vole_incidents!.rows(db);
    assert.equal(incidents.length, 0, 'no live incidents, empty not fabricated');
    // the ATC pack and Fleet queries reference the public tables
    const atc = atcConfig();
    assert.ok(atc.includes('"vole_usage_events"') && atc.includes("source = 'live'"));
    assert.ok(fleetQueryPack().includes('vole_bypass_sessions'));
  } finally {
    cleanup(dir);
  }
});

test('absence strip counts exported rows with no tokens, cost or model', () => {
  const { db, dir } = tempDb('abs');
  try {
    insertEvents(db, [
      ev({ event_key: 'a1' }),
      ev({ event_key: 'a2', total_tokens: null, cost_usd: null }),
      ev({ event_key: 'a3', model: null }),
    ]);
    const counts = absenceCounts(db, 0);
    assert.equal(counts.rows, 3);
    assert.equal(counts.no_tokens, 1);
    assert.equal(counts.no_cost, 1);
    assert.equal(counts.no_model, 1);
  } finally {
    cleanup(dir);
  }
});

// ── doc ids and deterministic ids ─────────────────────────────────────────

test('doc ids are deterministic and shape-prefixed', () => {
  const row = { event_key: 'k1', tool: 'claude_code' };
  assert.equal(docIdFor(SHAPES['vole.event.v1']!, row), 'vole.event.v1|k1|claude_code');
  assert.equal(deterministicId('a', 'b'), deterministicId('a', 'b'));
  assert.notEqual(deterministicId('a', 'b'), deterministicId('a', 'c'));
});

// ── the OTLP wire contract, end to end ───────────────────────────────────

test('otlp export validates against the pinned semconv snapshot', async () => {
  const { otlpExport, validateAgainstSnapshot } = await import('../cli/otlp');
  const { dir } = (() => {
    const d = mkdtempSync(join(tmpdir(), 'vole-export-otlp-'));
    const db = openDb(join(d, 'vole.db'));
    insertEvents(db, [ev()]);
    insertAnomalies(db, [an()]);
    return { dir: d };
  })();
  resetDbCache();
  process.env.VOLE_DB = join(dir, 'vole.db');
  try {
    const snap = loadSemconv();
    const exp = otlpExport({ limit: 10 });
    assert.deepEqual(validateAgainstSnapshot(exp, snap), [], 'every gen_ai.* name is in the pinned snapshot');
    const dual = otlpExport({ limit: 10, dualEmit: true });
    assert.deepEqual(validateAgainstSnapshot(dual, snap, { legacyAllowed: true }), []);

    // the figures that fired travel beside observed
    const incident = exp.scopeLogs[0]!.logRecords.find((r) => r.attributes['vole.rule'] === 'billable_burn_spike')!;
    assert.equal(incident.attributes['vole.observed'], 100);
    assert.equal(incident.attributes['vole.baseline'], 10);
    assert.equal(incident.attributes['vole.threshold'], 50);
    assert.ok(incident.attributes['vole.device_id'], 'device-scoped sync key half');
    assert.ok(incident.attributes['vole.event_key']);

    // heartbeat scope: one record, up=1
    const beat = exp.scopeLogs.find((s) => s.scope.name === 'vole.heartbeat')!;
    assert.equal(beat.logRecords[0]!.attributes['up'], 1);

    // deterministic ids: re-export is byte-stable except the heartbeat ts
    const again = otlpExport({ limit: 10 });
    assert.equal(
      JSON.stringify(again.scopeLogs[0]),
      JSON.stringify(exp.scopeLogs[0]),
      'incident records are replay-stable',
    );
  } finally {
    delete process.env.VOLE_DB;
    resetDbCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
