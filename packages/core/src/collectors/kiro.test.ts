import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectKiro } from './kiro';
import { makeStore } from './test-store';

function kiroHome(home: string, launch: string, lines: Record<string, unknown>[]) {
  const dir = join(home, '.kiro', 'logs', launch);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'kiro.log'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const T = (s: number) => new Date(1_700_000_000_000 + s * 1000).toISOString();

test('kiro: agent_controller.triggered and the approval lane become ledger rows', () => {
  const s = makeStore('kiro');
  try {
    kiroHome(s.home, '20260101T000000111', [
      { timestamp: T(0), level: 'info', message: 'agent_controller.triggered {"agentType":"coder","autonomyMode":"allow","modelId":"claude-sonnet"}' },
      { timestamp: T(1), level: 'info', message: 'agent_controller.triggered {"agentType":"coder","autonomyMode":"ask","modelId":"claude-sonnet"}' },
      { timestamp: T(2), level: 'info', message: 'approval.requested {"capability":"shell.write","toolCallId":"tc_9"}' },
      { timestamp: T(7), level: 'info', message: 'approval.resolved {"allowed":false,"answer":"deny"}' },
    ]);
    const r = collectKiro(s.db);
    assert.equal(r.filesScanned, 1);
    assert.equal(r.events.length, 0, 'kiro.log carries no token data — no usage row can exist');

    const calls = r.toolCalls!;
    assert.equal(calls.length, 3);
    const [allow, ask, verdict] = calls;
    assert.equal(allow!.tool_call_key, `kiro:${join(s.home, '.kiro', 'logs', '20260101T000000111')}:0`);
    assert.equal(allow!.name, 'coder');
    assert.equal(allow!.authority, 'pre_authorised', 'the vendor verdict allow = ungated');
    assert.equal(ask!.authority, null, 'ask has no verdict until the human answers');

    assert.equal(verdict!.status, 'denied');
    assert.equal(verdict!.authority, 'denied');
    assert.equal(verdict!.duration_ms, 5000, 'how long the human took: 7s - 2s');
    assert.equal(verdict!.duration_kind, 'turn_scoped');

    // Idempotent re-read of the same launch: same keys, no duplicates.
    const again = collectKiro(s.db);
    assert.equal(again.toolCalls!.length, 3);
    assert.deepEqual(
      again.toolCalls!.map((c) => c.tool_call_key).sort(),
      calls.map((c) => c.tool_call_key).sort(),
    );
  } finally {
    s.done();
  }
});

test('kiro: a pruned launch directory is an evidence gap, counted not skipped', () => {
  const s = makeStore('kiro2');
  try {
    mkdirSync(join(s.home, '.kiro', 'logs', '20260101T000000222'), { recursive: true }); // no kiro.log
    kiroHome(s.home, '20260101T000000333', [
      { timestamp: T(0), level: 'info', message: 'agent_controller.triggered {"agentType":"coder","autonomyMode":"allow"}' },
    ]);
    const r = collectKiro(s.db);
    assert.equal(r.filesScanned, 1);
    assert.ok(r.notes.some((n) => n.includes('evidence gap')), 'the missing launch is named');
  } finally {
    s.done();
  }
});
