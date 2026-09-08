import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache } from '../db';
import { paths } from '../paths';
import {
  collectContextImports, sourceToolOf, parseImportReceipts,
} from './imports';
import {
  extractVarNames, collectKeyResidency, collectResidencyEvidence, regionOfHost,
  collectAnswerableFrom, computeHorizons, claudeRetentionDays,
} from './residency';
import { collectTermsChain, loadTermsPack } from './terms';

/**
 * The chain modules: context_imports receipts, key_residency manifests, the
 * answerable_from horizon, and the terms/residency hops — every badge traceable
 * to the evidence that produced it.
 */

const NOW = Date.parse('2026-09-07T12:00:00Z');
let home: string;

function freshDb() {
  resetDbCache();
  return openDb(join(mkdtempSync(join(tmpdir(), 'vole-ch-')), 'vole.db'));
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'vole-ch-home-'));
  process.env.VOLE_HOME_OVERRIDE = home;
});

after(() => {
  delete process.env.VOLE_HOME_OVERRIDE;
  resetDbCache();
});

// ── context_imports ────────────────────────────────────────────────────────

test('source tool is named by the path convention, not the content', () => {
  assert.equal(sourceToolOf('/Users/x/.claude/projects/p/s.jsonl'), 'claude_code');
  assert.equal(sourceToolOf('/Users/x/.grok/logs/x.jsonl'), 'grok');
  assert.equal(sourceToolOf('/Users/x/somewhere/else.txt'), 'unknown');
});

test('receipt parsing tolerates array and envelope shapes', () => {
  const r = parseImportReceipts(JSON.stringify({
    records: [{ source_path: '/a', content_sha256: 'h1', imported_thread_id: 't', imported_at: '2026-08-01T00:00:00Z' }],
  }));
  assert.equal(r.length, 1);
  assert.equal(r[0]!.imported_at, Date.parse('2026-08-01T00:00:00Z'));
  assert.equal(parseImportReceipts('not json').length, 0);
});

test('context_imports: a receipt that outlives the file, firing the rule once', () => {
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'external_agent_session_imports.json'), JSON.stringify({
    records: [
      { source_path: join(home, '.claude/projects/p/s.jsonl'), content_sha256: 'deadbeef', imported_thread_id: 'th-1', imported_at: '2026-08-01T10:00:00Z' },
    ],
  }));

  const db = freshDb();
  const first = collectContextImports(db, NOW);
  assert.equal(first.newRows, 1);
  assert.equal(first.anomalies, 1);

  const row = db.prepare('SELECT * FROM context_imports WHERE event_key = ?')
    .get('codex:import:deadbeef') as Record<string, unknown>;
  assert.equal(row.source_tool, 'claude_code');
  assert.equal(row.dest_tool, 'codex');
  assert.equal(row.dest_thread_id, 'th-1');
  assert.equal(row.source_present, 0, 'the source file is gone: 0, and bytes NULL');
  assert.equal(row.source_bytes, null);
  assert.ok(typeof row.source_path_hmac === 'string' && (row.source_path_hmac as string).startsWith('ph:'));
  assert.ok(!JSON.stringify(row).includes('s.jsonl'), 'the source FILE name is never stored, only its HMAC');

  const anom = db.prepare('SELECT rule, severity FROM anomalies WHERE anomaly_key = ?')
    .get('cross_vendor_context_import:codex:import:deadbeef') as { rule: string; severity: string };
  assert.equal(anom.rule, 'cross_vendor_context_import');
  assert.equal(anom.severity, 'warn');

  // Idempotent: the same receipt never re-fires.
  const second = collectContextImports(db, NOW + 5000);
  assert.equal(second.newRows, 0);
  assert.equal(second.anomalies, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM context_imports').get() as { n: number }).n, 1);
});

// ── key_residency ──────────────────────────────────────────────────────────

test('var-name extraction: workflows secrets, docker env, terraform variables', () => {
  const wf = extractVarNames(
    'jobs:\n  deploy:\n    steps:\n      - run: echo ${{ secrets.OPENAI_API_KEY }}\n', 'ci');
  assert.ok(wf.includes('OPENAI_API_KEY'));

  const envBlock = extractVarNames(
    'services:\n  api:\n    environment:\n      - ANTHROPIC_API_KEY=sk\n      DEBUG=1\n', 'container');
  assert.ok(envBlock.includes('ANTHROPIC_API_KEY'));

  assert.ok(extractVarNames('ENV GITHUB_TOKEN\nARG BUILD_ID\n', 'container').includes('GITHUB_TOKEN'));
  assert.ok(extractVarNames('variable "aws_secret" {\n  type = string\n}\n', 'iac').includes('aws_secret'));
  assert.ok(extractVarNames('STRIPE_KEY = "x"\n', 'iac').includes('STRIPE_KEY'));
});

test('key_residency: manifests under consented roots, exclusions never opened', () => {
  const repo = mkdtempSync(join(tmpdir(), 'vole-kr-'));
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(repo, '.github', 'workflows', 'deploy.yml'),
    'jobs:\n  d:\n    steps:\n      - run: echo ${{ secrets.OPENAI_API_KEY }}\n');
  writeFileSync(join(repo, 'Dockerfile'), 'FROM alpine\nENV GITHUB_TOKEN\n');
  writeFileSync(join(repo, 'main.tf'), 'variable "aws_secret" {}\n');

  const excluded = mkdtempSync(join(tmpdir(), 'vole-kr-x-'));
  mkdirSync(join(excluded, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(excluded, '.github', 'workflows', 'private.yml'), 'run: echo ${{ secrets.PERSONAL_KEY }}');
  mkdirSync(join(home, '.vole', 'policy'), { recursive: true });
  writeFileSync(join(home, '.vole', 'policy', 'exclude.json'), JSON.stringify({ exclude: [excluded] }));

  const db = freshDb();
  const res = collectKeyResidency(db, [repo, excluded], NOW);
  assert.ok(res.rows >= 3);
  const classes = (db.prepare('SELECT manifest_path, var_name, target_class FROM key_residency').all() as
    { manifest_path: string; var_name: string; target_class: string }[]);
  assert.ok(classes.some((c) => c.var_name === 'OPENAI_API_KEY' && c.target_class === 'ci'));
  assert.ok(classes.some((c) => c.var_name === 'GITHUB_TOKEN' && c.target_class === 'container'));
  assert.ok(classes.some((c) => c.var_name === 'aws_secret' && c.target_class === 'iac'));
  assert.ok(!classes.some((c) => c.var_name === 'PERSONAL_KEY'), 'an excluded root is never opened');
  assert.ok(res.notes.some((n) => n.includes('excluded by policy')));
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM key_residency WHERE repo = ?').get(excluded) as { n: number }).n, 0);
});

// ── answerable_from ────────────────────────────────────────────────────────

test('retention is read, never assumed; the horizon is the oldest surviving evidence', () => {
  // No settings.json: the documented default must be stated as such.
  const r = claudeRetentionDays();
  assert.equal(r.days, 30);
  assert.ok(r.basis.includes('vendor-documented'), r.basis);
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 90 }));
  assert.equal(claudeRetentionDays().days, 90);

  const sessDir = join(home, '.claude', 'projects', 'p1');
  mkdirSync(sessDir, { recursive: true });
  const f1 = join(sessDir, 'a.jsonl');
  const f2 = join(sessDir, 'b.jsonl');
  writeFileSync(f1, '{}\n');
  writeFileSync(f2, '{}\n');
  const old = NOW - 23 * 24 * 3600_000;
  utimesSync(f1, new Date(old), new Date(old));
  utimesSync(f2, new Date(NOW), new Date(NOW));

  const rows = computeHorizons().filter((h) => h.source === 'claude_transcripts');
  assert.equal(rows.length, 2, 'both indicator kinds for the transcript source');
  for (const h of rows) {
    assert.equal(h.horizon_ts, old, 'earliest retained mtime is the bound');
    assert.ok(h.basis.includes('cleanupPeriodDays=90'), 'the basis names the setting that produced it');
    assert.ok(h.basis.includes('2 files'));
  }
  assert.ok(computeHorizons().some((h) => h.source === 'codex_rollouts' && h.horizon_ts === null));

  const db = freshDb();
  const n = collectAnswerableFrom(db, NOW);
  assert.ok(n >= 8, 'every source × indicator_kind pair is persisted');
  const stored = db.prepare('SELECT * FROM answerable_from WHERE source = ? AND indicator_kind = ?')
    .get('claude_transcripts', 'secret_sightings') as { horizon_ts: number; basis: string };
  assert.equal(stored.horizon_ts, old);
  // A re-run widens the basis, never rewrites first_seen.
  collectAnswerableFrom(db, NOW + 9999);
  const again = db.prepare('SELECT first_seen, last_seen FROM answerable_from WHERE source = ? AND indicator_kind = ?')
    .get('claude_transcripts', 'secret_sightings') as { first_seen: number; last_seen: number };
  assert.equal(again.first_seen, NOW);
  assert.equal(again.last_seen, NOW + 9999);
});

// ── the where-it-landed chain: terms and residency hops ────────────────────

test('region tokens come off the route host, and only off the host', () => {
  assert.equal(regionOfHost('eu-central.gateway.internal'), 'eu');
  assert.equal(regionOfHost('api.openai.com'), null, 'no token: no region, ever');
});

test('the chain: route-declared beats pack-asserted beats an explicit unknown', () => {
  const cfg = join(home, 'litellm.yaml');
  writeFileSync(cfg, 'model_name: gpt\n');
  const db = freshDb();
  db.prepare(`INSERT INTO ai_surfaces (surface_key, kind, name, path, vendor, first_seen, last_seen)
    VALUES (?, 'gateway', 'gw', ?, 'anthropic', ?, ?)`).run('gateway:litellm', cfg, NOW, NOW);
  db.prepare(`INSERT INTO ai_surfaces (surface_key, kind, name, path, vendor, first_seen, last_seen)
    VALUES (?, 'cli', 'gemini', NULL, 'google', ?, ?)`).run('cli:gemini', NOW, NOW);
  db.prepare(`INSERT INTO model_routes (route_key, alias, target_model, api_base, source, first_seen, last_seen)
    VALUES (?, 'gpt', 'gpt-4', ?, ?, ?, ?)`).run('r1', 'https://eu-central.gateway.internal/v1', cfg, NOW, NOW);
  db.prepare(`INSERT INTO vendor_identities (vendor, local_key_kind, local_key, plan, first_seen, last_seen)
    VALUES ('anthropic', 'oauth', 'k', 'Max 5x', ?, ?)`).run(NOW, NOW);

  // An admin terms pack: processing terms as-of, a plan, a region for gemini.
  mkdirSync(join(home, '.vole', 'packs'), { recursive: true });
  writeFileSync(join(home, '.vole', 'packs', 'terms.json'), JSON.stringify({
    version: 3,
    as_of: 1750000000000,
    entries: [
      { surface_key: 'cli:gemini', kind: 'processing_terms', value: 'training opt-out honored per workspace setting' },
      { surface_key: 'cli:gemini', kind: 'region', value: 'us' },
      { surface_key: 'gateway:litellm', kind: 'processing_terms', value: 'business terms apply' },
      { surface_key: 'nonsense-surface', kind: 'plan', value: 'ghost' },
    ],
  }));
  assert.ok(loadTermsPack()!.entries.length === 4);

  const terms = collectTermsChain(db, NOW);
  const basis = db.prepare('SELECT basis, source FROM terms_basis WHERE surface_key = ?')
    .get('gateway:litellm') as { basis: string; source: string };
  assert.equal(basis.basis, 'Max 5x', 'the plan comes from the vendor account record');
  assert.ok(basis.source.startsWith('vendor_identities'));

  const pt = db.prepare('SELECT value, as_of FROM processing_terms WHERE surface_key = ? AND kind = ?')
    .get('cli:gemini', 'processing_terms') as { value: string; as_of: number };
  assert.equal(pt.value, 'training opt-out honored per workspace setting');
  assert.equal(pt.as_of, 1750000000000, 'the as-of lookup travels with the register row');
  assert.ok(terms.notes.some((n) => n.includes('1 naming unknown surfaces')), 'pack entries naming unknown surfaces are counted, not dropped silently');

  const res = collectResidencyEvidence(db, NOW);
  assert.ok(res.evidence >= 2, 'route-declared and pack-asserted evidence rows');
  const ev = db.prepare('SELECT rank, evidence, source FROM residency_evidence WHERE surface_key = ?')
    .get('gateway:litellm') as { rank: number; evidence: string; source: string };
  assert.equal(ev.rank, 2, 'route-declared outranks pack-asserted');
  assert.ok(ev.source.startsWith('model_routes:'));
  const st = db.prepare('SELECT state, evidence_ref FROM recipient_state WHERE surface_key = ?')
    .get('gateway:litellm') as { state: string; evidence_ref: string };
  assert.equal(st.state, 'eu');
  assert.equal(st.evidence_ref, 'eu-central.gateway.internal');

  // The pack region lands at rank 3 for the surface with no route.
  const ev2 = db.prepare('SELECT rank FROM residency_evidence WHERE surface_key = ?')
    .get('cli:gemini') as { rank: number };
  assert.equal(ev2.rank, 3);
  assert.equal((db.prepare("SELECT state FROM recipient_state WHERE surface_key = 'cli:gemini'").get() as { state: string }).state, 'us');
});
