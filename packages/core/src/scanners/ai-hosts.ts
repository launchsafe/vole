import { readFileSync, existsSync, copyFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { Database } from '../sqlite';
import type { DB } from '../db';
import { openDb } from '../db';
import { paths } from '../paths';
import type { Scanner } from '../db';
import { upsertSurface } from './ai-surfaces';
import { CHROMIUM_ROOTS, chromiumProfiles } from './browser-grants';

/**
 * The Web-AI visit census (tier 2): hostname counts only. Opt-in and off by
 * default — VOLE_SCAN_WEB_AI=1 (an integration CLI flag sets it) — because it
 * reads the browser's own history store, the most sensitive file this tier
 * touches. Even when on, the read loop filters to the shipped ai-hosts pack
 * and keeps exactly three numbers per host: visit count, last visit, profile.
 * No URL, no title, no page content, ever.
 */

export interface AiHost {
  host: string;
  label: string;
}

let cachedHosts: AiHost[] | null = null;

/** The shipped allowlist (data/ai-hosts.json). Empty array = pack unreadable, census inert. */
export function loadAiHosts(): AiHost[] {
  if (cachedHosts) return cachedHosts;
  try {
    const raw = readFileSync(new URL('../data/ai-hosts.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { hosts?: AiHost[] };
    cachedHosts = parsed.hosts ?? [];
  } catch {
    cachedHosts = [];
  }
  return cachedHosts;
}

/** Chrome's timestamp: microseconds since 1601 → epoch ms via BigInt. */
export function chromeTimeToMs(t: string | number | null): number | null {
  if (t === null) return null;
  try {
    const v = typeof t === 'number' ? BigInt(Math.trunc(t)) : BigInt(t);
    return Number((v - 11644473600000000n) / 1000n);
  } catch {
    return null;
  }
}

export interface VisitRow {
  host: string;
  label: string;
  browser: string;
  profile: string;
  visits: number;
  lastVisitMs: number | null;
}

/**
 * One aggregate per host over `urls` — SUM(visit_count), MAX(last_visit_time) —
 * filtered inside the read loop to the pack. Read-only via immutable=1 first
 * (succeeds while the browser runs); falls back to copying History + WAL into
 * ~/.vole/tmp so Vole's write scope stays inside its own directory.
 */
export function countHostVisits(historyFile: string, hosts: AiHost[], browser: string, profile: string): VisitRow[] {
  const out: VisitRow[] = [];
  if (!existsSync(historyFile) || hosts.length === 0) return out;
  let db: Database | null = null;
  let tmp: string | null = null;
  try {
    db = new Database(historyFile, { readonly: true, fileMustExist: true });
  } catch {
    // Locked or otherwise unreadable in place: copy it (and its WAL) under ~/.vole.
    const dir = join(dirname(paths.db()), 'tmp');
    try {
      mkdirSync(dir, { recursive: true });
      tmp = join(dir, `history-${browser}-${profile.replace(/\W+/g, '_')}-${statSync(historyFile).ino}`);
      copyFileSync(historyFile, tmp);
      try {
        copyFileSync(`${historyFile}-wal`, `${tmp}-wal`);
      } catch {
        /* no WAL: fine */
      }
      db = new Database(tmp, { readonly: true, fileMustExist: true });
    } catch {
      return out; // an unreadable profile must read as absent, never as zero
    }
  }
  try {
    const q = db!.prepare(
      `SELECT SUM(visit_count) AS n, CAST(MAX(last_visit_time) AS TEXT) AS last
       FROM urls WHERE url LIKE 'https://' || ? || '/%' OR url LIKE 'https://' || ? || '%'`,
    );
    for (const { host, label } of hosts) {
      const row = q.get(host, host) as { n: number | null; last: string | null };
      if (!row.n) continue; // NULL sum = no visits, which reads as absent, never zero-use
      out.push({ host, label, browser, profile, visits: row.n, lastVisitMs: chromeTimeToMs(row.last) });
    }
  } catch {
    /* schema drift: skip */
  } finally {
    db?.close();
    if (tmp) {
      for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) {
        try {
          rmSync(f, { force: true });
        } catch {
          /* best effort */
        }
      }
    }
  }
  return out;
}

/**
 * The census pass. Gated: without VOLE_SCAN_WEB_AI=1 it reports skipped, which
 * is the deliberate default (convention: network-and-history reads are opt-in).
 */
export function scanAiHosts(): { ok: boolean; notes?: string } {
  if (process.env.VOLE_SCAN_WEB_AI !== '1') {
    return { ok: true, notes: 'Web-AI visit census opt-in: set VOLE_SCAN_WEB_AI=1 to enable' };
  }
  const db: DB = openDb();
  const now = Date.now();
  const home = homedir();
  const hosts = loadAiHosts();
  const surfaces = [];
  for (const [dir, browser] of CHROMIUM_ROOTS) {
    const root = join(home, 'Library/Application Support', dir);
    if (!existsSync(root)) continue;
    for (const profile of chromiumProfiles(root)) {
      for (const v of countHostVisits(join(root, profile, 'History'), hosts, browser, profile)) {
        surfaces.push({
          surface_key: `site:${v.host}`,
          kind: 'site' as const,
          name: `${v.label} (web)`,
          path: null,
          evidence:
            `${v.visits} visit(s) to ${v.host} in ${browser} ${profile} history, last ` +
            (v.lastVisitMs ? new Date(v.lastVisitMs).toISOString().slice(0, 10) : 'unknown') +
            ' — a visit is not usage: hostname counts only, no tokens, no cost, and incognito writes no row',
          version: null,
          extra: JSON.stringify({
            visits: v.visits, lastVisit: v.lastVisitMs, browser: v.browser, profile: v.profile, host: v.host,
          }),
          depth: { vendor: v.browser, evidence_kind: 'history_count', scanner: 'ai-hosts', confidence: 'exact' },
        });
      }
    }
  }
  for (const s of surfaces) upsertSurface(db, s, now);
  return {
    ok: true,
    notes: `${surfaces.length} Web-AI host row(s) across ${hosts.length} allowlisted host(s) — counts only, Vole reads no URL, title or page content`,
  };
}

export const aiHostsScanner: Scanner = {
  name: 'ai-hosts',
  cadenceMs: 30 * 60_000, // visit counts do not change in five minutes
  run: scanAiHosts,
};
