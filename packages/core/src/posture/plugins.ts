import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db';
import { home, readJson, upsertLever, bumpCounter, tryReaddir } from './shared';

/**
 * The plugin plane: the vendor's own marketplace catalog (the always-on context
 * tax priced per model, and the declared-capability tier), provenance with
 * cross-agent blast radius, the install-vs-use reconciliation, and the
 * editor-synced instruction packs that arrive over Settings Sync with no
 * install event at all.
 *
 * The catalog lists token figures only for the models it was generated against
 * (two on the reference machine) — any other model gets NULL, never a
 * substituted figure. Locally installed and inline plugins have no catalog
 * entry and render 'not in catalog', never 'low tier'.
 */

export interface CatalogPlugin {
  name: string; // 'name@marketplace' when the catalog is object-shaped
  tokens: Record<string, { always_on?: number; on_invoke?: number }>; // model -> figures
  // commands/agents/skills/hooks/mcpServers/lspServers -> count, or the real
  // object form's per-item arrays (counted by length, never guessed)
  components: Record<string, number | unknown[]>;
  unique_installs: number | null;
}

export interface PluginCatalog {
  marketplace_sha: string | null;
  fetched_at: string | null;
  models: string[];
  plugins: CatalogPlugin[];
}

export function parseCatalog(json: unknown): PluginCatalog {
  const empty: PluginCatalog = { marketplace_sha: null, fetched_at: null, models: [], plugins: [] };
  if (!json || typeof json !== 'object') return empty;
  const root = json as {
    fetchedAt?: string;
    catalog?: { marketplace_sha?: string; models?: string[]; plugins?: unknown };
  };
  // The real plugin-catalog-cache.json ships catalog.plugins as an OBJECT keyed
  // 'name@marketplace' (values carry a 'plugin' field, not 'name'); an array
  // shape is accepted too. Object entries keep their full key as the name.
  type RawPlugin = {
    name?: string; tokens?: Record<string, { always_on?: number; on_invoke?: number }>;
    components?: Record<string, number | unknown[]>; unique_installs?: number;
  };
  const raw = root.catalog?.plugins;
  const rawPlugins: RawPlugin[] = Array.isArray(raw)
    ? (raw as RawPlugin[])
    : raw && typeof raw === 'object'
      ? Object.entries(raw as Record<string, RawPlugin>).map(([key, v]) => ({ ...v, name: key }))
      : [];
  return {
    marketplace_sha: root.catalog?.marketplace_sha ?? null,
    fetched_at: root.fetchedAt ?? null,
    models: root.catalog?.models ?? [],
    plugins: rawPlugins
      .filter((p) => typeof p.name === 'string')
      .map((p) => ({
        name: p.name!,
        tokens: p.tokens ?? {},
        components: p.components ?? {},
        unique_installs: typeof p.unique_installs === 'number' ? p.unique_installs : null,
      })),
  };
}

export type CapabilityTier = 'high' | 'low' | 'not_in_catalog';

/** Declaring hooks, mcpServers or lspServers means the plugin executes code or
 *  opens a transport — high tier. Skills and commands only is low tier. This is
 *  a DECLARATION in a cached vendor catalog, not an observation of behaviour. */
export function capabilityTier(components: Record<string, number | unknown[]> | null): CapabilityTier {
  if (!components) return 'not_in_catalog';
  // The real catalog lists components as per-item arrays; the count is the
  // length, never a guess at an array's numeric meaning.
  const count = (v: number | unknown[] | undefined): number =>
    Array.isArray(v) ? v.length : typeof v === 'number' ? v : 0;
  const high = ['hooks', 'mcpServers', 'lspServers'].some((k) => count(components[k]) > 0);
  return high ? 'high' : 'low';
}

/**
 * The always-on context tax: exactly always_on tokens × the sessions actually
 * run on that model — a counted figure (the vendor's own catalog numbers times
 * the store's own session counts), not an estimate. NULL per model the catalog
 * does not list; never a substituted figure.
 */
export function contextTax(
  catalog: PluginCatalog,
  sessionsByModel: Map<string, number>,
): { plugin: string; model: string; always_on: number | null; sessions: number | null; tax: number | null }[] {
  const out: { plugin: string; model: string; always_on: number | null; sessions: number | null; tax: number | null }[] = [];
  const models = new Set([...catalog.models, ...sessionsByModel.keys()]);
  for (const p of catalog.plugins) {
    for (const model of models) {
      const alwaysOn = p.tokens[model]?.always_on ?? null;
      const sessions = sessionsByModel.get(model) ?? null;
      out.push({
        plugin: p.name,
        model,
        always_on: alwaysOn,
        sessions,
        tax: alwaysOn !== null && sessions !== null ? alwaysOn * sessions : null,
      });
    }
  }
  return out;
}

// ── Install-vs-use reconciliation (ghost and orphan plugins) ───────────────────

export interface Reconciliation {
  key: string;              // plugin@marketplace
  enabled: boolean | null;   // settings.json enabledPlugins
  installed: boolean;        // installed_plugins.json
  usageCount: number | null; // ~/.claude.json pluginUsage
  lastUsedAt: number | null;
  classification: 'ghost' | 'orphan' | 'in_use' | 'disabled' | 'unknown';
}

/** ghost = enabled but never installed; orphan = installed but enabled nowhere
 *  and (where the vendor counted) never used. */
export function classifyPlugin(enabled: boolean | null, installed: boolean, usageCount: number | null): Reconciliation['classification'] {
  if (enabled === true && !installed) return 'ghost';
  if (installed && enabled !== true && (usageCount === 0 || usageCount === null)) return 'orphan';
  if (installed && enabled === true && usageCount !== null && usageCount > 0) return 'in_use';
  if (installed && enabled !== true && usageCount !== null && usageCount > 0) return 'in_use';
  if (installed && enabled === true) return 'in_use';
  return 'unknown';
}

export function reconcilePlugins(
  installed: { key: string; version: string | null; installPath: string | null }[],
  enabled: Record<string, boolean> | null,
  usage: Record<string, { usageCount?: number; lastUsedAt?: number }> | null,
): Reconciliation[] {
  const keys = new Set<string>([...installed.map((i) => i.key), ...Object.keys(enabled ?? {}), ...Object.keys(usage ?? {})]);
  const out: Reconciliation[] = [];
  for (const key of keys) {
    const inst = installed.find((i) => i.key === key);
    const en = enabled?.[key] ?? null;
    const use = usage?.[key];
    out.push({
      key,
      enabled: en,
      installed: !!inst,
      usageCount: typeof use?.usageCount === 'number' ? use.usageCount : null,
      lastUsedAt: typeof use?.lastUsedAt === 'number' ? use.lastUsedAt : null,
      classification: classifyPlugin(en, !!inst, typeof use?.usageCount === 'number' ? use.usageCount : null),
    });
  }
  return out;
}

// ── The sweep ────────────────────────────────────────────────────────────────

export function sweepPlugins(db: DB, now: number): { plugins: number; reconciled: number; taxRows: number; marketplaces: number } {
  const pluginsDir = join(home(), '.claude', 'plugins');
  const catalog = parseCatalog(readJson(join(pluginsDir, 'plugin-catalog-cache.json')));
  const byName = new Map(catalog.plugins.map((p) => [p.name, p]));
  const upsert = db.prepare(`
    INSERT INTO plugins (plugin_key, agent, name, version, marketplace, installed_at, enabled, source, first_seen, last_seen)
    VALUES (?, 'claude_code', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(plugin_key) DO UPDATE SET
      enabled  = COALESCE(excluded.enabled, plugins.enabled),
      last_seen = excluded.last_seen`);

  // Installed trees + their version/provenance.
  const installedJson = readJson(join(pluginsDir, 'installed_plugins.json')) as Record<string, {
    version?: string; installPath?: string; installedAt?: string;
    gitCommitSha?: string; marketplace?: string;
  }> | undefined;
  const installedKeys: { key: string; version: string | null; installPath: string | null }[] = [];
  let pluginRows = 0;
  for (const [key, meta] of Object.entries(installedJson ?? {})) {
    installedKeys.push({ key, version: meta.version ?? null, installPath: meta.installPath ?? null });
    upsert.run(`plugin:claude_code:${key}`, key, meta.version ?? null,
      meta.marketplace ?? key.split('@')[1] ?? null,
      meta.installedAt ? Date.parse(meta.installedAt) || null : null,
      null, meta.installPath ?? 'installed', now, now);
    pluginRows++;
    // Cross-agent blast radius: the manifests each tree ships DECLARE which
    // agents the package targets — a declaration, never proof of a load.
    for (const t of targetsInTree(meta.installPath)) {
      upsert.run(`plugin:${t.agent}:${key}`, key, meta.version ?? null, meta.marketplace ?? null, null, null, `declared:${t.evidence}`, now, now);
      pluginRows++;
    }
  }

  // Enabled: settings.json enabledPlugins.
  const settings = readJson(join(home(), '.claude', 'settings.json')) as { enabledPlugins?: Record<string, boolean> } | undefined;
  const enabled = settings?.enabledPlugins ?? null;
  for (const [key, on] of Object.entries(enabled ?? {})) {
    upsert.run(`plugin:claude_code:${key}`, key, null, null, null, on ? 1 : 0, 'settings:enabledPlugins', now, now);
    pluginRows++;
  }

  // The vendor's own usage counters — a lifetime total with one timestamp.
  const cj = readJson(join(home(), '.claude.json')) as {
    pluginUsage?: Record<string, { usageCount?: number; lastUsedAt?: number; lastUsedNumStartups?: number }>;
  } | undefined;
  for (const rec of reconcilePlugins(installedKeys, enabled, cj?.pluginUsage ?? null)) {
    bumpCounter(db, `plugin:${rec.key}`, `recon:${rec.classification}`, 1, now);
    if (rec.usageCount !== null) bumpCounter(db, `plugin:${rec.key}`, 'usage_count', rec.usageCount, now);
  }

  // The catalog: capability tiers and the always-on context tax.
  const sessions = new Map<string, number>();
  for (const r of db.prepare(
    "SELECT model, COUNT(DISTINCT session_id) AS n FROM usage_events WHERE source = 'live' AND model IS NOT NULL GROUP BY model",
  ).all() as { model: string; n: number }[]) {
    sessions.set(r.model, r.n);
  }
  let taxRows = 0;
  for (const row of contextTax(catalog, sessions)) {
    const p = byName.get(row.plugin);
    if (!p) continue;
    const tier = capabilityTier(p.components);
    if (row.tax !== null) {
      bumpCounter(db, `plugin:${row.plugin}`, `context_tax:${row.model}`, row.tax, now);
      taxRows++;
    }
    bumpCounter(db, `plugin:${row.plugin}`, `capability_tier:${tier}`, 1, now);
  }

  // Marketplaces: known_marketplaces.json, catalog sha, extraKnownMarketplaces.
  let marketplaces = 0;
  const known = readJson(join(pluginsDir, 'known_marketplaces.json')) as Record<string, {
    source?: { url?: string }; installLocation?: string; lastUpdated?: string; revision?: string;
  }> | undefined;
  for (const [name, m] of Object.entries(known ?? {})) {
    upsertLever(db, 'claude_code', `marketplace:${name}`,
      [m.source?.url ?? null, m.revision ?? null, m.lastUpdated ?? null].filter(Boolean).join(' @ ') || 'known',
      null, join(pluginsDir, 'known_marketplaces.json'), now);
    marketplaces++;
  }
  for (const name of extraMarketplaceNames((readJson(join(home(), '.claude', 'settings.json')) as { extraKnownMarketplaces?: unknown } | undefined)?.extraKnownMarketplaces)) {
    upsertLever(db, 'claude_code', `marketplace:${name}`, 'settings:extraKnownMarketplaces', null, join(home(), '.claude', 'settings.json'), now);
    marketplaces++;
  }
  if (catalog.marketplace_sha) {
    upsertLever(db, 'claude_code', 'marketplace:catalog-cache',
      `${catalog.marketplace_sha.slice(0, 12)} @ ${catalog.fetched_at ?? 'unknown fetch time'}`,
      null, join(pluginsDir, 'plugin-catalog-cache.json'), now);
    marketplaces++;
  }
  return { plugins: pluginRows, reconciled: installedKeys.length, taxRows, marketplaces };
}

/** settings.json carries extraKnownMarketplaces as either a string[] or a
 * name -> {source} map — the real world has shipped both. */
export function extraMarketplaceNames(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((n): n is string => typeof n === 'string');
  if (raw && typeof raw === 'object') return Object.keys(raw);
  if (typeof raw === 'string') return [raw];
  return [];
}

/** Which agents a plugin tree DECLARES it targets, by the marker files it ships. */
export function targetsInTree(installPath: string | null | undefined): { agent: string; evidence: string }[] {
  if (!installPath) return [];
  const out: { agent: string; evidence: string }[] = [];
  const markers: [string, string][] = [
    ['copilot-hooks.json', 'copilot_cli'],
    ['opencode.json', 'opencode'],
    ['plugin.yaml', 'opencode'],
    ['.kiro', 'kiro'],
  ];
  for (const [marker, agent] of markers) {
    if (existsSync(join(installPath, marker))) out.push({ agent, evidence: marker });
  }
  const hooks = tryReaddir(join(installPath, 'hooks'));
  if (hooks.ok && hooks.entries.length) out.push({ agent: 'claude_code', evidence: 'hooks/' });
  return out;
}

// ── Editor-synced agent plugins and skills ──────────────────────────────────

/**
 * Instructions that arrive over Settings Sync with no marketplace row, no
 * extension id and no install prompt. cache.json carries a numeric sync id,
 * not a publisher or signature, so provenance stops at 'arrived via Settings
 * Sync under this account' and the pack is classed unsigned by construction.
 *
 * @returns the SKILL.md files found, for the hidden-Unicode scan to cover.
 */
export function sweepEditorSyncedSkills(db: DB, now: number): { packs: number; skillFiles: string[] } {
  const packs: string[] = [];
  const skillFiles: string[] = [];
  const roots: { dir: string; agent: string }[] = [
    { dir: join(home(), '.vscode', 'agent-plugins'), agent: 'claude_code' },
    { dir: join(home(), '.cursor', 'skills-cursor'), agent: 'cursor' },
  ];
  for (const { dir, agent } of roots) {
    const packNames = new Set<string>();
    const walk = (d: string, depth: number): void => {
      if (depth > 5) return;
      const entries = tryReaddir(d);
      if (!entries.ok) return;
      for (const e of entries.entries) {
        const p = join(d, e);
        let isDir = false;
        try { isDir = statSync(p).isDirectory(); } catch { /* gone */ }
        if (e === 'SKILL.md') {
          skillFiles.push(p);
          packNames.add(p.slice(dir.length + 1).split('/')[0]!);
        } else if (isDir) {
          walk(p, depth + 1);
        }
        // cache.json carries a numeric sync id, not a publisher — no signal to store.
      }
    };
    walk(dir, 0);
    // One plugins row per synced pack root: unsigned, sync-delivered.
    for (const name of packNames) {
      db.prepare(`
        INSERT INTO plugins (plugin_key, agent, name, marketplace, source, first_seen, last_seen)
        VALUES (?, ?, ?, NULL, 'settings-sync:unsigned', ?, ?)
        ON CONFLICT(plugin_key) DO UPDATE SET last_seen = excluded.last_seen`)
        .run(`plugin:${agent}:synced:${name}`, agent, name, now, now);
      packs.push(name);
    }
  }
  return { packs: packs.length, skillFiles };
}
