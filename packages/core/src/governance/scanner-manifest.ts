import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../paths';

/**
 * The shipped read manifest and the per-scanner switches (tier 3 #12, #30).
 *
 * A works council or DPO objects to exactly the scanners that read outside the
 * agent stores, so the manifest is the promise: every scanner, the paths it
 * reads, the fields it stores, the fields it deliberately never reads. The
 * promise is only a control because check-egress.mjs and the scanner lane
 * honour it — resolveScannerSwitch() is the single resolver the lane consults
 * (the registration wiring in scanners/index.ts is the integration step).
 *
 * Precedence: a managed pin (rulePolicyPaths[0] `scanners` block) WINS and is
 * reported locked — the point for fleet deployment, visible to the employee
 * rather than silent. Otherwise a user override (~/.vole/scanners.json) wins.
 * Otherwise the manifest default. A scanner with consentTier 'explicit'
 * (shell-history) defaults OFF in both personal and managed mode.
 */

const _require = createRequire(import.meta.url);

export interface ScannerManifestEntry {
  name: string;
  paths: string[];
  fieldsStored: string[];
  fieldsNeverRead: string[];
  defaultEnabled: boolean;
  consentTier: 'normal' | 'explicit';
}

export function loadScannerManifest(): ScannerManifestEntry[] {
  const raw = _require('../data/scanner-manifest.json') as { scanners: ScannerManifestEntry[] };
  return raw.scanners;
}

export function manifestEntry(name: string): ScannerManifestEntry | undefined {
  return loadScannerManifest().find((s) => s.name === name);
}

// ponytail: ~/.vole/scanners.json belongs in paths.ts with the other user files — move at integration.
export function userScannersFile(home = homedir()): string {
  return process.env.VOLE_HOME_OVERRIDE ? join(process.env.VOLE_HOME_OVERRIDE, '.vole', 'scanners.json') : join(home, '.vole', 'scanners.json');
}

function readJson(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface ScannerSwitch {
  name: string;
  enabled: boolean;
  /** true when a managed pin decided — render the lock glyph. */
  locked: boolean;
  /** which layer won: 'managed' | 'user' | 'manifest' */
  basis: 'managed' | 'user' | 'manifest';
  /** for explicit-consent scanners: the toggle must go through the scope ledger. */
  consentTier: 'normal' | 'explicit';
}

/**
 * Resolve one scanner's on/off state. An unknown scanner name is OFF — a
 * scanner absent from the manifest has no declared read scope and must not run.
 */
export function resolveScannerSwitch(
  name: string,
  opts: { userFile?: string; managedFiles?: string[] } = {},
): ScannerSwitch {
  const entry = manifestEntry(name);
  const consentTier = entry?.consentTier ?? 'explicit';
  const base: ScannerSwitch = { name, enabled: false, locked: false, basis: 'manifest', consentTier };
  if (!entry) return base;
  // Managed pin: the admin-owned policy file's `scanners` block wins, locked.
  for (const f of opts.managedFiles ?? paths.rulePolicyPaths()) {
    const j = readJson(f);
    if (!j || typeof j.scanners !== 'object' || j.scanners === null) continue;
    const pins = j.scanners as Record<string, unknown>;
    if (name in pins && typeof pins[name] === 'boolean') {
      return { ...base, enabled: pins[name] as boolean, locked: true, basis: 'managed' };
    }
  }
  // User override.
  const user = readJson(opts.userFile ?? userScannersFile());
  if (user && typeof user === 'object' && name in user && typeof (user as Record<string, unknown>)[name] === 'boolean') {
    return { ...base, enabled: (user as Record<string, unknown>)[name] as boolean, basis: 'user' };
  }
  return { ...base, enabled: entry.defaultEnabled };
}

/** All switches, for the 'What Vole reads' screen. */
export function resolveAllScannerSwitches(opts: { userFile?: string; managedFiles?: string[] } = {}): ScannerSwitch[] {
  return loadScannerManifest().map((s) => resolveScannerSwitch(s.name, opts));
}
