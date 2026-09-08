import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp: string;
let home: string;
let dbMod: typeof import('../db');

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vole-tele-'));
  home = join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  process.env.VOLE_HOME_OVERRIDE = home;
  process.env.VOLE_DB = join(tmp, 'vole.db');
});

const dbFor = async (name: string) => {
  dbMod ??= await import('../db');
  dbMod.resetDbCache();
  return dbMod.openDb(join(tmp, name));
};

test('telemetry levers: endpoint becomes a host, headers become names only, absent keys stay absent', async () => {
  const { telemetryLeversFromEnv } = await import('./telemetry');
  const levers = telemetryLeversFromEnv({
    CLAUDE_CODE_ENABLE_TELEMETRY: 'true',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com:4317',
    OTEL_EXPORTER_OTLP_HEADERS: 'api-key=secret-value',
    OTEL_LOG_USER_PROMPTS: 'true',
  });
  const byLever = new Map(levers.map((l) => [l.lever, l]));
  assert.equal(byLever.get('env:CLAUDE_CODE_ENABLE_TELEMETRY')!.observed, 'true');
  const endpoint = byLever.get('env:OTEL_EXPORTER_OTLP_ENDPOINT')!;
  assert.equal(endpoint.observed, 'otel.example.com:4317'); // host, never the full URL with path
  const headers = byLever.get('env:OTEL_EXPORTER_OTLP_HEADERS')!;
  assert.equal(headers.observed, '<names only>'); // the value never reaches the store
  assert.equal(byLever.get('env:OTEL_LOG_USER_PROMPTS')!.observed, 'true');
  assert.equal(byLever.has('env:OTEL_LOG_TOOL_CONTENT'), false); // not set is not a lever
});

test('telemetry posture reads the precedence layers and names the file that decided', async () => {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
    env: { CLAUDE_CODE_ENABLE_TELEMETRY: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' },
  }));
  const { sweepTelemetryPosture } = await import('./telemetry');
  const db = await dbFor('a.db');
  const now = Date.parse('2026-09-07T00:00:00Z');
  assert.equal(sweepTelemetryPosture(db, now), 2);
  const rows = db.prepare('SELECT lever, observed_value, hardened_value, source_file FROM posture_levers ORDER BY lever').all() as Record<string, string>[];
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.lever === 'env:CLAUDE_CODE_ENABLE_TELEMETRY')!.hardened_value, 'unset');
  assert.ok(rows.every((r) => r.source_file.includes('settings.json')));
  dbMod!.resetDbCache();
});

test('detection_epochs: one row per rule-set identity, idempotent, epoch derived not clocked', async () => {
  const { recordDetectionEpoch, ruleSetSha } = await import('./telemetry');
  const db = await dbFor('b.db');
  const now = Date.parse('2026-09-07T00:00:00Z');
  const e1 = recordDetectionEpoch(db, now);
  assert.equal(e1, 1);
  assert.equal(recordDetectionEpoch(db, now + 10_000), 1); // same sha: no second row
  const row = db.prepare('SELECT epoch, rule_set_sha256 FROM detection_epochs').get() as { epoch: number; rule_set_sha256: string };
  assert.equal(row.epoch, 1);
  assert.equal(row.rule_set_sha256, ruleSetSha());
  dbMod!.resetDbCache();
});
