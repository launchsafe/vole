import { createHash } from 'node:crypto';

/**
 * Local helpers for the t6-repos-envelope cluster. Nothing here is exported
 * from the package barrel yet — the ones that graduate to shared vocabulary
 * (types.ts / paths.ts) are listed as integration needs.
 */

export function sha256hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Deterministic UTC day bucket (epoch-ms -> day index). Allowed in keys. */
export function dayBucket(ts: number): number {
  return Math.floor(ts / 86_400_000);
}

/**
 * Glob -> RegExp for path packs and asset path entries.
 * Supports `**` (any depth, also matching zero segments), `*` (one segment),
 * `?` (one char). No brace expansion — the packs never need it.
 */
export function globToRegex(glob: string): RegExp {
  // Split on `**` (zero or more full segments); everything else is literal
  // segment matching with `*` (one segment) and `?` (one char).
  const segs = glob.split('/').filter((s) => s.length > 0);
  const segRe = (s: string): string =>
    s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  const parts: string[][] = [];
  let cur: string[] = [];
  for (const s of segs) {
    if (s === '**') {
      parts.push(cur);
      cur = [];
    } else {
      cur.push(s);
    }
  }
  parts.push(cur);
  // `^/?` so the same relative pack matches both absolute and relative paths.
  return new RegExp(`^/?${parts.map((p) => p.map(segRe).join('/')).join('(?:[^/]+/)*')}$`);
}

/** Does `path` match a pack-style relative glob (anchored at any start)? */
export function relGlobMatch(path: string, glob: string): boolean {
  if (glob.includes('/')) return globToRegex(glob).test(path);
  return globToRegex(glob).test(path.split('/').pop() ?? '');
}

/**
 * Hand-written JSONC stripper: strips line and block comments and trailing
 * commas, preserving strings. No new dependency (the spec demands this).
 */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i]!;
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // Trailing commas before } or ]
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function parseJsonc<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(stripJsonc(text)) as T;
  } catch {
    return null;
  }
}

/**
 * Field-level structural diff of two JSON documents: emits the list of changed
 * key PATHS only, never values — a .claude.json backup can hold OAuth tokens,
 * so the diff line must never quote one. Arrays are compared as leaves (length
 * noted, contents never inspected).
 */
export function structDiff(a: unknown, b: unknown, prefix = ''): string[] {
  if (Array.isArray(a) || Array.isArray(b)) {
    const la = Array.isArray(a) ? a.length : null;
    const lb = Array.isArray(b) ? b.length : null;
    if (JSON.stringify(a) !== JSON.stringify(b)) return [prefix || '(root)'];
    return [];
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const out: string[] = [];
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) out.push(...structDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k));
    return out;
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix || '(root)'];
}

/** Host part of a `host:port` / URL / bare-host label. */
export function hostOf(label: string): string {
  let s = label.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = new URL(s).host;
  } catch {
    /* keep raw */
  }
  return (s.split('/')[0] ?? '').split(':')[0]!.toLowerCase();
}

export function portOf(label: string): string | null {
  const s = label.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      const p = new URL(s).port;
      return p || null;
    }
  } catch {
    /* fall through */
  }
  const head = s.split('/')[0] ?? '';
  const m = /:(\d+)$/.exec(head);
  return m ? m[1]! : null;
}

/** True when two hosts differ by exactly one label (the near-match shape). */
export function nearMatchHost(declared: string, observed: string): boolean {
  const a = declared.toLowerCase().split('.');
  const b = observed.toLowerCase().split('.');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
  return diff === 1;
}

/** Documentation placeholders that look like production DSNs but are not. */
export function isPlaceholderTarget(label: string): boolean {
  // 'host:<port>' must be the LITERAL word host — real DSNs end in :25060 too.
  return /HOSTNAME_OR_IP_ADDRESS|<host>|example\.(com|org)|your-[^.\s]+-host|\bhost:\d+\b/i.test(label);
}
