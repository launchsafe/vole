/**
 * Tier 6 §80: approved-baseline snapshot and one-key drift diff.
 *
 * `vole posture baseline` (wired through the packs CLI here) writes the current
 * posture identities — MCP endpoint identities, hook command hashes, grant
 * entries, pack checksums — into a human-readable ~/.vole/baseline.json with a
 * capture timestamp. Every later pass diffs against it. A baseline captured
 * after a compromise blesses the compromise: the capture date travels with the
 * file and a matching state is never called 'secure'.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { DB } from '../db';
import { paths } from '../paths';

export interface BaselineItem {
  kind: string;
  identity: string;
  sha256: string;
}

export interface Baseline {
  captured_at: number;
  /** The tool versions in force at capture (pack registry state). */
  tool_versions: Record<string, string>;
  items: BaselineItem[];
}

export interface DriftRow {
  kind: string;
  identity: string;
  before: string | null;
  after: string | null;
  state: 'added' | 'removed' | 'changed';
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** The posture identities this machine can state right now. */
export function currentItems(db: DB): BaselineItem[] {
  const items: BaselineItem[] = [];
  const mcp = db
    .prepare('SELECT mcp_identity, transport, command, argv, url FROM posture_mcp_servers')
    .all() as { mcp_identity: string; transport: string | null; command: string | null; argv: string | null; url: string | null }[];
  for (const m of mcp) {
    items.push({
      kind: 'mcp_identity',
      identity: m.mcp_identity,
      sha256: sha([m.mcp_identity, m.transport ?? '', m.command ?? '', m.argv ?? '', m.url ?? ''].join('|')),
    });
  }
  const hooks = db
    .prepare('SELECT agent, hook_event, command_hash FROM hook_ledger')
    .all() as { agent: string; hook_event: string; command_hash: string }[];
  for (const h of hooks) {
    items.push({ kind: 'hook_command', identity: `${h.agent}:${h.hook_event}:${h.command_hash}`, sha256: h.command_hash });
  }
  const grants = db
    .prepare('SELECT grant_key, entry FROM grants')
    .all() as { grant_key: string; entry: string }[];
  for (const g of grants) items.push({ kind: 'grant', identity: g.grant_key, sha256: sha(g.entry) });
  const packs = db
    .prepare('SELECT kind, version, checksum FROM content_packs WHERE active = 1')
    .all() as { kind: string; version: number; checksum: string }[];
  for (const p of packs) items.push({ kind: 'content_pack', identity: `${p.kind}:v${p.version}`, sha256: p.checksum });
  return items;
}

/** Captures and writes the baseline. The confirm dialog's "what will be captured" is `currentItems` before the call. */
export function captureBaseline(db: DB, now: number = Date.now()): Baseline {
  const packs = db
    .prepare('SELECT kind, version FROM content_packs WHERE active = 1 ORDER BY kind')
    .all() as { kind: string; version: number }[];
  const b: Baseline = {
    captured_at: now,
    tool_versions: Object.fromEntries(packs.map((p) => [p.kind, `v${p.version}`])),
    items: currentItems(db),
  };
  writeFileSync(paths.baseline(), JSON.stringify(b, null, 2));
  return b;
}

export function readBaseline(): Baseline | null {
  const f = paths.baseline();
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as Baseline;
  } catch {
    return null;
  }
}

/** Diffs the current posture against the stored baseline. Read-only. */
export function driftDiff(db: DB, baseline: Baseline | null = readBaseline()): { baseline_captured_at: number | null; rows: DriftRow[] } {
  if (!baseline) return { baseline_captured_at: null, rows: [] };
  const before = new Map(baseline.items.map((i) => [`${i.kind}|${i.identity}`, i.sha256]));
  const after = new Map(currentItems(db).map((i) => [`${i.kind}|${i.identity}`, i.sha256]));
  const rows: DriftRow[] = [];
  for (const [key, hash] of after) {
    const prev = before.get(key);
    if (prev === undefined) rows.push({ kind: key.split('|')[0], identity: key.split('|').slice(1).join('|'), before: null, after: hash, state: 'added' });
    else if (prev !== hash) rows.push({ kind: key.split('|')[0], identity: key.split('|').slice(1).join('|'), before: prev, after: hash, state: 'changed' });
  }
  for (const [key, hash] of before) {
    if (!after.has(key)) rows.push({ kind: key.split('|')[0], identity: key.split('|').slice(1).join('|'), before: hash, after: null, state: 'removed' });
  }
  return { baseline_captured_at: baseline.captured_at, rows };
}
