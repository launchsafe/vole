import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DB } from '../db';
import type { PostureState } from './shared';

/**
 * The agent and AI-app binary signing ledger: who vouched for the code. One
 * read-only `codesign -dv --verbose=4` per executable, parsed into TeamIdentifier,
 * CDHash, authority, hardened-runtime and the ad-hoc/linker-signed flags —
 * cached on (path, size, mtime) so codesign only re-runs when the file actually
 * changed.
 *
 * codesign is a subprocess, the first external tool this product shells out
 * to: when it is absent or exits non-zero the row degrades to signature_kind
 * 'unknown' — NEVER 'unsigned', which would be a verdict. npm-installed JS CLIs
 * run under an unsigned interpreter and are 'not_applicable'.
 */

export interface CodesignFacts {
  identifier: string | null;
  team_id: string | null;
  authority: string | null;
  cdhash: string | null;
  hardened_runtime: boolean;
  signature_kind: 'developer_id' | 'apple' | 'adhoc' | 'not_applicable' | 'unknown';
}

export function parseCodesignOutput(text: string): CodesignFacts {
  const line = (k: string): string | null => text.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim() ?? null;
  const authority = [...text.matchAll(/^Authority=(.*)$/gm)].map((m) => m[1]!.trim())[0] ?? null;
  const flags = [...text.matchAll(/flags=([^\s)]+\)?)/g)].map((m) => m[1]!).join(' ');
  const kind: CodesignFacts['signature_kind'] =
    /adhoc|linker-signed/.test(flags) ? 'adhoc'
      : /Developer ID/.test(authority ?? '') ? 'developer_id'
        : /Apple Mac OS Application Signing|Software Signing/.test(authority ?? '') ? 'apple'
          : authority ? 'unknown' : 'unknown';
  return {
    identifier: line('Identifier'),
    team_id: line('TeamIdentifier'),
    authority,
    cdhash: line('CDHash'),
    hardened_runtime: /runtime/.test(flags),
    signature_kind: kind,
  };
}

/** A JS/script CLI runs under an unsigned interpreter: not a Mach-O, so codesign
 *  has nothing to say — recorded 'not_applicable', never 'unsigned'. */
export function isMachO(file: string): boolean | null {
  try {
    const fd = readFileSync(file).subarray(0, 4);
    const magic = fd.readUInt32BE(0);
    return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic);
  } catch {
    return null; // unreadable: unknown, never 'no'
  }
}

export function resolveBinary(name: string): string | null {
  try {
    const r = spawnSync('which', [name], { encoding: 'utf8', timeout: 4000 });
    if (r.status !== 0 || !r.stdout?.trim()) return null;
    try {
      return realpathSync(r.stdout.trim());
    } catch {
      return r.stdout.trim();
    }
  } catch {
    return null;
  }
}

/** The CLIs behind the collected agents. `which` + readlink resolution. */
export const AGENT_CLIS = ['claude', 'codex', 'opencode', 'gemini', 'grok', 'qwen', 'aider', 'amp', 'goose', 'cursor-agent'];

function codesignOnce(path: string): CodesignFacts | null {
  const macho = isMachO(path);
  if (macho === false) {
    return { identifier: null, team_id: null, authority: null, cdhash: null, hardened_runtime: false, signature_kind: 'not_applicable' };
  }
  try {
    const r = spawnSync('codesign', ['-dv', '--verbose=4', path], { encoding: 'utf8', timeout: 8000 });
    if (r.status !== 0 && !r.stderr) return null; // codesign absent or refused: unknown
    return parseCodesignOutput(r.stderr || r.stdout || '');
  } catch {
    return null;
  }
}

/**
 * The sweep: every resolved CLI binary plus every AI app already in the surface
 * census, cached in the posture state on (path, size, mtime). surface_key for
 * apps reuses the ai_surfaces key so the two ledgers join.
 */
export function sweepSigning(db: DB, state: PostureState, now: number): { binaries: number; adhoc: number } {
  state.signing ??= {};
  const targets: { surface_key: string; path: string }[] = [];
  for (const cli of AGENT_CLIS) {
    const p = resolveBinary(cli);
    if (p) targets.push({ surface_key: `cli:${cli}:${p}`, path: p });
  }
  for (const r of db.prepare("SELECT surface_key, path FROM ai_surfaces WHERE path LIKE '%.app' AND path IS NOT NULL").all() as { surface_key: string; path: string }[]) {
    targets.push({ surface_key: r.surface_key, path: r.path });
  }
  const upsert = db.prepare(`
    INSERT INTO signing_ledger (surface_key, team_id, cdhash, signature_kind, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(surface_key, cdhash) DO UPDATE SET last_seen = excluded.last_seen`);
  let adhoc = 0;
  for (const t of targets) {
    if (!existsSync(t.path)) continue;
    let st: { size: number; mtime: number };
    try {
      const s = statSync(t.path);
      st = { size: s.size, mtime: s.mtimeMs };
    } catch {
      continue;
    }
    const cached = state.signing[t.path];
    let facts: CodesignFacts | null;
    if (cached && cached.size === st.size && cached.mtime === st.mtime) {
      facts = { identifier: null, team_id: cached.row.team_id, authority: null, cdhash: cached.row.cdhash, hardened_runtime: false, signature_kind: cached.row.signature_kind as CodesignFacts['signature_kind'] };
    } else {
      facts = codesignOnce(t.path);
      if (facts) state.signing[t.path] = { size: st.size, mtime: st.mtime, row: { surface_key: t.surface_key, team_id: facts.team_id, cdhash: facts.cdhash, signature_kind: facts.signature_kind } };
    }
    if (!facts) continue;
    if (facts.signature_kind === 'adhoc' || facts.signature_kind === 'unknown') adhoc++;
    upsert.run(t.surface_key, facts.team_id, facts.cdhash, facts.signature_kind, now, now);
  }
  return { binaries: targets.length, adhoc };
}

/** App-bundle binary resolution is exported for the app-side reader: the
 *  Contents/Info.plist CFBundleExecutable under the .app. */
export function appExecutable(appDir: string): string | null {
  const plist = join(appDir, 'Contents', 'Info.plist');
  if (!existsSync(plist)) return null;
  try {
    const text = readFileSync(plist, 'utf8');
    return text.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? null;
  } catch {
    return null;
  }
}
