/**
 * Tier 6: the pack plane registry — verified offline load, builtin floor,
 * two trust classes, managed-path precedence.
 *
 * A pack is a JSON file under a packPaths() root (managed first, per-user
 * second) with an optional detached `.sig`. Loading is strictly offline:
 * the only I/O is a local file read, and a pack whose signature does not
 * verify is REFUSED — never warn-and-load. The builtin floor (the compiled-in
 * DLP detector pack and pricing table) is always registered and cannot be
 * removed: a rejected or absent pack file means shipped content still runs,
 * never that detection silently stops.
 *
 * Trust classes (tier 6 §77):
 *   vendor_signed  — detached Ed25519 signature verifies under the vendor SPKI
 *                    pinned in the build (rotation via $VOLE_PACK_VENDOR_PUBKEY).
 *   admin_authored — signature verifies under the customer trust anchor
 *                    ($VOLE_PACK_ADMIN_PUBKEY or <managedRoot>/vole-admin.pub),
 *                    OR a root-owned unsigned file inside the managed root
 *                    (recorded as root_file_unsigned: tamper-evidence for
 *                    non-root users, never a defence against root).
 *   builtin_floor  — compiled into the app.
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db';
import { paths } from '../paths';
import { PACK_VERSION as DLP_VERSION, packChecksum } from '../dlp/pack';
import builtinPricing from '../data/pricing.json';
import { stampContentRev, requeueOnBump } from './rescore';
import { contentStaleRows } from './policy';
import { applySuppressionPack, type SuppressionEntry } from './suppression';

export type TrustClass = 'vendor_signed' | 'admin_authored' | 'builtin_floor' | 'user_override';
export type LoadState = 'loaded' | 'builtin' | 'rejected' | 'ignored_user_override';

export interface PackManifest {
  kind: string;
  version: number;
  /** Epoch-ms build date declared by the pack author (staleness is measured against it). */
  built_at?: number;
  /** Rollout ring (canary | preview | ga) — display metadata only. */
  ring?: string;
  entries?: unknown[];
  suppressions?: SuppressionEntry[];
  [k: string]: unknown;
}

export interface PackRecord {
  kind: string;
  version: number;
  /** sha256 over the pack bytes (canonical form for builtins). */
  checksum: string;
  built_at: number | null;
  ring: string | null;
  entry_count: number | null;
  trust: TrustClass;
  /** The base64 detached signature, when one verified. */
  signature: string | null;
  path: string | null;
  source: 'managed' | 'user' | 'builtin';
  load_state: LoadState;
  /** The literal refusal reason for rejected packs; the anchor note otherwise. */
  reason: string | null;
}

/**
 * The vendor's pinned Ed25519 SPKI (base64 DER). Generated for this tree; the
 * private half was discarded. ponytail: release engineering should regenerate
 * and pin the real release key before the first signed pack ships, and rotate
 * via $VOLE_PACK_VENDOR_PUBKEY.
 */
export const VENDOR_SPKI_B64 = 'MCowBQYDK2VwAyEArZ2FB5PhpUOpaOKA0RjacyUfnZwZPZyr58ff5sI05KA=';

/** Declared build date of the compiled-in packs. ponytail: stamp from the release version at build time. */
export const BUILTIN_BUILT_AT = Date.UTC(2026, 8, 7);

const vendorSpki = (): string | null => process.env.VOLE_PACK_VENDOR_PUBKEY ?? VENDOR_SPKI_B64;
const adminSpki = (): string | null => {
  if (process.env.VOLE_PACK_ADMIN_PUBKEY) return process.env.VOLE_PACK_ADMIN_PUBKEY;
  const f = join(paths.managedRoot(), 'vole-admin.pub');
  try {
    return readFileSync(f, 'utf8').trim() || null;
  } catch {
    return null;
  }
};

/** The two trust anchors in force (vendor pin, customer anchor). */
export function trustAnchors(): { vendor: string | null; admin: string | null } {
  return { vendor: vendorSpki(), admin: adminSpki() };
}

/** Ed25519 detached-signature check: 64 raw bytes, SPKI public key, no algorithm guesswork. */
export function verifyDetached(bytes: Buffer, sigB64: string, spkiB64: string): boolean {
  const sig = Buffer.from(sigB64, 'base64');
  if (sig.length !== 64) return false;
  try {
    return edVerify(null, bytes, createPublicKey({ key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki' }), sig);
  } catch {
    return false;
  }
}

/** Stable JSON for checksums: sorted keys, no whitespace. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** The two builtin floors. They are always registered and never removable. */
export function builtinPacks(): PackRecord[] {
  return [
    {
      kind: 'dlp_detectors', version: DLP_VERSION, checksum: packChecksum(), built_at: BUILTIN_BUILT_AT,
      ring: null, entry_count: null, trust: 'builtin_floor', signature: null, path: null,
      source: 'builtin', load_state: 'builtin', reason: null,
    },
    {
      kind: 'pricing', version: 1, checksum: createHash('sha256').update(canonicalJson(builtinPricing)).digest('hex'),
      built_at: BUILTIN_BUILT_AT, ring: null, entry_count: Object.keys((builtinPricing as { models: Record<string, unknown> }).models ?? {}).length,
      trust: 'builtin_floor', signature: null, path: null, source: 'builtin', load_state: 'builtin', reason: null,
    },
  ];
}

type Classification =
  | { ok: true; trust: 'vendor_signed' | 'admin_authored'; signature: string | null; reason: string | null }
  | { ok: false; reason: string };

/** Resolve the trust class of one pack file. A bad signature refuses the pack. */
function classify(path: string, bytes: Buffer, managedRootDir: string): Classification {
  const sigPath = `${path}.sig`;
  if (existsSync(sigPath)) {
    const sig = readFileSync(sigPath, 'utf8').trim();
    const v = vendorSpki();
    if (v && verifyDetached(bytes, sig, v)) return { ok: true, trust: 'vendor_signed', signature: sig, reason: null };
    const a = adminSpki();
    if (a && verifyDetached(bytes, sig, a)) return { ok: true, trust: 'admin_authored', signature: sig, reason: null };
    return { ok: false, reason: `signature invalid under every trust anchor (${sig.slice(0, 12)}…)` };
  }
  if (path.startsWith(managedRootDir)) {
    try {
      if (statSync(path).uid === 0) {
        return { ok: true, trust: 'admin_authored', signature: null, reason: 'root_file_unsigned' };
      }
      return { ok: false, reason: 'unsigned file in the managed root is not owned by root' };
    } catch {
      return { ok: false, reason: 'pack file could not be stat-ed' };
    }
  }
  return { ok: false, reason: 'unsigned pack outside the managed root' };
}

/** Read and verify one pack file. Never throws for content problems — returns a rejected record. */
export function loadPackFile(path: string, managedRootDir: string): PackRecord {
  const base: Omit<PackRecord, 'trust' | 'signature' | 'load_state' | 'reason'> = {
    kind: '', version: 0, checksum: '', built_at: null, ring: null, entry_count: null,
    path, source: path.startsWith(managedRootDir) ? 'managed' : 'user',
  };
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    return { ...base, trust: 'builtin_floor', signature: null, load_state: 'rejected', reason: `unreadable: ${(e as Error).message}` };
  }
  const checksum = createHash('sha256').update(bytes).digest('hex');
  // Parse first so a rejected pack still names its kind and version.
  let m: PackManifest | null = null;
  try {
    m = JSON.parse(bytes.toString('utf8')) as PackManifest;
  } catch {
    m = null;
  }
  const known: Omit<PackRecord, 'trust' | 'signature' | 'load_state' | 'reason'> = {
    ...base,
    checksum,
    kind: m && typeof m.kind === 'string' ? m.kind : '',
    version: m && Number.isInteger(m.version) ? m.version : 0,
    built_at: m && typeof m.built_at === 'number' ? m.built_at : null,
    ring: m && typeof m.ring === 'string' ? m.ring : null,
    entry_count: m && Array.isArray(m.entries) ? m.entries.length : null,
  };
  const rejected = (reason: string): PackRecord => ({ ...known, trust: 'builtin_floor', signature: null, load_state: 'rejected', reason });
  if (!m) return rejected('malformed JSON');
  if (typeof m.kind !== 'string' || !m.kind) return rejected('pack has no kind');
  if (!Number.isInteger(m.version) || m.version < 1) return rejected('pack version must be a positive integer');

  const c = classify(path, bytes, managedRootDir);
  if (!c.ok) return rejected(c.reason);
  return {
    ...known,
    trust: c.trust,
    signature: c.signature,
    load_state: 'loaded',
    reason: c.reason,
  };
}

/** All pack files on disk, verified, without touching the store. `dirs` overrides the roots (tests). */
export function discoverPacks(dirs?: [string, string]): PackRecord[] {
  const [managedDir, userDir] = dirs ?? (paths.packPaths() as [string, string]);
  const out: PackRecord[] = [];
  for (const dir of [managedDir, userDir]) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // unreadable pack root: absence is only provable for paths we can read
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.json') || name.endsWith('.json.sig') || name === 'load-state.json') continue;
      out.push(loadPackFile(join(dir, name), managedDir));
    }
  }
  return out;
}

/**
 * The load-state journal: rejected and ignored packs need a durable reason the
 * Settings → Content chip can read. Sidecar JSON in the per-user pack root
 * (the managed root is read-only). ponytail: promote to a content_packs
 * load_state column if a foundation migration opens.
 */
export function loadStatePath(): string {
  return join(paths.packPaths()[1], 'load-state.json');
}

function writeLoadState(records: PackRecord[], now: number): void {
  const interesting = records
    .filter((r) => r.load_state === 'rejected' || r.load_state === 'ignored_user_override')
    .map((r) => ({ path: r.path, sha256: r.checksum, state: r.load_state, reason: r.reason, ts: now }));
  if (interesting.length === 0) return;
  const file = loadStatePath();
  let prev: { path: string; sha256: string; state: string; reason: string | null; ts: number }[] = [];
  try {
    prev = JSON.parse(readFileSync(file, 'utf8')) as typeof prev;
  } catch {
    /* first write */
  }
  const seen = new Set(interesting.map((r) => `${r.path}|${r.sha256}`));
  const merged = [...prev.filter((p) => !seen.has(`${p.path}|${p.sha256}`)), ...interesting];
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(merged, null, 2));
}

export function readLoadState(): { path: string; sha256: string; state: string; reason: string | null; ts: number }[] {
  try {
    return JSON.parse(readFileSync(loadStatePath(), 'utf8')) as { path: string; sha256: string; state: string; reason: string | null; ts: number }[];
  } catch {
    return [];
  }
}

function upsertPackRow(db: DB, r: PackRecord, now: number, active: boolean): void {
  db.prepare(
    `INSERT INTO content_packs (kind, version, checksum, loaded_at, trust, signature, path, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, version) DO UPDATE SET
       loaded_at = MAX(content_packs.loaded_at, excluded.loaded_at),
       active    = MAX(content_packs.active, excluded.active),
       trust     = COALESCE(excluded.trust, content_packs.trust),
       signature = COALESCE(excluded.signature, content_packs.signature),
       path      = COALESCE(excluded.path, content_packs.path)`,
  ).run(r.kind, r.version, r.checksum, now, r.trust, r.signature, r.path, active ? 1 : 0);
}

export interface SyncResult {
  packs: PackRecord[];
  /** Kinds whose active version grew this pass, and the previous version. */
  bumps: { kind: string; from: number; to: number }[];
  requeued: number;
  staleInserted: number;
}

/**
 * The full pack-plane sync — call once per collector pass. Discovers and
 * verifies pack files, upserts the registry (builtin floors always), applies
 * managed-path precedence (a managed pack of a kind shadows the per-user file
 * for that kind), applies admin-pack suppression entries, stamps content_rev
 * and requeues DLP re-scans on a version bump, and writes content_stale rows.
 * Idempotent: re-running with the same files writes the same rows.
 */
export function registerPacks(db: DB, now: number = Date.now(), dirs?: [string, string]): SyncResult {
  const discovered = discoverPacks(dirs);
  const builtin = builtinPacks();

  const loaded = discovered.filter((r) => r.load_state === 'loaded');
  // Managed-path precedence: the first loaded pack of a kind (managed dir is
  // scanned first) wins; later user packs of the same kind are recorded but
  // ignored, with their checksum.
  const winners = new Map<string, PackRecord>();
  const rest: PackRecord[] = [];
  for (const r of loaded) {
    if (!winners.has(r.kind)) {
      winners.set(r.kind, r);
    } else {
      rest.push({ ...r, load_state: 'ignored_user_override', reason: `shadowed by the managed ${r.kind} pack; checksum retained` });
    }
  }

  // Bump detection happens against the store BEFORE we write the new rows.
  const bumps: { kind: string; from: number; to: number }[] = [];
  for (const [kind, r] of winners) {
    const prev = db
      .prepare('SELECT version FROM content_packs WHERE kind = ? AND active = 1 ORDER BY version DESC LIMIT 1')
      .get(kind) as { version: number } | undefined;
    if (prev && r.version > prev.version) bumps.push({ kind, from: prev.version, to: r.version });
  }

  for (const r of builtin) upsertPackRow(db, r, now, !winners.has(r.kind));
  for (const r of winners.values()) upsertPackRow(db, r, now, true);
  for (const r of rest) upsertPackRow(db, { ...r, trust: 'user_override' as TrustClass }, now, false);

  // Only the winning version of each file-pack kind stays active.
  for (const [kind, r] of winners) {
    db.prepare('UPDATE content_packs SET active = 0 WHERE kind = ? AND NOT (version = ? AND trust = ?)').run(kind, r.version, r.trust);
  }

  let requeued = 0;
  for (const b of bumps) {
    if (b.kind === 'dlp_detectors') {
      stampContentRev(db, b.from);
      requeued += requeueOnBump(db, b.to);
    }
  }

  // Suppression entries ship in admin_authored packs only — never vendor-signed.
  let suppressed = 0;
  for (const r of winners.values()) {
    if (r.trust !== 'admin_authored') continue;
    let m: PackManifest | null = null;
    try {
      m = JSON.parse(readFileSync(r.path as string, 'utf8')) as PackManifest;
    } catch {
      m = null;
    }
    if (m?.suppressions) suppressed += applySuppressionPack(db, m.suppressions, now);
  }

  const all = [...builtin, ...winners.values(), ...rest, ...discovered.filter((r) => r.load_state === 'rejected')];
  writeLoadState(all, now);
  const staleInserted = insertStaleRows(db, all.filter((r) => r.load_state !== 'rejected'), now);
  return { packs: all, bumps, requeued, staleInserted };
}

/** content_stale rows, written with their own insert (they are machine-level, not per-agent). */
function insertStaleRows(db: DB, packs: PackRecord[], now: number): number {
  const rows = contentStaleRows(packs, now);
  const ins = db.prepare(
    `INSERT INTO anomalies (anomaly_key, rule, severity, tool, session_id, model, window_start, window_end,
       title, detail, observed, baseline, threshold, confidence, source, detected_at, content_rev)
     VALUES (?, 'content_stale', ?, 'vole', NULL, NULL, ?, ?, ?, ?, ?, NULL, ?, 'exact', 'live', ?, ?)
     ON CONFLICT(anomaly_key) DO UPDATE SET
       severity   = CASE WHEN ? > CASE severity WHEN 'critical' THEN 2 WHEN 'warn' THEN 1 ELSE 0 END
                         THEN ? ELSE severity END,
       detected_at = CASE WHEN ? > CASE severity WHEN 'critical' THEN 2 WHEN 'warn' THEN 1 ELSE 0 END
                          THEN ? ELSE anomalies.detected_at END,
       content_rev = COALESCE(content_rev, ?)`,
  );
  const rank = (s: string) => (s === 'critical' ? 2 : s === 'warn' ? 1 : 0);
  let n = 0;
  for (const r of rows) {
    const res = ins.run(
      r.anomaly_key, r.severity, r.built_at, now, r.title, r.detail, r.age_days, r.floor_days,
      now, r.content_rev, rank(r.severity), r.severity, rank(r.severity), now, r.content_rev,
    );
    if (res.changes > 0) n++;
  }
  return n;
}

/** The active pack of a kind: highest active version, else the builtin floor. */
export function activePack(db: DB, kind: string): PackRecord {
  const row = db
    .prepare('SELECT kind, version, checksum, trust, signature, path FROM content_packs WHERE kind = ? AND active = 1 ORDER BY version DESC LIMIT 1')
    .get(kind) as { kind: string; version: number; checksum: string; trust: TrustClass; signature: string | null; path: string | null } | undefined;
  const builtin = builtinPacks().find((p) => p.kind === kind);
  if (!row) {
    return builtin ?? {
      kind, version: 0, checksum: '', built_at: null, ring: null, entry_count: null,
      trust: 'builtin_floor', signature: null, path: null, source: 'builtin', load_state: 'builtin', reason: null,
    };
  }
  return {
    kind: row.kind, version: row.version, checksum: row.checksum, built_at: builtin?.built_at ?? null,
    ring: null, entry_count: null, trust: row.trust, signature: row.signature, path: row.path,
    source: row.path?.startsWith(paths.packPaths()[0]) ? 'managed' : 'user',
    load_state: 'loaded', reason: null,
  };
}
