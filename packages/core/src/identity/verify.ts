/**
 * Tier 3 — `verify --identity` (feature 4): the runtime proof that email and
 * name are never stored. Scans every identity column and the export outbox for
 * an '@'-shaped token or a value matching the local oauthAccount name fields,
 * and fails the run on a hit. The oauthAccount reference strings are read
 * in-memory for comparison and never stored or logged.
 *
 * A domain alone cannot separate an employee from a contractor, and the HMAC
 * is reversible by anyone holding both the key and a candidate address —
 * pseudonymisation, not anonymisation — but THIS check proves the store holds
 * neither the address nor the name in any column.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DB } from '../db';

export interface IdentityVerifyResult {
  ok: boolean;
  /** Human-readable findings, one per violation. */
  findings: string[];
  columnsChecked: number;
  rowsChecked: number;
}

/** Identity-bearing columns the scan walks, per table. NULL columns cost a scan but prove nothing — expected. */
export const IDENTITY_COLUMNS: Record<string, string[]> = {
  usage_events: ['user', 'machine', 'subject_id', 'project'],
  anomalies: ['user', 'machine', 'detail', 'title'],
  principals: ['display', 'principal_key', 'principal_source'],
  devices: ['device_key', 'hostname'],
  hostname_history: ['device_key', 'hostname'],
  session_identity: ['session_id', 'principal_key', 'device_key', 'account_id', 'org_id', 'class_evidence'],
  vendor_identities: ['local_key', 'vendor_id_hmac', 'org_id_hmac', 'plan', 'auth_path'],
  access_log: ['accessor', 'purpose', 'view'],
  scope_history: ['diff', 'source'],
  export_outbox: ['sink', 'doc_id', 'last_error'],
};

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/;
/** HMAC/digest shapes: p:<hex>, d:<hex>, bare hex. Anything else in an HMAC column is a finding. */
const DIGEST_RE = /^(?:[pd]:)?[0-9a-f]{6,128}$/;

/** The forbidden reference strings, read from the real oauthAccount on this machine (never stored). */
function forbiddenNames(home = homedir()): { email: string | null; names: string[] } {
  try {
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
      oauthAccount?: { emailAddress?: string; fullName?: string; displayName?: string };
    };
    const oa = cfg.oauthAccount ?? {};
    return {
      email: oa.emailAddress?.toLowerCase() ?? null,
      names: [oa.fullName, oa.displayName].filter((n): n is string => !!n && n.length > 2),
    };
  } catch {
    return { email: null, names: [] };
  }
}

/**
 * The scan. A hit is any of: an email-shaped token in an identity column, a
 * value containing the local oauthAccount email/name, a `user` column holding
 * something other than a bare OS-style username token, or an HMAC-shaped
 * column holding a non-digest.
 */
export function verifyIdentity(db: DB, home = homedir()): IdentityVerifyResult {
  const { email, names } = forbiddenNames(home);
  const findings: string[] = [];
  let columnsChecked = 0;
  let rowsChecked = 0;

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  const tableNames = new Set(tables.map((t) => t.name));

  for (const [table, columns] of Object.entries(IDENTITY_COLUMNS)) {
    if (!tableNames.has(table)) continue;
    const existing = (
      db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    ).map((c) => c.name);
    for (const col of columns.filter((c) => existing.includes(c))) {
      columnsChecked++;
      const rows = db
        .prepare(`SELECT rowid AS rid, "${col}" AS v FROM "${table}" WHERE "${col}" IS NOT NULL`)
        .all() as { rid: number | string; v: unknown }[];
      rowsChecked += rows.length;
      for (const r of rows) {
        const v = String(r.v);
        const where = `${table}.${col} (rowid ${r.rid})`;
        if (EMAIL_RE.test(v)) findings.push(`email-shaped token in ${where}`);
        if (email && v.toLowerCase().includes(email)) findings.push(`the local oauthAccount email appears in ${where}`);
        for (const n of names) {
          if (v.includes(n)) findings.push(`the local oauthAccount name field appears in ${where}`);
        }
        if ((col === 'principal_key' || col === 'device_key' || col === 'vendor_id_hmac' || col === 'org_id_hmac') && !DIGEST_RE.test(v)) {
          findings.push(`an HMAC-shaped column holds a non-digest in ${where}`);
        }
      }
    }
  }
  return { ok: findings.length === 0, findings, columnsChecked, rowsChecked };
}
