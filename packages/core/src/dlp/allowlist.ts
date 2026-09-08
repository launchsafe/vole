import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { DB } from '../db';
import { insertAnomalies } from '../db';
import { paths } from '../paths';
import { asContent, classifyStatus, scanBuffer } from './engine';
import { fingerprintOf } from './keychain';
import type { FingerprintFn } from './structured-sinks';

/**
 * Permission-allowlist inline-command secret scan (tier 4 #142): permission
 * rules are command STRINGS, not config values, so a token pasted into
 * Bash(curl -H "Authorization: Bearer …") is invisible to every field-walking
 * config auditor. This scans the rule bodies of Claude's permissions.allow/
 * deny/ask, every project-local settings file under a consented work root,
 * ~/.claude.json projects[].allowedTools, and the Codex/Grok equivalents —
 * then runs git ls-files/check-ignore read-only against the carrying file.
 * A secret in a GIT-TRACKED allowlist escalates to a critical incident with
 * the repo and the ls-files output quoted; the value is never stored.
 */

export type TrackedState = 'tracked' | 'ignored' | 'untracked' | null;

interface AllowlistTarget {
  path: string;
  /** Extracts the rule strings from the file's text; the whole body when the shape is unknown. */
  rules: string[];
}

function jsonRules(text: string, extract: (parsed: Record<string, unknown>) => unknown): string[] {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const arr = extract(parsed);
    const out: string[] = [];
    if (Array.isArray(arr)) {
      for (const r of arr) {
        if (typeof r === 'string') out.push(r);
        else if (r && typeof r === 'object' && typeof (r as { command?: unknown }).command === 'string') {
          out.push((r as { command: string }).command);
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** The files whose rule BODIES get scanned, in precedence order. */
function allowlistTargets(): AllowlistTarget[] {
  const home = () => process.env.VOLE_HOME_OVERRIDE ?? homedir();
  const claude = paths.claudeConfigDir();
  const targets: AllowlistTarget[] = [];

  const permFiles = [
    join(claude, 'settings.json'),
    join(claude, 'settings.local.json'),
    // Grok CLI: same permissions shape when present, raw body otherwise.
    join(home(), '.grok', 'settings.json'),
  ];
  for (const p of permFiles) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    const rules = jsonRules(text, (parsed) => {
      const perms = parsed.permissions as Record<string, unknown> | undefined;
      return [...(perms?.allow as unknown[] ?? []), ...(perms?.deny as unknown[] ?? []), ...(perms?.ask as unknown[] ?? [])];
    });
    targets.push({ path: p, rules: rules.length ? rules : [text] });
  }

  const claudeJson = join(home(), '.claude.json');
  if (existsSync(claudeJson)) {
    targets.push({
      path: claudeJson,
      rules: jsonRules(readFileSync(claudeJson, 'utf8'), (parsed) => {
        const projects = parsed.projects as Record<string, { allowedTools?: unknown[] }> | undefined;
        return Object.values(projects ?? {}).flatMap((p) => p.allowedTools ?? []);
      }),
    });
  }

  // Codex: config.toml has no JSON shape — the whole body is command strings.
  const codexConfig = join(paths.codexHome(), 'config.toml');
  if (existsSync(codexConfig)) {
    targets.push({ path: codexConfig, rules: [readFileSync(codexConfig, 'utf8')] });
  }

  return targets;
}

/**
 * Read-only git probe of the carrying file: 'tracked' (ls-files lists it),
 * 'ignored' (check-ignore matches), 'untracked', or NULL when the file sits
 * outside any git repository — never 'safe'.
 */
export function gitTrackedState(file: string): TrackedState {
  const dir = dirname(file);
  const ls = spawnSync('git', ['-C', dir, 'ls-files', '--error-unmatch', file], { timeout: 4000 });
  if (ls.status === 0) return 'tracked';
  if (ls.status === 128) return null; // not a git repository
  const ign = spawnSync('git', ['-C', dir, 'check-ignore', '-q', file], { timeout: 4000 });
  if (ign.status === 0) return 'ignored';
  return 'untracked';
}

export interface AllowlistScanResult {
  filesScanned: number;
  rulesScanned: number;
  newSightings: number;
  escalated: number;
  notes: string[];
}

/**
 * Scans every allowlist rule body for secret shapes and writes sightings
 * under sink `allowlist:<file>`. When the carrying file is git-tracked AND a
 * rule carries a secret, one critical incident per fingerprint fires —
 * quoting the repo and the ls-files output, never the value.
 */
export function scanPermissionAllowlists(
  db: DB,
  workRoots: string[],
  now: number,
  fp: FingerprintFn = fingerprintOf,
): AllowlistScanResult {
  const res: AllowlistScanResult = { filesScanned: 0, rulesScanned: 0, newSightings: 0, escalated: 0, notes: [] };

  // Project-local settings under consented work roots: the repo-carried rules.
  const targets = allowlistTargets();
  for (const root of workRoots) {
    for (const rel of ['.claude/settings.local.json', '.claude/settings.json']) {
      const p = join(root, rel);
      if (!existsSync(p)) continue;
      targets.push({ path: p, rules: jsonRules(readFileSync(p, 'utf8'), (parsed) => {
        const perms = parsed.permissions as Record<string, unknown> | undefined;
        return [...(perms?.allow as unknown[] ?? []), ...(perms?.deny as unknown[] ?? []), ...(perms?.ask as unknown[] ?? [])];
      }) });
    }
  }

  const upsert = db.prepare(`
    INSERT INTO secret_sightings
      (fingerprint, detector, sink_key, path, byte_offset, byte_length, direction, status,
       first_seen, last_seen, occurrences, provider)
    VALUES (?, ?, ?, ?, ?, ?, 'at_rest', ?, ?, ?, 1, NULL)
    ON CONFLICT(fingerprint, sink_key) DO UPDATE SET
      last_seen   = excluded.last_seen,
      occurrences = COALESCE(secret_sightings.occurrences, 1) + 1`);
  const seen = db.prepare('SELECT 1 FROM secret_sightings WHERE fingerprint = ? AND sink_key = ?');

  for (const t of targets) {
    res.filesScanned++;
    const trackedState = gitTrackedState(t.path);
    for (let i = 0; i < t.rules.length; i++) {
      res.rulesScanned++;
      const rule = t.rules[i]!;
      const findings = scanBuffer(asContent(rule), 0);
      if (!findings.length) continue;
      const sinkKey = `allowlist:${t.path}`;
      for (const s of findings) {
        const f = fp(s.value, now);
        if (!seen.get(f, sinkKey)) res.newSightings++;
        upsert.run(f, s.detector, sinkKey, `${t.path}#rule:${i}`, s.byteOffset, s.byteLength,
          classifyStatus(t.path), now, now);
        if (trackedState === 'tracked') {
          // The escalation the spec names: the carrying file is in git, so the
          // credential rides every clone of the repo. Critical, quoted, idempotent.
          const lsOut = spawnSync('git', ['-C', dirname(t.path), 'ls-files', t.path], { encoding: 'utf8', timeout: 4000 });
          insertAnomalies(db, [{
            anomaly_key: `secret_at_rest:allowlist:${f}`,
            rule: 'secret_at_rest',
            severity: 'critical',
            tool: 'claude_code',
            session_id: null,
            model: null,
            window_start: now,
            window_end: now,
            title: `Credential in a git-tracked permission allowlist (${s.detector})`,
            detail:
              `A ${s.detector.replace(/-/g, ' ')} shape sits in rule ${i} of ${t.path.replace(/^\/Users\/[^/]+/, '~')}, ` +
              `and that file is TRACKED in its git repository (git ls-files: ${(lsOut.stdout ?? '').trim() || t.path}). ` +
              `The value is NOT stored — only its fingerprint; open the sighting to re-read the rule in place.`,
            observed: 1,
            baseline: null,
            threshold: null,
            confidence: 'exact',
            source: 'live',
            detected_at: now,
          }]);
          res.escalated++;
        }
      }
    }
    if (trackedState === 'tracked') {
      res.notes.push(`${t.path.replace(/^\/Users\/[^/]+/, '~')}: git-tracked allowlist file`);
    }
  }
  return res;
}
