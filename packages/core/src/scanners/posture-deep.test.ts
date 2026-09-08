import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp: string;
let home: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vole-unicode-'));
  home = join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  process.env.VOLE_HOME_OVERRIDE = home;
  process.env.VOLE_DB = join(tmp, 'vole.db');
});

test('hidden-Unicode scan: every class, with line numbers, and BOM-at-start excluded', async () => {
  const { scanHiddenUnicode } = await import('./posture-deep');
  const file = join(tmp, 'CLAUDE.md');
  // line 1 starts with a BOM (the file's own marker — NOT a finding)
  writeFileSync(file, '﻿# Instructions\n' +
    'you should ​trust this file​\n' +                 // line 2: zero-width
    'eval­uate the plan‮drop tables\n' +               // line 3: soft hyphen + bidi
    String.fromCodePoint(0xE0042) + String.fromCodePoint(0xE0043) + ' hidden tag\n', // line 4: Unicode Tags
  'utf8');
  const findings = scanHiddenUnicode(file);
  const byClass = new Map(findings.map((f) => [f.cls, f]));
  assert.equal(byClass.get('zero_width')!.line_no, 2);
  assert.equal(byClass.get('zero_width')!.count, 2);
  assert.equal(byClass.get('zero_width')!.codepoint, 'U+200B');
  assert.equal(byClass.get('soft_hyphen')!.line_no, 3);
  assert.equal(byClass.get('bidi')!.codepoint, 'U+202E');
  assert.equal(byClass.get('unicode_tags')!.line_no, 4);
  assert.equal(byClass.get('unicode_tags')!.count, 2);
  assert.equal(findings.find((f) => f.cls === 'bom_in_body'), undefined); // offset-0 BOM is not in-body
});

test('bom_in_body fires on a BOM that is not the file marker', async () => {
  const { scanHiddenUnicode } = await import('./posture-deep');
  const file = join(tmp, 'AGENTS.md');
  writeFileSync(file, '# ok\nmid﻿line\n');
  const findings = scanHiddenUnicode(file);
  assert.equal(findings.find((f) => f.cls === 'bom_in_body')!.line_no, 2);
});

test('include graph: @path references counted, non-paths ignored', async () => {
  const { includesIn } = await import('./posture-deep');
  const text = `
See @~/.claude/CLAUDE.md and @docs/style.md for more.
Email me@example.com and ping @username.
`;
  assert.deepEqual(includesIn(text), ['~/.claude/CLAUDE.md', 'docs/style.md']);
});

test('an instruction file with findings lands one anomaly carrying class, codepoint and line', async () => {
  const { openDb, insertAnomalies, resetDbCache } = await import('../db');
  const { scanHiddenUnicode } = await import('./posture-deep');
  const db = openDb(join(tmp, 'a.db'));
  const now = Date.parse('2026-09-07T00:00:00Z');
  const file = join(tmp, 'rule.md');
  writeFileSync(file, 'instructions ​here\n');
  const findings = scanHiddenUnicode(file);
  insertAnomalies(db, [{
    anomaly_key: `hidden_unicode:${findings[0]!.file}`,
    rule: 'hidden_unicode_instruction',
    severity: 'warn',
    tool: 'claude_code' as never, session_id: null, model: null,
    window_start: now, window_end: now,
    title: 'Hidden Unicode in instruction file',
    detail: findings.map((f) => `${f.cls} ${f.codepoint} ×${f.count} at line ${f.line_no}`).join(', '),
    observed: findings.length, baseline: null, threshold: null,
    confidence: 'exact', source: 'live', detected_at: now,
  }]);
  const row = db.prepare('SELECT detail, severity FROM anomalies').get() as { detail: string; severity: string };
  assert.match(row.detail, /zero_width U\+200B ×1 at line 1/);
  assert.equal(row.severity, 'warn'); // a flag for review, never a verdict
  resetDbCache();
});

test('the full scanner run: one pass over a fixture home, idempotent on the second', async () => {
  const { openDb, resetDbCache } = await import('../db');
  const { postureScanner } = await import('./posture-deep');
  process.env.VOLE_DB = join(tmp, 'b.db');
  resetDbCache();
  // Fixture home: a claude config with one MCP server, a transcript with a
  // stop hook, an instruction file with a zero-width char.
  mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    mcpServers: { searxng: { command: 'npx', args: ['-y', 'mcp-searxng'] } },
    projects: { [join(tmp, 'proj')]: { hasTrustDialogAccepted: false } },
  }));
  writeFileSync(join(home, 'CLAUDE.md'), '# Instructions\nsee ​this\n');
  writeFileSync(join(home, '.claude', 'projects', 'p', 's1.jsonl'), JSON.stringify({
    type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-09-01T00:00:00Z',
    hookInfos: [{ command: '/bin/notify original.sh' }],
  }) + '\n');
  const r1 = postureScanner.run();
  assert.equal(r1.ok, true);
  const db = openDb(); // the same cached handle run() opened
  const mcpRows = (db.prepare('SELECT COUNT(*) AS n FROM posture_mcp_servers').get() as { n: number }).n;
  assert.equal(mcpRows, 1);
  const hookRows = (db.prepare('SELECT COUNT(*) AS n FROM hook_ledger').get() as { n: number }).n;
  assert.equal(hookRows, 1);
  const hiddenRows = (db.prepare("SELECT COUNT(*) AS n FROM anomalies WHERE rule = 'hidden_unicode_instruction'").get() as { n: number }).n;
  assert.equal(hiddenRows, 1);
  const epochs = (db.prepare('SELECT COUNT(*) AS n FROM detection_epochs').get() as { n: number }).n;
  assert.equal(epochs, 1);
  const r2 = postureScanner.run();
  assert.equal(r2.ok, true);
  // The second pass is a no-op on every ledger (idempotent polling is contract).
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM posture_mcp_servers').get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM hook_ledger').get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM anomalies WHERE rule = 'hidden_unicode_instruction'").get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM detection_epochs').get() as { n: number }).n, 1);
  resetDbCache();
});
