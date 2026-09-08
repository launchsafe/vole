import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserAssistants, vscodeStateScanner } from './vscode-state';
import { openDb } from '../db';

// Defect regression: real Chrome Default/Preferences writes glic.last_invoked_time
// as a STRING of internal ticks — new Date(<that>) is an Invalid Date and the
// scanner's toISOString() threw a RangeError, killing the whole pass.

let tmp = '';
let home = '';
const savedEnv: Record<string, string | undefined> = {};

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vole-glic-'));
  home = join(tmp, 'home');
  for (const k of ['VOLE_HOME_OVERRIDE', 'VOLE_DB']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.VOLE_HOME_OVERRIDE = home;
  process.env.VOLE_DB = join(tmp, 'vole.db');
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

test('glic.last_invoked_time: real string-ticks profile never throws; unknown stays unknown; ms-epoch still dates', () => {
  const chromeRoot = join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  for (const profile of ['Default', 'Profile 1']) mkdirSync(join(chromeRoot, profile), { recursive: true });
  writeFileSync(join(chromeRoot, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: {}, 'Profile 1': {} } } }));
  // The real shape: a string of internal ticks ("13431163951056639").
  writeFileSync(join(chromeRoot, 'Default', 'Preferences'), JSON.stringify({
    glic: { last_invoked_time: '13431163951056639' },
    in_product_help: { new_badge: { glic: { used_count: 2 } } },
  }));
  // A plain ms-epoch number still renders a real date.
  writeFileSync(join(chromeRoot, 'Profile 1', 'Preferences'), JSON.stringify({
    glic: { last_invoked_time: 1735689600000 },
  }));

  const b = browserAssistants();
  assert.equal(b.length, 2);
  const def = b.find((x) => x.profile === 'Default')!;
  assert.ok(def, 'Default profile read');
  assert.equal(def.last_invoked_time, '13431163951056639'); // verbatim, never coerced
  assert.equal(def.used_count, 2);

  const result = vscodeStateScanner.run(); // used to throw RangeError on the ticks profile
  assert.equal(result.ok, true);

  const rows = openDb().prepare(
    "SELECT surface_key, evidence, extra FROM ai_surfaces WHERE surface_key LIKE 'browser-assistant:%'",
  ).all() as { surface_key: string; evidence: string; extra: string }[];
  const defRow = rows.find((r) => r.surface_key === 'browser-assistant:chrome:Default')!;
  const p1Row = rows.find((r) => r.surface_key === 'browser-assistant:chrome:Profile 1')!;
  assert.ok(defRow && p1Row, 'both browser-assistant rows upserted');
  // The ticks value is kept verbatim in extra — unknown, never fabricated.
  assert.equal(JSON.parse(defRow.extra).last_invoked_time, '13431163951056639');
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(defRow.evidence), 'no fabricated ISO date');
  assert.ok(defRow.evidence.includes('cannot date'), 'says the format is unreadable instead of inventing one');
  assert.ok(!defRow.evidence.includes('No invocation recorded'), 'does not claim absence when a value IS recorded');
  // The ms-epoch profile still gets its real date.
  assert.ok(p1Row.evidence.includes('Last invoked 2025-01-01T00:00:00.000Z'));
});
