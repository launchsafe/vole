import { execFileSync } from 'node:child_process';

/**
 * PPPC payload generated from Vole's own code signature, and the ad-hoc
 * cdhash trap.
 *
 * bundle.sh's non---release path ad-hoc signs, so `codesign -d -r-` prints a
 * designated requirement keyed on `cdhash H"…"`. A TCC grant is keyed on the
 * bundle identifier PLUS the designated requirement, so under a cdhash DR
 * every rebuild is a different application to TCC: every grant evaporates
 * with no error, no prompt and no log line, and the whole fleet renders zeros.
 * This module reads the running bundle's own requirement and generates the
 * .mobileconfig an admin enrolls — plus the red note when the requirement is
 * an ad-hoc cdhash (ship a Developer ID build before enrolling any device).
 *
 * Vole can print the requirement its own binary satisfies; it cannot verify
 * that an MDM delivered the profile, cannot read back which TCC services a
 * profile granted, and cannot detect a profile pushed then removed.
 */

export const BUNDLE_IDENTIFIER = 'com.launchsafe.vole';

export interface RequirementInfo {
  /** The designated requirement string (e.g. `cdhash H"89b9…"` or `anchor apple generic and …`). */
  requirement: string | null;
  /** Team identifier, or null when ad-hoc (`not set`). */
  teamIdentifier: string | null;
  /** true when the DR is a bare cdhash — the rebuild-evaporates-grants trap. */
  adhoc: boolean;
  /** Human-readable warning to render inline in red when adhoc. */
  trap: string | null;
}

/** Parses raw `codesign -d -r-` output (stderr+stdout) into RequirementInfo. */
export function parseCodesignOutput(raw: string): RequirementInfo {
  const requirement = raw.match(/designated => (.+)/)?.[1]?.trim() ?? null;
  const team = raw.match(/TeamIdentifier=(.+)/)?.[1]?.trim();
  const teamIdentifier = team && team !== 'not set' ? team : null;
  const adhoc = !!requirement && /^cdhash H"/.test(requirement) && !/anchor apple generic/.test(requirement);
  return {
    requirement,
    teamIdentifier,
    adhoc,
    trap: adhoc
      ? 'this build is ad-hoc signed (designated requirement is a bare cdhash): its permission grants die on the next rebuild — ship a Developer ID build before enrolling any device'
      : null,
  };
}

/** Reads the running bundle's own designated requirement via codesign. */
export function ownRequirement(appPath: string): RequirementInfo {
  try {
    // codesign writes its display output to stderr; both are captured.
    const out = execFileSync('codesign', ['-d', '-r-', appPath], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'] });
    return parseCodesignOutput(out);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    if (typeof stderr === 'string' && stderr.includes('designated =>')) return parseCodesignOutput(stderr);
    return { requirement: null, teamIdentifier: null, adhoc: false, trap: null };
  }
}

export interface PppcService {
  /** TCC service name, e.g. 'SystemPolicyAllFiles', 'RemovableVolumes'. */
  service: string;
  allowed: boolean;
}

/** Generates the .mobileconfig PPPC payload from Vole's own requirement. */
export function pppcMobileconfig(
  info: RequirementInfo,
  opts: { identifier?: string; services?: PppcService[]; payloadDisplayName?: string; payloadIdentifier?: string } = {},
): string {
  const identifier = opts.identifier ?? BUNDLE_IDENTIFIER;
  const services: PppcService[] = opts.services ?? [
    { service: 'SystemPolicyAllFiles', allowed: true },
    { service: 'RemovableVolumes', allowed: false },
  ];
  const payloadUuid = '00000000-0000-0000-0000-0000000000VO'.replace(/[^0-9a-f-]/g, '0');
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const req = info.requirement ? esc(info.requirement) : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>PayloadType</key>
            <string>com.apple.TCC.configuration-profile-payload</string>
            <key>PayloadIdentifier</key>
            <string>${esc(opts.payloadIdentifier ?? 'com.launchsafe.vole.pppc')}</string>
            <key>PayloadUUID</key>
            <string>${payloadUuid}</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>PayloadDisplayName</key>
            <string>${esc(opts.payloadDisplayName ?? 'Vole Privacy Preferences')}</string>
            <key>Services</key>
            <array>
${services
  .map(
    (s) => `                <dict>
                    <key>Service</key>
                    <string>${esc(s.service)}</string>
                    <key>Allowed</key>
                    <${s.allowed ? 'true/' : 'false/'}>
                </dict>`,
  )
  .join('\n')}
            </array>
            <key>CodeRequirement</key>
            <string>${req}</string>
            <key>Identifier</key>
            <string>${esc(identifier)}</string>
            <key>IdentifierType</key>
            <string>bundleID</string>
${info.adhoc ? `            <key>_adhoc_trap_note</key>
            <string>${esc(info.trap ?? 'ad-hoc build — grants evaporate on rebuild')}</string>
` : ''}        </dict>
    </array>
    <key>PayloadDisplayName</key>
    <string>Vole Privacy Preferences</string>
    <key>PayloadIdentifier</key>
    <string>com.launchsafe.vole.mdm</string>
    <key>PayloadOrganization</key>
    <string>Launchsafe</string>
    <key>PayloadRemovalDisallowed</key>
    <true/>
    <key>PayloadScope</key>
    <string>System</string>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>${payloadUuid}</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>
`;
}
