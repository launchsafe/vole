import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * tracked_state from .git/index (tier 6 §52): parse the DIRC binary directly
 * — header, version, entry count and entry path NAMES only, never a blob. No
 * git subprocess (works with git absent from PATH, cannot mutate the repo).
 * Supports index v2/v3 (NUL-padded entries) and v4 (prefix-compressed paths).
 * Anything else (v1, future) yields 'unknown', never a guessed answer.
 */

export interface ParsedGitIndex {
  version: number;
  entryCount: number;
  paths: string[];
  /** true when the version is understood but the buffer ended early */
  truncated: boolean;
}

/** git's decode_varint (varint.c): 7-bit groups, MSB = continue, +1 carry. */
function decodeVarint(buf: Buffer, off: number): { value: number; off: number } {
  let c = buf[off++]!;
  let val = c & 0x7f;
  while (c & 0x80) {
    val += 1;
    c = buf[off++]!;
    val = (val << 7) + (c & 0x7f);
    if (off > buf.length) break;
  }
  return { value: val, off };
}

export function parseGitIndex(buf: Buffer): ParsedGitIndex | null {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'DIRC') return null;
  const version = buf.readUInt32BE(4);
  const entryCount = buf.readUInt32BE(8);
  const out: ParsedGitIndex = { version, entryCount, paths: [], truncated: false };
  if (version < 2 || version > 4) return { ...out, paths: [], truncated: true };
  let off = 12;
  let prev = '';
  for (let i = 0; i < entryCount; i++) {
    if (off + 62 > buf.length) {
      out.truncated = true;
      break;
    }
    const entryStart = off;
    off += 60; // ctime(8) mtime(8) dev ino mode uid gid size(24) + sha1(20)
    const flags = buf.readUInt16BE(off);
    off += 2;
    const nameLen = flags & 0x0fff;
    const extended = (flags & 0x4000) !== 0 && version >= 3;
    if (extended) off += 2;
    if (version === 4) {
      const strip = decodeVarint(buf, off);
      off = strip.off;
      const nul = buf.indexOf(0, off);
      if (nul < 0) {
        out.truncated = true;
        break;
      }
      const suffix = buf.toString('utf8', off, nul);
      prev = prev.length >= strip.value ? prev.slice(0, prev.length - strip.value) + suffix : suffix;
      out.paths.push(prev);
      off = nul + 1; // v4 entries are NOT padded
    } else {
      let path: string;
      if (nameLen < 0x0fff) {
        path = buf.toString('utf8', off, off + nameLen);
        off += nameLen;
      } else {
        const nul = buf.indexOf(0, off);
        if (nul < 0) {
          out.truncated = true;
          break;
        }
        path = buf.toString('utf8', off, nul);
        off = nul + 1;
      }
      out.paths.push(path);
      // v2/v3: entry padded with NULs to a multiple of 8, at least one NUL.
      const used = off - entryStart;
      off = entryStart + Math.ceil((used + 1) / 8) * 8;
    }
    if (off > buf.length) {
      out.truncated = true;
      break;
    }
  }
  return out;
}

// ── .git resolution (dir or gitdir-pointer file) ────────────────────────────

export function resolveGitDir(rootPath: string): string | null {
  const dot = join(rootPath, '.git');
  if (!existsSync(dot)) return null;
  try {
    if (statSync(dot).isDirectory()) return dot;
    const m = /^gitdir:\s*(\S+)/m.exec(readFileSync(dot, 'utf8'));
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/** HEAD's ref label (spec §52: the index's companion display field). */
export function headRef(rootPath: string): string | null {
  const git = resolveGitDir(rootPath);
  if (!git) return null;
  try {
    const head = readFileSync(join(git, 'HEAD'), 'utf8').trim();
    return head.startsWith('ref:') ? head.slice(5).trim() : head.slice(0, 12);
  } catch {
    return null;
  }
}

// ── cached tracked-path set ─────────────────────────────────────────────────

export type TrackedState = 'tracked' | 'untracked' | 'unknown';

interface CacheEntry {
  mtime: number;
  size: number;
  paths: Set<string>;
}

const indexCache = new Map<string, CacheEntry>();

/**
 * The tracked set for a root, cached against the index's own mtime+size so an
 * unchanged index is not re-parsed (spec §52). No .git / unreadable / v1
 * index / parse failure => null, and the caller records 'unknown' — never a
 * defaulted 'untracked'.
 */
export interface TrackedSet {
  /** false when the index is missing, unreadable or an unsupported version */
  parsed: boolean;
  paths: Set<string>;
}

export function readTrackedPaths(rootPath: string): TrackedSet {
  const git = resolveGitDir(rootPath);
  if (!git) return { parsed: false, paths: new Set() };
  const idx = join(git, 'index');
  try {
    const st = statSync(idx);
    const cached = indexCache.get(idx);
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) {
      return { parsed: true, paths: cached.paths };
    }
    const parsed = parseGitIndex(readFileSync(idx));
    const paths = new Set(parsed?.paths ?? []);
    indexCache.set(idx, { mtime: st.mtimeMs, size: st.size, paths });
    // An empty but well-formed index is a legitimate 'tracked nowhere';
    // only a failed parse (null/truncated/unsupported) yields unknown.
    return { parsed: parsed !== null && !parsed.truncated, paths };
  } catch {
    return { parsed: false, paths: new Set() };
  }
}

/** tracked_state for one artifact rel-path (spec §52: tracked/untracked/unknown). */
export function trackedStateFor(relPath: string, tracked: TrackedSet): TrackedState {
  if (!tracked.parsed) return 'unknown';
  return tracked.paths.has(relPath) ? 'tracked' : 'untracked';
}

// ── ignore patterns (visibility_class + write_then_hide) ────────────────────

export interface IgnorePattern {
  pattern: string;
  source: string;
}

/**
 * Root-level ignore rules: `.gitignore` plus `.git/info/exclude`
 * (ponytail: nested .gitignore files are not merged — the ceiling is
 * root-level visibility only; upgrade to a full walk when a repo needs
 * per-directory rules).
 */
export function readIgnorePatterns(rootPath: string): IgnorePattern[] {
  const out: IgnorePattern[] = [];
  for (const [file, source] of [
    [join(rootPath, '.gitignore'), '.gitignore'],
    [join(rootPath, '.dockerignore'), '.dockerignore'],
    [join(rootPath, '.npmignore'), '.npmignore'],
  ] as const) {
    try {
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (t && !t.startsWith('#') && !t.startsWith('!')) out.push({ pattern: t, source });
      }
    } catch {
      /* absent: no patterns from this file */
    }
  }
  const git = resolveGitDir(rootPath);
  if (git) {
    try {
      for (const line of readFileSync(join(git, 'info', 'exclude'), 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (t && !t.startsWith('#') && !t.startsWith('!')) out.push({ pattern: t, source: '.git/info/exclude' });
      }
    } catch {
      /* absent */
    }
  }
  return out;
}

/**
 * gitignore-semantics match for a rel-path: a pattern containing '/' is
 * anchored at the root; a bare pattern matches any basename; a trailing '/'
 * matches directories (prefix match). Negations are excluded upstream.
 */
export function ignoreMatches(relPath: string, pattern: string): boolean {
  let p = pattern.replace(/^\/+/, '');
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = pattern.includes('/');
  if (dirOnly) {
    return relPath === p || relPath.startsWith(`${p}/`);
  }
  if (anchored) {
    if (relPath === p) return true;
    // A file pattern can also match inside a matched directory prefix.
    return p.includes('*') && new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(relPath);
  }
  // A bare pattern matches any PATH SEGMENT (a directory name hides its
  // contents; a file name hides itself) at any depth.
  const segs = relPath.split('/');
  return segs.some((seg) =>
    p.includes('*')
      ? new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`).test(seg)
      : seg === p,
  );
}

/** Which pattern (if any) hides a rel-path under this root. */
export function hidingPattern(relPath: string, patterns: IgnorePattern[]): IgnorePattern | null {
  for (const p of patterns) if (ignoreMatches(relPath, p.pattern)) return p;
  return null;
}
