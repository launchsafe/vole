import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DB } from '../db';
import { openDb } from '../db';
import type { Scanner } from '../db';
import type { Anomaly } from '../types';
import { contentOf, hashOf } from '../content';
import { upsertSurface, type Surface } from './ai-surfaces';
import { loadAiHosts, type AiHost } from './ai-hosts';

/**
 * The browser-grants census (tier 2): reach and identity read from the browser's
 * own state, never from the Extensions folder and never from anything the user
 * typed. Three ledgers live here:
 *
 *  - browser_extensions: each profile's `Secure Preferences` -> extensions.settings,
 *    with the location enum and the declared/granted/withheld permission triad.
 *    Reach is authority, not exercise — these rows can never say an extension ran.
 *  - browser_identity: `Local State` -> profile.info_cache (hosted_domain etc.),
 *    the account class for the seats that use no CLI at all. Only the domain and
 *    an HMAC of the address are kept; the raw address never enters the store.
 *  - site_capabilities: `Preferences` -> profile.content_settings.exceptions
 *    joined to the shipped AI-host pack — what a chat site was allowed to touch
 *    (mic, camera, directory picker). A grant is authority, not transfer.
 *
 * Plus the Chrome extension depth: per-version directories with permission diffs,
 * Chrome's own store verdict (cws-info / disable_reasons / allowlist), and
 * cross-profile fork drift for the same extension id.
 */

/** Chromium-family roots, by the Application Support directory name. */
export const CHROMIUM_ROOTS: [dir: string, browser: string][] = [
  ['Google/Chrome', 'chrome'],
  ['Chromium', 'chromium'],
  ['Microsoft Edge', 'edge'],
  ['BraveSoftware/Brave-Browser', 'brave'],
  ['Arc/User Data', 'arc'],
  ['Arc', 'arc'],
  ['Comet', 'comet'],
  ['Dia', 'dia'],
  ['Vivaldi', 'vivaldi'],
];

/** Chrome's extension `location` enum — where the install came from. */
const EXTENSION_LOCATIONS: Record<number, string> = {
  1: 'internal',
  2: 'external_pref',
  3: 'external_registry',
  4: 'unpacked',
  5: 'component',
  6: 'external_policy_download',
  7: 'policy',
  8: 'command_line',
  9: 'policy_component',
  10: 'external_component',
};

/** content_settings.exceptions keys worth reporting as capabilities. */
const CAPABILITY_KEYS = [
  'media_stream_mic',
  'media_stream_camera',
  'clipboard',
  'file_system_access_chooser_data',
  'file_system_last_picked_directory',
  'file_system_access_extended_permission',
  'durable_storage',
  'notifications',
  'permission_actions_history',
  'site_engagement',
  'media_engagement',
];

interface ExtSetting {
  manifest?: {
    name?: string;
    version?: string;
    permissions?: string[];
    host_permissions?: string[];
    content_scripts?: unknown[];
  };
  location?: number;
  path?: string;
  from_webstore?: boolean;
  was_installed_by_default?: boolean;
  was_installed_by_oem?: boolean;
  disable_reasons?: number | number[];
  newAllowlist?: Record<string, unknown>;
  cws_info?: Record<string, unknown>;
  active_permissions?: { permissions?: string[]; host_permissions?: string[] } | number[];
  granted_permissions?: { permissions?: string[]; host_permissions?: string[] } | number[];
  withholding_permissions?: { permissions?: string[]; host_permissions?: string[] } | number[];
  install_time?: string;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Profile dirs from `Local State` -> profile.info_cache keys; ['Default'] as fallback. */
export function chromiumProfiles(root: string): string[] {
  const ls = readJson(join(root, 'Local State'));
  const info = (ls?.profile as { info_cache?: Record<string, unknown> } | undefined)?.info_cache;
  if (info && Object.keys(info).length) return Object.keys(info);
  return existsSync(join(root, 'Default')) ? ['Default'] : [];
}

function permLists(v: ExtSetting['active_permissions']): { permissions: string[]; host_permissions: string[] } {
  if (Array.isArray(v)) return { permissions: v.map(String), host_permissions: [] };
  return { permissions: v?.permissions ?? [], host_permissions: v?.host_permissions ?? [] };
}

function normalizeReasons(r: number | number[] | undefined): number[] {
  if (r === undefined) return [];
  return Array.isArray(r) ? r : [r];
}

/**
 * The extension census per (browser, profile): manifest + install source + the
 * permission triad. Everything the spec asks for goes in `extra`; the surface row
 * is inventory ("installed browser AI reach"), never exercise.
 */
export function browserExtensionCensus(home: string, now: number): { surfaces: Surface[]; anomalies: Anomaly[] } {
  const surfaces: Surface[] = [];
  const byId = new Map<string, { browser: string; profile: string; version: string | null }[]>();
  const AI_HINT = /(?:^|[^a-z])(ai|gpt|claude|gemini|copilot|llm|chat|wise|sider|merlin|monica|perplex|cline|roo|kilo|continue)(?:[^a-z]|$)/i;
  for (const [dir, browser] of CHROMIUM_ROOTS) {
    const root = join(home, 'Library/Application Support', dir);
    if (!existsSync(root)) continue;
    for (const profile of chromiumProfiles(root)) {
      const prefs = readJson(join(root, profile, 'Secure Preferences'));
      const settings = (prefs?.extensions as { settings?: Record<string, ExtSetting> } | undefined)?.settings ?? {};
      for (const [id, ext] of Object.entries(settings)) {
        const name = ext.manifest?.name;
        const isAi = (name && !name.startsWith('__MSG_') && AI_HINT.test(name)) || ext.from_webstore === undefined && !!ext.manifest?.host_permissions?.length;
        if (!name || name.startsWith('__MSG_')) continue;
        // Every extension is recorded (reach is reach), with an ai flag in extra
        // so the grid can highlight without a hidden name-list verdict.
        void isAi;
        const active = permLists(ext.active_permissions);
        const granted = permLists(ext.granted_permissions);
        const withheld = permLists(ext.withholding_permissions);
        // Permission lists are stored as COUNTS, never the lists: a
        // granted-permission array is free text a long-tail extension can push
        // past the 512-char content boundary (ai_surfaces.extra is
        // shape-scanned by verify --content). The names stay in the source file.
        const extra = {
          browser, profile, id, ai: isAi ?? false,
          location: EXTENSION_LOCATIONS[ext.location ?? -1] ?? 'unknown',
          locationRaw: ext.location ?? null,
          from_webstore: ext.from_webstore ?? null,
          was_installed_by_default: ext.was_installed_by_default ?? null,
          disable_reasons: normalizeReasons(ext.disable_reasons),
          declared_permissions: (ext.manifest?.permissions ?? []).length,
          declared_host_permissions: (ext.manifest?.host_permissions ?? []).length,
          content_scripts: ext.manifest?.content_scripts?.length ?? 0,
          active_permissions: active.permissions.length,
          active_host_permissions: active.host_permissions.length,
          granted_permissions: granted.permissions.length,
          granted_host_permissions: granted.host_permissions.length,
          withheld_permissions: withheld.permissions.length,
          withheld_host_permissions: withheld.host_permissions.length,
        };
        surfaces.push({
          surface_key: `browser-ext:${browser}:${profile}:${id}`,
          kind: 'extension',
          name,
          path: ext.path ?? null,
          evidence:
            `${browser} profile ${profile} extension ${id} v${ext.manifest?.version ?? '?'} ` +
            `(source ${extra.location}${ext.from_webstore ? ', webstore' : ''}) — ` +
            `${granted.permissions.length + granted.host_permissions.length} granted permission(s), ` +
            `${withheld.permissions.length + withheld.host_permissions.length} withheld. Reach is authority, never exercise.`,
          version: ext.manifest?.version ?? null,
          extra: JSON.stringify(extra),
          depth: { vendor: browser, identifier: id, evidence_kind: 'secure_preferences', scanner: 'browser-grants' },
        });
        // Chrome's own verdict, surfaced separately (feature: extension_store_state).
        const verdict = {
          id, browser, profile,
          from_webstore: ext.from_webstore ?? null,
          disable_reasons: normalizeReasons(ext.disable_reasons),
          allowlisted: Object.keys(ext.newAllowlist ?? {}).length > 0 ? true : null,
          cws_info_present: !!ext.cws_info,
        };
        if (verdict.disable_reasons.length || verdict.allowlisted !== null || verdict.cws_info_present || ext.install_time) {
          surfaces.push({
            surface_key: `browser-extstore:${browser}:${profile}:${id}`,
            kind: 'extension',
            name: `${name} — store verdict`,
            path: null,
            evidence: `Chrome's own verdict for ${id}: ${verdict.disable_reasons.length ? `disable_reasons ${verdict.disable_reasons.join(',')} ` : 'not disabled '}${verdict.from_webstore === false ? '· NOT from webstore ' : ''}${verdict.allowlisted ? '· on the enterprise allowlist' : ''}`.trim(),
            version: ext.manifest?.version ?? null,
            extra: JSON.stringify(verdict),
            depth: { vendor: browser, identifier: id, evidence_kind: 'store_state', scanner: 'browser-grants' },
          });
        }
        const seen = byId.get(id) ?? [];
        seen.push({ browser, profile, version: ext.manifest?.version ?? null });
        byId.set(id, seen);
      }
    }
  }
  // Fork drift: the same extension id seen at different versions across
  // browsers/profiles — the fleet-uniformity gap no console shows.
  const anomalies: Anomaly[] = [];
  for (const [id, entries] of byId) {
    const versions = new Set(entries.map((e) => e.version ?? '?'));
    if (versions.size > 1) {
      surfaces.push({
        surface_key: `browser-fork-drift:${id}`,
        kind: 'extension',
        name: `Fork drift: ${id}`,
        path: null,
        evidence: `extension ${id} runs ${versions.size} different versions here: ${[...versions].join(', ')} (${entries.map((e) => `${e.browser}/${e.profile}`).join(', ')})`,
        extra: JSON.stringify({ id, versions: [...versions], roots: entries }),
        depth: { identifier: id, evidence_kind: 'fork_drift', scanner: 'browser-grants' },
      });
    }
  }
  return { surfaces, anomalies };
}

/**
 * Chrome keeps every installed version's directory under
 * <profile>/Extensions/<id>/<version>/ — the retroactive version history the
 * live manifest cannot give, with a permission diff between neighbours.
 */
export function extensionVersionHistory(home: string, now: number): Surface[] {
  const out: Surface[] = [];
  for (const [dir, browser] of CHROMIUM_ROOTS) {
    const root = join(home, 'Library/Application Support', dir);
    if (!existsSync(root)) continue;
    for (const profile of chromiumProfiles(root)) {
      const extRoot = join(root, profile, 'Extensions');
      let ids: string[];
      try {
        ids = readdirSync(extRoot);
      } catch {
        continue;
      }
      for (const id of ids) {
        let versions: string[];
        try {
          versions = readdirSync(join(extRoot, id));
        } catch {
          continue;
        }
        const sorted = versions.filter((v) => existsSync(join(extRoot, id, v, 'manifest.json'))).sort(compareVersions);
        let prevPerms: Set<string> | null = null;
        for (const v of sorted) {
          const man = readJson(join(extRoot, id, v, 'manifest.json'));
          const perms = new Set([
            ...((man?.permissions as string[] | undefined) ?? []),
            ...((man?.host_permissions as string[] | undefined) ?? []),
          ]);
          const added = prevPerms === null ? null : [...perms].filter((p) => !prevPerms!.has(p));
          const removed = prevPerms === null ? null : [...prevPerms!].filter((p) => !perms.has(p));
          out.push({
            surface_key: `browser-extver:${browser}:${profile}:${id}:${v}`,
            kind: 'extension',
            name: `${(man?.name as string | undefined) ?? id} ${v}`,
            path: join(extRoot, id, v),
            evidence:
              `version directory ${v} on disk${added === null ? ' (earliest version kept)' : added.length ? ` — ADDED permissions vs previous: ${added.join(', ')}` : ' — no permission change vs previous'}` +
              (removed?.length ? `; removed: ${removed.join(', ')}` : ''),
            version: v,
            extra: JSON.stringify({ browser, profile, id, version: v, permissions: [...perms], added, removed }),
            depth: { vendor: browser, identifier: id, evidence_kind: 'version_directory', scanner: 'browser-grants' },
          });
          prevPerms = perms;
        }
      }
    }
  }
  void now;
  return out;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * browser_identity: the account each browser profile is signed into, resolved to
 * a class from the auth-adjacent Local State fields. Only the hosted domain and
 * an HMAC of the account address are kept — the address itself never enters Vole.
 */
export function browserIdentityCensus(home: string, now: number): Surface[] {
  const out: Surface[] = [];
  for (const [dir, browser] of CHROMIUM_ROOTS) {
    const root = join(home, 'Library/Application Support', dir);
    if (!existsSync(root)) continue;
    const ls = readJson(join(root, 'Local State'));
    if (!ls) continue;
    const info = (ls.profile as { info_cache?: Record<string, { hosted_domain?: string; user_name?: string; gaia_id?: string; is_ephemeral?: boolean }> } | undefined)?.info_cache;
    const managed = (ls.signin as { active_accounts_managed?: boolean } | undefined)?.active_accounts_managed ?? null;
    const mdm = ((ls.management as { platform?: { enterprise_mdm_mac?: number } } | undefined)?.platform?.enterprise_mdm_mac) ?? null;
    for (const [profile, p] of Object.entries(info ?? {})) {
      // A signed-out profile yields 'unknown', never 'consumer' (Chrome's state is
      // stale between flushes — absence proves nothing).
      let accountClass: string | null = null;
      let evidence = '';
      if (p.user_name) {
        accountClass = p.hosted_domain && p.hosted_domain !== 'NO_HOSTED_DOMAIN' ? 'org' : 'personal';
        evidence = `Local State profile.info_cache.${profile}: hosted_domain=${p.hosted_domain ?? 'NO_HOSTED_DOMAIN'}`;
      } else {
        accountClass = 'unknown';
        evidence = `Local State profile.info_cache.${profile}: no signed-in account recorded`;
      }
      out.push({
        surface_key: `browser-identity:${browser}:${profile}`,
        kind: 'browser_host',
        name: `${browser} profile ${profile} (browser identity)`,
        path: join(root, 'Local State'),
        evidence:
          `${evidence}${managed ? ` · managed accounts (${managed})` : ''}${mdm ? ` · MDM enrolment ${mdm}` : ''} — ` +
          'domain + HMAC only, the raw address never enters the store',
        extra: JSON.stringify({
          browser, profile,
          hosted_domain: p.hosted_domain ?? null,
          account_hmac: p.user_name ? hashOf(contentOf(p.user_name)) : null,
          is_ephemeral: p.is_ephemeral ?? null,
          active_accounts_managed: managed,
          enterprise_mdm_mac: mdm,
        }),
        depth: { vendor: browser, evidence_kind: 'local_state', scanner: 'browser-grants', account_class: accountClass, class_evidence: evidence },
      });
    }
  }
  void now;
  return out;
}

/**
 * site_capabilities: the (origin, capability) grants Chrome persisted for AI
 * hosts — the browser-grants section of the Leak Ledger. The exception VALUE for
 * the directory-picker settings names the chosen directory; that path is recorded
 * in the surface evidence (a path, chosen by the human, is not page content).
 */
export function siteCapabilityCensus(home: string, now: number): { rows: [origin: string, capability: string, pref_key: string, pref_file: string][]; surfaces: Surface[] } {
  const rows: [string, string, string, string][] = [];
  const surfaces: Surface[] = [];
  const hosts = loadAiHosts();
  const hostSet = new Set(hosts.map((h: AiHost) => h.host));
  const labelOf = (h: string) => hosts.find((x: AiHost) => x.host === h)?.label ?? h;
  for (const [dir, browser] of CHROMIUM_ROOTS) {
    const root = join(home, 'Library/Application Support', dir);
    if (!existsSync(root)) continue;
    for (const profile of chromiumProfiles(root)) {
      const prefFile = join(root, profile, 'Preferences');
      const prefs = readJson(prefFile);
      const exceptions = (prefs?.profile as { content_settings?: { exceptions?: Record<string, Record<string, Record<string, unknown>>> } } | undefined)
        ?.content_settings?.exceptions ?? {};
      for (const [capability, entries] of Object.entries(exceptions)) {
        if (!CAPABILITY_KEYS.includes(capability)) continue;
        for (const [origin, value] of Object.entries(entries ?? {})) {
          const host = origin.replace(/^https?:\/\//, '').split(/[/:*]/)[0] ?? '';
          if (!hostSet.has(host)) continue;
          rows.push([origin, capability, capability, prefFile]);
          let picked: string | null = null;
          const setting = (value as { setting?: unknown })?.setting;
          if (typeof setting === 'object' && setting !== null && 'picked_dir' in (setting as object)) {
            picked = String((setting as { picked_dir: unknown }).picked_dir) || null;
          }
          surfaces.push({
            surface_key: `site-cap:${browser}:${profile}:${host}:${capability}`,
            kind: 'site',
            name: `${labelOf(host)} — ${capability}`,
            path: prefFile,
            evidence:
              `${browser} profile ${profile} granted ${capability} to ${host} (content_settings.exceptions key "${capability}", pref file ${prefFile.replace(home, '~')})` +
              (picked ? ` — last picked directory: ${picked}` : '') +
              '. A grant is authority, not transfer: nothing here says any file was uploaded.',
            extra: JSON.stringify({ browser, profile, host, capability, origin, picked_dir: picked }),
            depth: { vendor: browser, evidence_kind: 'content_settings', scanner: 'browser-grants' },
          });
        }
      }
    }
  }
  void now;
  return { rows, surfaces };
}

export function writeSiteCapabilities(db: DB, rows: [string, string, string, string][], now: number): void {
  const upsert = db.prepare(`
    INSERT INTO site_capabilities (origin, capability, pref_key, pref_file, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(origin, capability, pref_file) DO UPDATE SET last_seen = excluded.last_seen`);
  for (const [origin, capability, pref_key, pref_file] of rows) {
    upsert.run(origin, capability, pref_key, pref_file, now, now);
  }
}

/** One pass over every Chromium root: extensions, identity, grants. */
export function scanBrowserGrants(): { ok: boolean; notes?: string } {
  const db: DB = openDb();
  const now = Date.now();
  const home = homedir();
  const ext = browserExtensionCensus(home, now);
  const ver = extensionVersionHistory(home, now);
  const identity = browserIdentityCensus(home, now);
  const caps = siteCapabilityCensus(home, now);
  const surfaces = [...ext.surfaces, ...ver, ...identity, ...caps.surfaces];
  for (const s of surfaces) upsertSurface(db, s, now);
  writeSiteCapabilities(db, caps.rows, now);
  return {
    ok: true,
    notes: `${surfaces.length} browser surface(s) · ${caps.rows.length} site capability grant(s)`,
  };
}

export const browserGrantsScanner: Scanner = {
  name: 'browser-grants',
  cadenceMs: 5 * 60_000,
  run: scanBrowserGrants,
};
