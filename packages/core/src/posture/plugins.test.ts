import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vole-plugins-'));
  process.env.VOLE_DB = join(tmp, 'vole.db');
});

test('capability tier: hooks/mcp/lsp declarations are high, skills-only low, no catalog entry stays not_in_catalog', async () => {
  const { capabilityTier } = await import('./plugins');
  assert.equal(capabilityTier({ skills: 4, commands: 2 }), 'low');
  assert.equal(capabilityTier({ skills: 1, hooks: 2 }), 'high');
  assert.equal(capabilityTier({ mcpServers: 1 }), 'high');
  assert.equal(capabilityTier({ lspServers: 3 }), 'high');
  assert.equal(capabilityTier(null), 'not_in_catalog');
});

test('context tax: counted, never estimated — NULL for models the catalog does not list', async () => {
  const { parseCatalog, contextTax } = await import('./plugins');
  const catalog = parseCatalog({
    fetchedAt: '2026-08-29T07:17:37Z',
    catalog: {
      marketplace_sha: '0620a687abc',
      models: ['claude-opus-4-7', 'claude-sonnet-4-6'],
      plugins: [
        {
          name: 'ponytail',
          tokens: { 'claude-opus-4-7': { always_on: 120, on_invoke: 40 }, 'claude-sonnet-4-6': { always_on: 100 } },
          components: { skills: 4 }, unique_installs: 9000,
        },
      ],
    },
  });
  assert.equal(catalog.marketplace_sha, '0620a687abc');
  assert.equal(catalog.plugins.length, 1);
  const sessions = new Map([['claude-opus-4-7', 300], ['some-other-model', 50]]);
  const tax = contextTax(catalog, sessions);
  const opus = tax.find((t) => t.model === 'claude-opus-4-7')!;
  assert.equal(opus.always_on, 120);
  assert.equal(opus.tax, 120 * 300); // the vendor's own figure times the store's own session count
  const other = tax.find((t) => t.model === 'some-other-model')!;
  assert.equal(other.tax, null); // never a substituted figure
  const sonnet = tax.find((t) => t.model === 'claude-sonnet-4-6')!;
  assert.equal(sonnet.tax, null); // no sessions on it: NULL, not zero
});

test('reconciliation: ghost (enabled, never installed) vs orphan (installed, never used)', async () => {
  const { reconcilePlugins } = await import('./plugins');
  const rows = reconcilePlugins(
    [{ key: 'ponytail@ponytail', version: '1.0', installPath: '/p' }],
    { 'ghost@inline': true, 'ponytail@ponytail': true },
    {
      'ponytail@ponytail': { usageCount: 3455, lastUsedAt: 1 },
      'caveman@inline': { usageCount: 2406, lastUsedAt: 2 },
      'rust-analyzer-lsp@claude-plugins-official': { usageCount: 0 },
    },
  );
  assert.equal(rows.find((r) => r.key === 'ponytail@ponytail')!.classification, 'in_use');
  assert.equal(rows.find((r) => r.key === 'ghost@inline')!.classification, 'ghost');
  assert.equal(rows.find((r) => r.key === 'caveman@inline')!.classification, 'unknown'); // used, never installed, never enabled — the vendor's own counters
  assert.equal(rows.find((r) => r.key === 'rust-analyzer-lsp@claude-plugins-official')!.classification, 'unknown'); // never installed, never enabled, zero use
  const orphan = reconcilePlugins(
    [{ key: 'x@y', version: null, installPath: '/p' }],
    {},
    {},
  );
  assert.equal(orphan[0]!.classification, 'orphan');
  const disabled = reconcilePlugins([{ key: 'x@y', version: null, installPath: '/p' }], { 'x@y': false }, { 'x@y': { usageCount: 9 } });
  assert.equal(disabled[0]!.classification, 'in_use');
});

test('parseCatalog: the REAL plugin-catalog-cache.json shape — catalog.plugins is an OBJECT keyed name@marketplace', async () => {
  const { parseCatalog, capabilityTier, contextTax } = await import('./plugins');
  const catalog = parseCatalog({
    version: 1,
    fetchedAt: '2026-08-29T07:17:37.379Z',
    catalog: {
      generated_at: '2026-08-29T07:17:37Z',
      marketplace_sha: '0620a687abc',
      models: ['claude-opus-4-7', 'claude-sonnet-4-6'],
      plugins: {
        'adobe-for-creativity@claude-plugins-official': {
          plugin: 'adobe-for-creativity',
          tokens: { 'claude-opus-4-7': { always_on: 2119, on_invoke: 62816 } },
          components: {
            commands: [], agents: [], skills: [{ name: 'adobe', chars: { always_on: 521, on_invoke: 8272 } }],
            hooks: [{ name: 'on-session-start', chars: { always_on: 47, on_invoke: 47 } }],
          },
          unique_installs: 4282,
        },
        'agent-sdk-dev@claude-plugins-official': {
          plugin: 'agent-sdk-dev',
          tokens: { 'claude-opus-4-7': { always_on: 238, on_invoke: 6203 } },
          components: { commands: [{ name: 'new-sdk-app' }], agents: [] },
          unique_installs: 12000,
        },
      },
    },
  });
  assert.equal(catalog.marketplace_sha, '0620a687abc');
  assert.equal(catalog.fetched_at, '2026-08-29T07:17:37.379Z');
  assert.deepEqual(catalog.models, ['claude-opus-4-7', 'claude-sonnet-4-6']);
  assert.equal(catalog.plugins.length, 2); // no crash: .filter never sees the raw object
  const adobe = catalog.plugins.find((p) => p.name === 'adobe-for-creativity@claude-plugins-official')!;
  assert.ok(adobe, 'the name@marketplace KEY is preserved as the name');
  assert.equal(adobe.unique_installs, 4282);
  assert.equal(adobe.tokens['claude-opus-4-7']!.always_on, 2119);
  // component arrays count by length: a hooks[] entry means high tier
  assert.equal(capabilityTier(adobe.components), 'high');
  const sdk = catalog.plugins.find((p) => p.name === 'agent-sdk-dev@claude-plugins-official')!;
  assert.equal(capabilityTier(sdk.components), 'low');
  // the counted context tax still works off the object form
  const tax = contextTax(catalog, new Map([['claude-opus-4-7', 3]]));
  const adobeOpus = tax.find((t) => t.plugin === 'adobe-for-creativity@claude-plugins-official' && t.model === 'claude-opus-4-7')!;
  assert.equal(adobeOpus.tax, 2119 * 3);
  assert.equal(tax.find((t) => t.plugin === 'agent-sdk-dev@claude-plugins-official' && t.model === 'claude-sonnet-4-6')!.tax, null); // NULL, never substituted
});

test('extraMarketplaceNames: string[] and the real-world name -> {source} map both yield names', async () => {
  const { extraMarketplaceNames } = await import('./plugins');
  assert.deepEqual(extraMarketplaceNames(['a', 'b']), ['a', 'b']);
  // the shape the live store actually shipped: an object map, not an array —
  // the old `for (const n of extra ?? [])` threw "(extra ?? []) is not iterable".
  assert.deepEqual(extraMarketplaceNames({ ponytail: { source: { url: 'https://x' } } }), ['ponytail']);
  assert.deepEqual(extraMarketplaceNames('single'), ['single']);
  assert.deepEqual(extraMarketplaceNames(undefined), []);
  assert.deepEqual(extraMarketplaceNames([1, 'a', null]), ['a']); // non-strings dropped, never coerced
});
