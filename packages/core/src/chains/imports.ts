import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DB } from '../db';
import { insertAnomalies } from '../db';
import type { Anomaly } from '../types';
import { deviceKey } from '../identity';
import { paths } from '../paths';

/**
 * context_imports (tier 4 #135): one vendor's ENTIRE session handed to
 * another, proved by a receipt that outlives the file. Codex writes
 * ~/.codex/external_agent_session_imports.json when it ingests a foreign
 * agent's transcript into an OpenAI thread; every record carries the
 * source path and a content_sha256, so the transfer is provable after the
 * source file is gone — which it usually is.
 *
 * The receipt proves a file was imported and names its hash. It says nothing
 * about what the file contained, and once the source is gone source_bytes is
 * NULL and the content can never be re-derived: a transfer record, never a
 * leak verdict. Paths are HMAC'd (never stored), the sha256 is the vendor's
 * own, and the event key contains no clock-derived value, so polling is
 * idempotent.
 */

export interface ImportRecord {
  source_path: string;
  content_sha256: string;
  imported_thread_id: string;
  imported_at: number | null;
}

export interface ContextImportRow {
  event_key: string;
  source_tool: string;
  source_path_hmac: string | null;
  source_dir_prefix: string | null;
  content_sha256: string;
  dest_tool: string;
  dest_thread_id: string | null;
  imported_at: number | null;
  source_bytes: number | null;
  source_present: 0 | 1;
}

/** The source tool named by the path itself — a directory convention, not a guess about content. */
export function sourceToolOf(sourcePath: string): string {
  if (sourcePath.includes('/.claude/projects/')) return 'claude_code';
  if (sourcePath.includes('/.codex/')) return 'codex';
  if (sourcePath.includes('/opencode') || sourcePath.includes('/.local/share/opencode')) return 'opencode';
  if (sourcePath.includes('/.grok/')) return 'grok';
  if (sourcePath.includes('/.gemini/')) return 'gemini';
  if (sourcePath.includes('/.cursor/')) return 'cursor';
  return 'unknown';
}

/** HMAC of the source path — the same pseudonymisation shape as principal_key. */
export function pathHmac(p: string): string {
  return 'ph:' + createHmac('sha256', deviceKey()).update(p).digest('hex').slice(0, 32);
}

const IMPORT_UPSERT = `
INSERT INTO context_imports
  (event_key, source_tool, source_path_hmac, source_dir_prefix, content_sha256,
   dest_tool, dest_thread_id, imported_at, source_bytes, source_present)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(event_key) DO UPDATE SET
  source_present = excluded.source_present,
  source_bytes   = COALESCE(excluded.source_bytes, context_imports.source_bytes)`;

/** Parses the receipt file; tolerant of a bare array or a {records: []} envelope. */
export function parseImportReceipts(text: string): ImportRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { records?: unknown[] })?.records)
      ? (parsed as { records: unknown[] }).records
      : [];
  const out: ImportRecord[] = [];
  for (const r of list) {
    const rec = r as Partial<ImportRecord> & { imported_at?: string | number };
    if (typeof rec.source_path !== 'string' || typeof rec.content_sha256 !== 'string') continue;
    let at: number | null = null;
    if (typeof rec.imported_at === 'string') {
      const p = Date.parse(rec.imported_at);
      at = Number.isNaN(p) ? null : p;
    } else if (typeof rec.imported_at === 'number') {
      at = rec.imported_at > 1e12 ? rec.imported_at : rec.imported_at * 1000;
    }
    out.push({
      source_path: rec.source_path,
      content_sha256: rec.content_sha256,
      imported_thread_id: typeof rec.imported_thread_id === 'string' ? rec.imported_thread_id : '',
      imported_at: at,
    });
  }
  return out;
}

/**
 * Reads the receipt file and upserts one row per record. Fires
 * cross_vendor_context_import (warn) once per NEW receipt — not per pass.
 */
export function collectContextImports(db: DB, now = Date.now()): { rows: number; newRows: number; anomalies: number } {
  const file = join(paths.codexHome(), 'external_agent_session_imports.json');
  if (!existsSync(file)) return { rows: 0, newRows: 0, anomalies: 0 };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { rows: 0, newRows: 0, anomalies: 0 };
  }
  const records = parseImportReceipts(text);
  const upsert = db.prepare(IMPORT_UPSERT);
  const seen = db.prepare('SELECT 1 FROM context_imports WHERE event_key = ?');
  let newRows = 0;
  const anomalies: Anomaly[] = [];
  for (const r of records) {
    const eventKey = `codex:import:${r.content_sha256}`;
    const isNew = !seen.get(eventKey);
    let sourceBytes: number | null = null;
    let present = 0;
    try {
      const st = statSync(r.source_path);
      sourceBytes = st.size;
      present = 1;
    } catch { /* source gone: bytes NULL, presence 0 — the state chip's data */ }
    const row: ContextImportRow = {
      event_key: eventKey,
      source_tool: sourceToolOf(r.source_path),
      source_path_hmac: pathHmac(r.source_path),
      source_dir_prefix: dirname(r.source_path),
      content_sha256: r.content_sha256,
      dest_tool: 'codex',
      dest_thread_id: r.imported_thread_id || null,
      imported_at: r.imported_at,
      source_bytes: sourceBytes,
      source_present: present ? 1 : 0,
    };
    upsert.run(row.event_key, row.source_tool, row.source_path_hmac, row.source_dir_prefix,
      row.content_sha256, row.dest_tool, row.dest_thread_id, row.imported_at,
      row.source_bytes, row.source_present);
    if (isNew) {
      newRows++;
      anomalies.push({
        anomaly_key: `cross_vendor_context_import:${eventKey}`,
        rule: 'cross_vendor_context_import',
        severity: 'warn',
        tool: 'codex',
        session_id: row.dest_thread_id,
        model: null,
        window_start: row.imported_at ?? now,
        window_end: row.imported_at ?? now,
        title: `Cross-vendor context import: ${row.source_tool} → codex`,
        detail:
          `Codex imported an entire ${row.source_tool} session into OpenAI thread ${row.dest_thread_id ?? '(unknown id)'} ` +
          `on ${row.imported_at ? new Date(row.imported_at).toISOString() : 'an unknown date'}. ` +
          `The receipt names the source's sha256 (${r.content_sha256.slice(0, 16)}…) — never its content; ` +
          `the source file is ${present ? 'still on disk' : 'no longer on disk, so its bytes can never be re-derived'}.`,
        observed: 1,
        baseline: null,
        threshold: null,
        confidence: 'exact',
        source: 'live',
        detected_at: now,
      });
    }
  }
  const fired = anomalies.length ? insertAnomalies(db, anomalies).inserted.length : 0;
  return { rows: records.length, newRows, anomalies: fired };
}
