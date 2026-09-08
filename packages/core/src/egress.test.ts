import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache } from './db';
import { egress, recentNetworkCalls, egressInventory, noEgress } from './egress';

/**
 * The egress choke point: every network-adjacent call must route through it,
 * the switch must win, and every attempt — allowed, dry-run or denied — must
 * land in the network_calls ledger.
 */

let dir: string;
let store: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vole-egress-'));
  store = join(dir, 't.db');
  for (const k of ['VOLE_DB', 'VOLE_NO_EGRESS', 'VOLE_RECONCILE']) {
    saved[k] = process.env[k];
  }
  process.env.VOLE_DB = store;
  delete process.env.VOLE_NO_EGRESS;
  delete process.env.VOLE_RECONCILE;
});

afterEach(() => {
  resetDbCache();
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test('VOLE_NO_EGRESS blocks and still records the attempt', () => {
  process.env.VOLE_NO_EGRESS = '1';
  assert.equal(noEgress(), true);
  const d = egress({ caller: 'test', destination: 'api.github.com/x', purpose: 'check' });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'no_egress');
  assert.equal(d.dryRun, false);
  assert.equal(d.recorded, true);
  const db = openDb(store);
  const rows = recentNetworkCalls(db, 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.caller, 'test');
  assert.match(rows[0]!.purpose!, /\[no_egress\]$/);
});

test('an enabler-gated adapter is dry-run offline unless explicitly enabled', () => {
  const dry = egress({ caller: 'reconcile:cli', destination: 'vendor.example', purpose: 'pull', enabler: 'VOLE_RECONCILE' });
  assert.equal(dry.allowed, false);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.reason, 'not_enabled');
  const db = openDb(store);
  assert.equal(recentNetworkCalls(db, 10).length, 1);

  process.env.VOLE_RECONCILE = '1';
  const live = egress({ caller: 'reconcile:cli', destination: 'vendor.example', purpose: 'pull', enabler: 'VOLE_RECONCILE' });
  assert.equal(live.allowed, true);
  assert.equal(live.reason, 'allowed');
  assert.equal(live.dryRun, false);
  const rows = recentNetworkCalls(db, 10);
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.purpose!, /\[allowed\]$/);
});

test('the switch is read at call time, not module load', () => {
  assert.equal(noEgress(), false);
  const a = egress({ caller: 'c', destination: 'h', purpose: 'p' });
  assert.equal(a.allowed, true);
  process.env.VOLE_NO_EGRESS = '1';
  const b = egress({ caller: 'c', destination: 'h', purpose: 'p' });
  assert.equal(b.allowed, false);
  assert.equal(b.reason, 'no_egress');
});

test('the declared inventory names every network-adjacent call site', () => {
  const inv = egressInventory();
  assert.equal(inv.length, 2);
  assert.ok(inv.some((i) => i.destination.startsWith('api.github.com')));
  assert.ok(inv.every((i) => i.purpose.length > 0));
  // the opt-in adapter must be enabler-gated, never always-on
  const reconcile = inv.find((i) => i.caller === 'reconcile:cli')!;
  assert.equal(reconcile.enabler, 'VOLE_RECONCILE');
});
