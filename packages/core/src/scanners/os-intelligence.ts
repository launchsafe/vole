import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { home } from '../paths';
import { openDb } from '../db';
import type { DB, Scanner } from '../db';

/**
 * os_intelligence, deep read (tier 2 feature 8): the AI wired into macOS — the
 * only AI surface on a seat that never opens a terminal. Per-partner
 * enablement from com.apple.generativepartnerservicesettings, the
 * CloudSubscriptionFeatures opt-in keys, the on-device model asset state, and
 * the MDM payload that was supposed to govern it.
 *
 * These keys record enablement and availability, never prompts: Apple writes no
 * per-request record any user-space reader can see, so tokens, cost and content
 * are structurally NULL forever and the row can never be misread as spend.
 * unavailable = 1 may mean region, account tier or hardware — we report the
 * flag, we do not guess which.
 */

export interface PartnerSetting {
  partner: string;
  enablementCount: number | null;
  unavailable: number | null;
}

/** Parses `defaults read com.apple.generativepartnerservicesettings` output. */
export function parseGenerativePartnerSettings(text: string): { partners: PartnerSetting[]; gatMigrationComplete2: number | null } {
  const partners: PartnerSetting[] = [];
  // Slice from the AllLLMUISettings key onward: partner entries are one level
  // under it, and the flat `[^\}]*` body cannot cross a nested closing brace.
  const i = text.indexOf('AllLLMUISettings');
  if (i >= 0) {
    for (const m of text.slice(i).matchAll(/"([^"]+)"\s*=\s*\{([^}]*)\}/g)) {
      const partner = m[1]!;
      const body = m[2]!;
      const count = body.match(/enablementCount\s*=\s*(\d+)/)?.[1];
      const unavail = body.match(/unavailable\s*=\s*(\d+)/)?.[1];
      partners.push({
        partner,
        enablementCount: count !== undefined ? Number(count) : null,
        unavailable: unavail !== undefined ? Number(unavail) : null,
      });
    }
  }
  const gat = text.match(/gatMigrationComplete2\s*=\s*(\d+)/)?.[1];
  return { partners, gatMigrationComplete2: gat !== undefined ? Number(gat) : null };
}

/** Parses `defaults read com.apple.CloudSubscriptionFeatures.optIn` output. */
export function parseCloudSubscriptionOptIn(text: string): { optedOutBuddy: number | null; optedChangeOsVersion: string | null } {
  // defaults quotes keys that contain underscores; accept both spellings.
  const buddy = text.match(/"?opted_out_buddy"?\s*=\s*(\d+)/)?.[1];
  const version = text.match(/"?opted_change_os_version"?\s*=\s*"([^"]*)"/)?.[1];
  return { optedOutBuddy: buddy !== undefined ? Number(buddy) : null, optedChangeOsVersion: version ?? null };
}

function readDefaults(domain: string): string | null {
  try {
    return execFileSync('defaults', ['read', domain], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    });
  } catch {
    return null;
  }
}

/** The MDM payload: which preference KEYS it sets (names only, never values). */
function mdmPayloadKeys(): { path: string; keys: string[] } | null {
  const p = '/Library/Managed Preferences/com.apple.generativepartnerservicesettings.plist';
  if (!existsSync(p)) return null;
  try {
    const raw = execFileSync('plutil', ['-convert', 'xml1', '-o', '-', p], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    });
    return { path: p, keys: [...raw.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]!) };
  } catch {
    return { path: p, keys: [] }; // present but unreadable: state is still 'payload applied'
  }
}

/** The on-device generative-model asset state (count of downloaded assets). */
function generativeModelAssets(): { path: string; count: number | null } {
  const p = '/System/Library/AssetsV2/com_apple_MobileAsset_UAF_FM_GenerativeModels';
  if (!existsSync(p)) return { path: p, count: null };
  try {
    return { path: p, count: readdirSync(p).length };
  } catch {
    return { path: p, count: null };
  }
}

function upsertSurface(
  db: DB,
  s: { surface_key: string; kind: string; name: string; path: string | null; evidence: string; extra?: string | null },
  now: number,
): void {
  db.prepare(`
    INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, extra, scanner, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, 'os-intelligence', ?, ?)
    ON CONFLICT(surface_key) DO UPDATE SET
      last_seen = excluded.last_seen, evidence = excluded.evidence, extra = excluded.extra`).run(
    s.surface_key, s.kind, s.name, s.path, s.evidence, s.extra ?? null, now, now,
  );
}

export const osIntelligenceScanner: Scanner = {
  name: 'os-intelligence',
  cadenceMs: 5 * 60_000,
  run: () => {
    const db: DB = openDb();
    const now = Date.now();

    const gps = 'com.apple.generativepartnerservicesettings';
    let partners = 0;
    const text = readDefaults(gps);
    if (text) {
      const { partners: rows, gatMigrationComplete2 } = parseGenerativePartnerSettings(text);
      for (const p of rows) {
        partners++;
        upsertSurface(db, {
          surface_key: `os:llm-partner:${p.partner}`,
          kind: 'os',
          name: p.partner,
          path: join(home(), 'Library', 'Preferences', `${gps}.plist`),
          evidence:
            `enablementCount=${p.enablementCount ?? 'unknown'}, unavailable=${p.unavailable ?? 'unknown'} — records enablement ` +
            `and availability only, never prompts; unavailable may mean region, account tier or hardware and Vole does not guess which`,
          extra: JSON.stringify({ ...p, gatMigrationComplete2 }),
        }, now);
      }
    }

    const csf = 'com.apple.CloudSubscriptionFeatures.optIn';
    const optIn = readDefaults(csf);
    if (optIn) {
      const { optedOutBuddy, optedChangeOsVersion } = parseCloudSubscriptionOptIn(optIn);
      upsertSurface(db, {
        surface_key: 'os:cloud-subscription-opt-in',
        kind: 'os',
        name: 'Apple cloud AI opt-in',
        path: join(home(), 'Library', 'Preferences', `${csf}.plist`),
        evidence:
          `opted_out_buddy=${optedOutBuddy ?? 'unknown'}` +
          (optedChangeOsVersion ? `, opted_change_os_version=${optedChangeOsVersion}` : '') +
          ' — an opt-in record, never usage',
        extra: JSON.stringify({ optedOutBuddy, optedChangeOsVersion }),
      }, now);
    }

    if (readDefaults('com.apple.appleintelligencereporting') !== null) {
      upsertSurface(db, {
        surface_key: 'os:apple-intelligence-reporting',
        kind: 'os',
        name: 'Apple Intelligence reporting',
        path: join(home(), 'Library', 'Preferences', 'com.apple.appleintelligencereporting.plist'),
        evidence: 'reporting domain present — the on-device reporting keys exist; no per-request record is user-space readable',
      }, now);
    }

    const assets = generativeModelAssets();
    upsertSurface(db, {
      surface_key: 'os:generative-model-assets',
      kind: 'os',
      name: 'On-device generative models (assets)',
      path: assets.path,
      evidence:
        assets.count !== null
          ? `${assets.count} entr(ies) in the generative-model asset catalog — model assets present, use unobservable from user space`
          : 'asset catalog absent or unreadable — NULL, never zero',
      extra: JSON.stringify({ count: assets.count }),
    }, now);

    const mdm = mdmPayloadKeys();
    upsertSurface(db, {
      surface_key: 'os:generative-partner-mdm',
      kind: 'os',
      name: 'Generative AI settings (MDM)',
      path: mdm?.path ?? '/Library/Managed Preferences/com.apple.generativepartnerservicesettings.plist',
      evidence: mdm
        ? `an MDM payload governs this setting${mdm.keys.length ? ` (keys: ${mdm.keys.join(', ')})` : ' (keys unreadable)'} — managed, not user-chosen`
        : 'no payload applied — the setting is user-chosen on this machine',
      extra: JSON.stringify({ payloadApplied: mdm !== null, keys: mdm?.keys ?? [] }),
    }, now);

    return {
      ok: true,
      notes: `${partners} OS partner row(s), asset catalog ${assets.count ?? 'unknown'}, MDM payload ${mdm ? 'applied' : 'absent'} — enablement records only, never spend`,
    };
  },
};
