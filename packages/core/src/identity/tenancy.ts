/**
 * Tier 3 — device tenancy (feature 34) and design-partner pilot mode (32).
 *
 * On a reassigned laptop the new holder's first collect pass ingests the
 * predecessor's rollouts and brands them permanently, because the upsert never
 * rewrites `user`. The tenancy anchor bounds that: rows older than the anchor
 * predate this principal's tenancy and are quarantined as 'holder unknown',
 * never merged and never dropped silently.
 *
 * macOS keeps no record of who held the device before, and home-dir ctime is
 * reset by Migration Assistant and restores — every anchor is labelled with
 * its basis and treated as evidence, never proof.
 */
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DB } from '../db';
import { paths } from '../paths';
import { readClaudeJson } from './accounts';

export type TenancyBasis = 'claude_first_start' | 'apple_setup_done' | 'home_ctime';

export interface TenancyAnchor {
  ts: number;
  basis: TenancyBasis;
  /** Every anchor candidate we could see, so a screen can show what lost. */
  candidates: { basis: TenancyBasis; ts: number }[];
}

/**
 * The anchor, strongest-first for AI rows: when Claude was first configured
 * (no AI rows predate the tool existing), then .AppleSetupDone, then home
 * ctime. NULL when nothing on this machine dates the tenancy — the
 * quarantine is then inert, which must be visible, not defaulted.
 */
export function tenancyAnchor(home = homedir()): TenancyAnchor | null {
  const candidates: TenancyAnchor['candidates'] = [];
  const claude = readClaudeJson(home);
  if (claude?.firstStartTime) candidates.push({ basis: 'claude_first_start', ts: claude.firstStartTime });
  else if (claude?.claudeCodeFirstTokenDate) candidates.push({ basis: 'claude_first_start', ts: claude.claudeCodeFirstTokenDate });
  const setup = '/var/db/.AppleSetupDone';
  if (existsSync(setup)) {
    try {
      candidates.push({ basis: 'apple_setup_done', ts: Math.round(statSync(setup).ctimeMs) });
    } catch {
      /* unreadable */
    }
  }
  try {
    candidates.push({ basis: 'home_ctime', ts: Math.round(statSync(home).ctimeMs) });
  } catch {
    /* stat failed */
  }
  if (candidates.length === 0) return null;
  const order: Record<TenancyBasis, number> = { claude_first_start: 3, apple_setup_done: 2, home_ctime: 1 };
  candidates.sort((a, b) => order[b.basis] - order[a.basis]);
  return { ts: candidates[0]!.ts, basis: candidates[0]!.basis, candidates };
}

/**
 * 'N rows predate this principal's tenancy — excluded, holder unknown.' Counts
 * live rows older than the anchor; the count is the honest form because the
 * predecessor's identity is unknowable from this machine.
 */
export function preTenancyCount(db: DB, anchor: TenancyAnchor | null): number | null {
  if (!anchor) return null;
  return (
    db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE source = 'live' AND ts < ?").get(anchor.ts) as { n: number }
  ).n;
}

/** The quarantine itself: rows older than the anchor are excluded from a read. */
export function quarantinePreTenancy<T extends { ts: number }>(rows: T[], anchor: TenancyAnchor | null): T[] {
  if (!anchor) return rows;
  return rows.filter((r) => r.ts >= anchor.ts);
}

// ── feature 32: design-partner pilot mode with a hard expiry ────────────────

export interface PilotRecord {
  started_at: number;
  /** Hard expiry, epoch-ms. After this instant every pilot-only path is off. */
  until: number;
  partner: string;
  /** The exact feature set enabled for the pilot. */
  features: string[];
  policy_hash: string | null;
  set_by: string | null;
}

interface BasisFile {
  pilot?: PilotRecord[];
}

export const PILOT_FEATURES = ['content_scanners', 'sync', 'webhook'] as const;

/**
 * `vole pilot start --until=<date> --partner=<name>`: appends an append-only
 * record to ~/.vole/basis.json. Nothing is ever rewritten — history IS the
 * evidence — and the write is atomic (temp file + rename).
 */
export function pilotStart(opts: { until: string; partner: string; features?: string[]; policyHash?: string | null }, file = paths.basisRecord()): PilotRecord {
  const untilMs = Date.parse(opts.until);
  if (!Number.isFinite(untilMs)) throw new Error(`--until is not a date: ${opts.until}`);
  if (untilMs <= Date.now()) throw new Error(`--until is in the past: ${opts.until}`);
  let basis: BasisFile = {};
  if (existsSync(file)) {
    try {
      basis = JSON.parse(readFileSync(file, 'utf8')) as BasisFile;
    } catch {
      throw new Error(`basis.json at ${file} is malformed — refusing to append to it`);
    }
  }
  const record: PilotRecord = {
    started_at: Date.now(),
    until: untilMs,
    partner: opts.partner,
    features: opts.features ?? [...PILOT_FEATURES],
    policy_hash: opts.policyHash ?? null,
    set_by: (() => {
      try {
        return userInfo().username;
      } catch {
        return null;
      }
    })(),
  };
  basis.pilot = [...(basis.pilot ?? []), record];
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(basis, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  return record;
}

/** The newest pilot record, or null when none was ever started. */
export function pilotRecord(file = paths.basisRecord()): PilotRecord | null {
  if (!existsSync(file)) return null;
  try {
    const basis = JSON.parse(readFileSync(file, 'utf8')) as BasisFile;
    const list = basis.pilot ?? [];
    return list.length ? list[list.length - 1]! : null;
  } catch {
    return null;
  }
}

export interface PilotStatus {
  record: PilotRecord | null;
  active: boolean;
  days_remaining: number | null;
  /** Effective feature gates: after expiry, every pilot-only path reverts to off. */
  gates: Record<string, boolean>;
}

/**
 * The hard expiry. An expiry enforced by the same binary a determined admin
 * can replace is a control on the honest case — the banner and the
 * append-only record are the evidence, and this function makes the revert
 * automatic rather than a promise.
 */
export function pilotStatus(now = Date.now(), file = paths.basisRecord()): PilotStatus {
  const record = pilotRecord(file);
  if (!record) return { record: null, active: false, days_remaining: null, gates: {} };
  const active = now < record.until;
  const gates: Record<string, boolean> = {};
  for (const f of record.features) gates[f] = active;
  return {
    record,
    active,
    days_remaining: active ? Math.ceil((record.until - now) / 86_400_000) : 0,
    gates,
  };
}

/** Convenience: is one pilot-only path currently enabled? */
export function pilotGate(feature: string, now = Date.now(), file = paths.basisRecord()): boolean {
  return pilotStatus(now, file).gates[feature] === true;
}

/** The sha256 of a policy file's bytes — the version every incident can name. */
export function fileSha256(file: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}
