import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache } from '../db';
import { Database } from '../sqlite';
import {
  recordTermsBasis,
  planTokenFromClaudeJson,
  planTokenFromCodexLine,
  planTokenFromGrokLine,
  planTokenFromOpencodeAccount,
  loadTermsOverrides,
  dpaScopeMismatches,
} from './basis';
import {
  loadProcessingTermsPack,
  termsAsOf,
  vendorRetentionClock,
  recordProcessingTerms,
  processingTermsRowsFor,
  EMPTY_TERMS_PACK,
} from './as-of';
import {
  resolveRecipient,
  readCcrRoutes,
  recordRecipientState,
  rankResidencyChain,
  recordResidencyEvidence,
} from './recipient';

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'vole-terms-'));
  const db = openDb(join(dir, 't.db'));
  return { db, dir };
}


import type { TermsPackEntry, ProcessingTermsPack } from './as-of';

const entry = (
  over: Partial<TermsPackEntry> & { recipient_id: string },
): TermsPackEntry => ({
  legal_entity: null,
  processing_regions: null,
  trains_on_input: null,
  retention_days: null,
  sub_processor_of: null,
  plan_condition: null,
  contract_scope: null,
  citation_url: null,
  asserted_as_of: null,
  in_force_from: null,
  in_force_to: null,
  ...over,
});

const NOW = Date.parse('2026-09-07T00:00:00Z');

test('terms_basis: the plan token is stored verbatim and a stored source is never overwritten', () => {
  const { db } = store();
  try {
    recordTermsBasis(db, [{ surface_key: 'claude-code', basis: 'enterprise', source: '~/.claude.json oauthAccount.organizationType', now: NOW }]);
    recordTermsBasis(db, [{ surface_key: 'claude-code', basis: 'enterprise', source: 'a later reader', now: NOW + 1000 }]);
    const row = db.prepare('SELECT * FROM terms_basis').get() as Record<string, unknown>;
    assert.equal(row.basis, 'enterprise');
    assert.equal(row.source, '~/.claude.json oauthAccount.organizationType', 'source is a stored fact');
    assert.equal(row.last_seen, NOW + 1000, 'last_seen widens');
    assert.equal((db.prepare('SELECT COUNT(*) c FROM terms_basis').get() as { c: number }).c, 1, 'one row per (surface, basis)');
  } finally {
    resetDbCache();
  }
});

test('plan-token readers: verbatim from the source, NULL when absent, never a tier', () => {
  assert.equal(planTokenFromClaudeJson('{"oauthAccount":{"organizationType":"Max 20x"}}'), 'Max 20x');
  assert.equal(planTokenFromClaudeJson('{"oauthAccount":{}}'), null);
  assert.equal(planTokenFromClaudeJson('not json'), null);
  assert.equal(planTokenFromCodexLine('{"rate_limits":{"plan_type":"chatgpt_pro"}}'), 'chatgpt_pro');
  assert.equal(planTokenFromCodexLine('{"token_count":{"rate_limits":{"plan_type":"legacy"}}}'), 'legacy');
  assert.equal(planTokenFromCodexLine('{"other":1}'), null);
  assert.equal(planTokenFromGrokLine('{"paywall_check_result":{"ctx":{"subscription_tier":"super_grok"}}}'), 'super_grok');
  assert.equal(planTokenFromGrokLine('{}'), null);
  assert.equal(
    planTokenFromOpencodeAccount('{"accounts":[{"serviceID":"github.com/users/x"}]}'),
    'github.com/users/x',
  );
  assert.equal(planTokenFromOpencodeAccount('{"accounts":[]}'), null);
});

test('termsAsOf: the terms in force when the bytes moved, plan-specific over default', () => {
  const pack: ProcessingTermsPack = {
    version: 3,
    entries: [
      entry({ recipient_id: 'anthropic', retention_days: 90, contract_scope: 'consumer' }),
      entry({
        recipient_id: 'anthropic',
        plan_condition: 'enterprise',
        retention_days: 30,
        contract_scope: 'enterprise',
        in_force_from: Date.parse('2026-01-01T00:00:00Z'),
      }),
    ],
    path: null,
  };
  const tOld = Date.parse('2025-06-01T00:00:00Z');
  const tNew = Date.parse('2026-06-01T00:00:00Z');
  assert.equal(termsAsOf(pack, 'anthropic', null, tOld)!.retention_days, 90, 'before the enterprise entry: default');
  assert.equal(termsAsOf(pack, 'anthropic', 'enterprise', tNew)!.retention_days, 30, 'plan condition selects');
  assert.equal(termsAsOf(pack, 'anthropic', null, tNew)!.retention_days, 90, 'no token: default, never inferred');
  assert.equal(
    termsAsOf(pack, 'anthropic', 'enterprise', tOld)!.retention_days,
    90,
    'before the plan-specific entry existed, the then-in-force default applies — not today’s terms',
  );
  const forwardOnly: ProcessingTermsPack = {
    version: 1,
    entries: [entry({ recipient_id: 'x', retention_days: 5, in_force_from: Date.parse('2026-01-01T00:00:00Z') })],
    path: null,
  };
  assert.equal(termsAsOf(forwardOnly, 'x', null, tOld), null, 'nothing in force at that instant → NULL');
  assert.equal(termsAsOf(pack, 'nobody', null, tNew), null);
});

test('vendor retention clock: deletion windows and the stepped chip', () => {
  const pack: ProcessingTermsPack = {
    version: 1,
    entries: [entry({ recipient_id: 'anthropic', retention_days: 30, citation_url: 'https://example.test/terms' })],
    path: null,
  };
  const evidence = Date.parse('2026-08-01T00:00:00Z');
  const now = Date.parse('2026-08-10T00:00:00Z'); // 21 days before the window ends
  const row = vendorRetentionClock([{ evidence_ts: evidence, recipient_id: 'anthropic' }], pack, now)[0]!;
  assert.equal(row.deletion_window_ends_at, evidence + 30 * 86_400_000);
  assert.equal(row.chip, '14d');
  assert.equal(row.basis, 'pack v1 in force 2026-08-01–open, retention 30d, cited https://example.test/terms');
  const clocks = vendorRetentionClock(
    [
      { evidence_ts: evidence, recipient_id: 'anthropic' }, // 24d left → 14d
      { evidence_ts: now - 10 * 86_400_000, recipient_id: 'anthropic' }, // 20d left → 14d
      { evidence_ts: now - 23 * 86_400_000, recipient_id: 'anthropic' }, // 7d left → 7d
      { evidence_ts: now - 29.5 * 86_400_000, recipient_id: 'anthropic' }, // 30h left → 48h
      { evidence_ts: now - 40 * 86_400_000, recipient_id: 'anthropic' }, // past → elapsed
      { evidence_ts: evidence, recipient_id: 'unmapped' }, // no entry → uncomputable
    ],
    pack,
    now,
  ).map((r) => r.chip);
  assert.deepEqual(clocks, ['14d', '14d', '7d', '48h', 'elapsed', 'uncomputable']);
});

test('processing_terms projection: one row per kind, NULL-only widening', () => {
  const { db } = store();
  try {
    const entry = {
      recipient_id: 'anthropic',
      legal_entity: 'Anthropic PBC',
      processing_regions: ['us-east-1', 'eu-west-1'],
      trains_on_input: false,
      retention_days: 30,
      sub_processor_of: null,
      plan_condition: null,
      contract_scope: 'consumer',
      citation_url: null,
      asserted_as_of: '2026-08-01',
      in_force_from: null,
      in_force_to: null,
    };
    let rows = processingTermsRowsFor('claude-code', entry, NOW);
    recordProcessingTerms(db, rows);
    recordProcessingTerms(db, rows); // idempotent
    const all = db.prepare('SELECT * FROM processing_terms').all() as Array<Record<string, unknown>>;
    assert.equal(all.length, 6, '5 scalar kinds + 1 comma-joined region row');
    const region = all.find((r) => r.kind === 'processing_region')!;
    assert.equal(region.value, 'us-east-1,eu-west-1');
    // A later resolution may not overwrite a stored value.
    rows = processingTermsRowsFor('claude-code', { ...entry, retention_days: 7 }, NOW + 1);
    recordProcessingTerms(db, rows);
    const retention = db.prepare("SELECT value FROM processing_terms WHERE kind = 'retention_days'").get() as { value: unknown };
    assert.equal(retention.value, '30', 'stored fact wins over a re-derived one');
  } finally {
    resetDbCache();
  }
});

test('recipient resolution: the model name is a route, not a recipient', () => {
  const broker = resolveRecipient('github-copilot/claude-opus-4.6');
  assert.equal(broker.state, 'broker_truncated');
  assert.equal(broker.recipient_id, 'github');
  assert.match(broker.chain[1]!.evidence_ref, /chain truncated at hop 1/);

  const rerouted = resolveRecipient('anthropic/claude-ccr-h7177656e2f7177656e332e382d3237622d667038', [
    { alias: 'anthropic/claude-ccr-h7177656e2f7177656e332e382d3237622d667038', target_model: null, api_base: 'http://195.242.30.141:30000/v1' },
  ]);
  assert.equal(rerouted.state, 'rerouted');
  assert.equal(rerouted.recipient_id, '195.242.30.141:30000');
  assert.match(rerouted.chain[0]!.evidence_ref, /qwen/);

  const first = resolveRecipient('claude-opus-4.6');
  assert.equal(first.state, 'first_party');
  assert.equal(first.recipient_id, 'anthropic');

  const none = resolveRecipient('mystery-model-x');
  assert.equal(none.state, 'unattributable', 'no vendor is named from a model string');
  assert.equal(resolveRecipient(null).state, 'unattributable');
});

test('recipient_state: idempotent, evidence widens only from NULL', () => {
  const { db } = store();
  try {
    recordRecipientState(db, [{ surface_key: 'opencode', state: 'broker_truncated', evidence_ref: 'model string', now: NOW }]);
    recordRecipientState(db, [{ surface_key: 'opencode', state: 'broker_truncated', evidence_ref: 'later evidence', now: NOW }]);
    const row = db.prepare('SELECT * FROM recipient_state').get() as Record<string, unknown>;
    assert.equal(row.evidence_ref, 'model string');
    assert.equal((db.prepare('SELECT COUNT(*) c FROM recipient_state').get() as { c: number }).c, 1);
  } finally {
    resetDbCache();
  }
});

test('ccr config.sqlite: base URLs only, absent file yields no routes', () => {
  const { dir } = store();
  try {
    assert.deepEqual(readCcrRoutes(join(dir, 'missing.sqlite')), [], 'absent file: absence, not invention');
    const ccrPath = join(dir, 'config.sqlite');
    const ccr = new Database(ccrPath);
    ccr.exec('CREATE TABLE app_config (value_json TEXT)');
    ccr.prepare('INSERT INTO app_config VALUES (?)').run(
      JSON.stringify({ Providers: [{ name: 'qwen', api_base: 'http://195.242.30.141:30000/v1', api_key: 'sk-secret' }] }),
    );
    ccr.close();
    const routes = readCcrRoutes(ccrPath);
    assert.equal(routes.length, 1);
    assert.equal(routes[0]!.api_base, 'http://195.242.30.141:30000/v1');
    assert.equal(JSON.stringify(routes).includes('sk-secret'), false, 'never the key value');
  } finally {
    resetDbCache();
  }
});

test('residency chain: honestly empty at rank 1, evidence named per rank', () => {
  const empty = rankResidencyChain({ inference_geo: 'not_available', model: 'claude-opus-4.6' });
  assert.equal(empty.length, 1);
  assert.equal(empty[0]!.rank, 4, 'not_available does not become a guess');
  assert.match(empty[0]!.source, /inference_geo=not_available/);

  const full = rankResidencyChain({
    inference_geo: 'us-east-1',
    model: 'us.anthropic.claude-sonnet-5',
    pack_regions: ['us-east-1'],
  });
  assert.deepEqual(full.map((r) => r.rank), [1, 2, 3]);
  assert.match(full[1]!.evidence, /Bedrock/);

  const packOnly = rankResidencyChain({ model: 'claude-opus-4.6', pack_regions: ['eu-west-1'] });
  assert.deepEqual(packOnly.map((r) => r.rank), [3]);
  assert.match(packOnly[0]!.source, /processing_terms/);
});

test('residency_evidence: rank is set once, never re-derived', () => {
  const { db } = store();
  try {
    const chain = rankResidencyChain({ inference_geo: 'us-east-1' });
    recordResidencyEvidence(db, [{ surface_key: 'claude-code', chain, now: NOW }]);
    // A later pass with a different chain for the same evidence row changes nothing.
    recordResidencyEvidence(db, [{ surface_key: 'claude-code', chain: rankResidencyChain({ inference_geo: 'eu-west-1' }), now: NOW + 1 }]);
    const rows = db.prepare('SELECT * FROM residency_evidence').all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2, 'one row per evidence value');
    const us = rows.find((r) => String(r.evidence).includes('us-east-1'))!;
    assert.equal(us.rank, 1);
  } finally {
    resetDbCache();
  }
});

test('terms pack loader: highest version across dirs, malformed ignored, empty floor', () => {
  const { dir } = store();
  try {
    const d1 = join(dir, 'packs1');
    const d2 = join(dir, 'packs2');
    mkdirSync(d1);
    mkdirSync(d2);
    writeFileSync(join(d1, 'processing_terms.4.json'), 'not json at all');
    writeFileSync(
      join(d1, 'processing_terms.2.json'),
      JSON.stringify([{ recipient_id: 'x', retention_days: 1 }]),
    );
    writeFileSync(
      join(d2, 'processing_terms.3.json'),
      JSON.stringify([{ recipient_id: 'y', retention_days: 2 }]),
    );
    const pack = loadProcessingTermsPack([d1, d2]);
    assert.equal(pack.version, 3);
    assert.equal(pack.entries[0]!.recipient_id, 'y');
    assert.deepEqual(loadProcessingTermsPack([join(dir, 'nope')]), EMPTY_TERMS_PACK);
  } finally {
    resetDbCache();
  }
});

test('declared_dpa_scope_mismatch: declared vs measured as adjacent figures', () => {
  const pack: ProcessingTermsPack = {
    version: 1,
    entries: [entry({ recipient_id: 'anthropic', plan_condition: 'Max 20x', contract_scope: 'consumer' })],
    path: null,
  };
  const overrides = [
    { vendor: 'anthropic', contract_scope: 'enterprise', asserted_by: 'admin@corp', asserted_at: NOW },
  ];
  const measured = [
    { surface_key: 'claude-code', vendor: 'anthropic', plan_token: 'Max 20x' },
    { surface_key: 'codex', vendor: 'openai', plan_token: 'chatgpt_pro' },
  ];
  const mismatches = dpaScopeMismatches(overrides, measured, pack.entries);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.surface_key, 'claude-code');
  assert.equal(mismatches[0]!.declared_scope, 'enterprise');
  assert.equal(mismatches[0]!.measured_scope, 'consumer');
  assert.match(mismatches[0]!.byline, /admin-authored by admin@corp on 2026-09-07/);
});

test('terms overrides load from the per-user policy path', () => {
  const { dir } = store();
  try {
    const f = join(dir, 'terms_overrides.json');
    writeFileSync(f, JSON.stringify({ overrides: [{ vendor: 'anthropic', contract_scope: 'enterprise', asserted_by: 'a', asserted_at: 1 }] }));
    const loaded = loadTermsOverrides([f]);
    assert.equal(loaded!.overrides.length, 1);
    assert.equal(loadTermsOverrides([join(dir, 'nope.json')]), null);
  } finally {
    resetDbCache();
  }
});
