import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * The deployment-mode resolver: personal vs managed, from the presence and
 * completeness of /Library/Managed Preferences/com.launchsafe.vole.plist —
 * the only path an MDM-delivered configuration profile writes to.
 *
 * A local admin can hand-write that plist, and macOS offers no API to prove a
 * profile was MDM-delivered rather than placed by root, so every surface must
 * render the result as DECLARED, never 'attested'. A developer on a company
 * laptop stays in personal mode until a profile actually arrives: Vole cannot
 * tell whose laptop it is.
 */

export interface DeploymentMode {
  mode: 'personal' | 'managed';
  /** The org label from the profile, when it declares one. NULL = undeclared. */
  org_label: string | null;
  /** sha256 of the profile bytes — the identity of the declaration the UI shows. */
  profile_hash: string | null;
  resolved_at: number;
  /** Always true when managed: presence is a declaration, not an attestation. */
  declared: boolean;
}

// ponytail: belongs in paths.ts with the other path constants — move at integration.
export const MANAGED_PREFS_PLIST = '/Library/Managed Preferences/com.launchsafe.vole.plist';

export function resolveDeploymentMode(
  opts: { plist?: string; now?: number } = {},
): DeploymentMode {
  const plist = opts.plist ?? MANAGED_PREFS_PLIST;
  const now = opts.now ?? Date.now();
  if (!existsSync(plist)) {
    return { mode: 'personal', org_label: null, profile_hash: null, resolved_at: now, declared: false };
  }
  let org_label: string | null = null;
  try {
    // plutil is macOS stdlib: convert the plist to JSON without a parser of our own.
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', '--', plist], {
      encoding: 'utf8',
      timeout: 4000,
    });
    const parsed = JSON.parse(json) as { org_label?: unknown };
    if (typeof parsed.org_label === 'string' && parsed.org_label.length > 0) org_label = parsed.org_label;
  } catch {
    /* present but unreadable/malformed: still managed (the file exists), label unknown */
  }
  let profile_hash: string | null = null;
  try {
    profile_hash = createHash('sha256').update(readFileSync(plist)).digest('hex');
  } catch {
    /* hash of the declaration is best-effort; presence already decided the mode */
  }
  return { mode: 'managed', org_label, profile_hash, resolved_at: now, declared: true };
}

/**
 * Every product default the mode inverts. Personal mode: identity columns
 * NULL, no notices, no audit log, no purpose binding, every content-reading
 * scanner on, retention unlimited, all per-person views available, MCP
 * unrestricted. Managed mode inverts each of those.
 */
export interface ProductDefaults {
  identityAttribution: boolean;
  subjectNotices: boolean;
  accessAuditLog: boolean;
  purposeBinding: boolean;
  contentReadingScanners: boolean;
  retentionUnlimited: boolean;
  perPersonViews: boolean;
  mcpUnrestricted: boolean;
}

export function productDefaults(mode: DeploymentMode['mode']): ProductDefaults {
  return mode === 'personal'
    ? {
        identityAttribution: false,
        subjectNotices: false,
        accessAuditLog: false,
        purposeBinding: false,
        contentReadingScanners: true,
        retentionUnlimited: true,
        perPersonViews: true,
        mcpUnrestricted: true,
      }
    : {
        identityAttribution: true,
        subjectNotices: true,
        accessAuditLog: true,
        purposeBinding: true,
        contentReadingScanners: false,
        retentionUnlimited: false,
        perPersonViews: false,
        mcpUnrestricted: false,
      };
}

/**
 * The release gate (tier 3 #10): a MANAGED build cannot be produced without
 * the three pieces of privacy machinery the MDM kit lands next to — the
 * lawful-basis record, the per-person-view gate, and the Privacy Center
 * (verify --content passing). bundle.sh / CI call this and refuse on failure.
 * It gates Vole's own release pipeline only; building from source with the
 * checks removed is still possible and the licence does not prevent it.
 */
export interface ReleaseGateInput {
  mode: DeploymentMode['mode'];
  /** ~/.vole/basis.json exists and parses (first-run scope gate, pilot expiry). */
  basisRecordPresent: boolean;
  /** people_view policy machinery importable and functional (view-gate.ts). */
  viewGatePresent: boolean;
  /** `vole verify --content` passed on the artifact's store shape. */
  privacyCenterVerified: boolean;
}

export interface ReleaseGateResult {
  pass: boolean;
  failures: string[];
}

export function releaseGate(input: ReleaseGateInput): ReleaseGateResult {
  if (input.mode !== 'managed') return { pass: true, failures: [] };
  const failures: string[] = [];
  if (!input.basisRecordPresent) failures.push('managed build without a lawful-basis record (basis.json)');
  if (!input.viewGatePresent) failures.push('managed build without the per-person-view gate (people_view policy block)');
  if (!input.privacyCenterVerified) failures.push('managed build without the Privacy Center (verify --content)');
  return { pass: failures.length === 0, failures };
}
