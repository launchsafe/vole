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
