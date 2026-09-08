import type { DB } from '../db';
import { widenUpsert } from './upsert';

/**
 * fetch_ingress (feature 32): the untrusted web bytes entering a session, from
 * the four-field receipt Claude's WebFetch results already carry —
 * toolUseResult.{bytes, code, codeText, durationMs, url}. The hostname is
 * stored in clear because the hostname IS the finding. `bytes` is what the
 * fetcher received, not what entered the model's context (the tool truncates
 * before injection and never says by how much) — the row reports received
 * bytes and never a guess at the context-entered figure.
 */

export interface FetchIngressRow {
  call_key: string;
  url_host: string | null;
  status: number | null;
  bytes: number | null;
  ts: number | null;
}

/** Parse a WebFetch toolUseResult into an ingress row (null when it is not one). */
export function parseFetchIngress(toolUseResult: unknown, callKey: string, ts: number | null): FetchIngressRow | null {
  if (!toolUseResult || typeof toolUseResult !== 'object') return null;
  const r = toolUseResult as Record<string, unknown>;
  if (typeof r.url !== 'string' || (typeof r.bytes !== 'number' && typeof r.code !== 'number')) return null;
  let host: string | null = null;
  try {
    host = new URL(r.url).host;
  } catch {
    host = null; // a malformed URL is still an ingress event, with host unknown
  }
  return {
    call_key: callKey,
    url_host: host,
    status: typeof r.code === 'number' ? r.code : null,
    bytes: typeof r.bytes === 'number' ? r.bytes : null,
    ts,
  };
}

export function insertFetchIngress(db: DB, rows: FetchIngressRow[]): number {
  // NULL-in-UNIQUE would defeat idempotency for malformed-URL rows: key them ''.
  const keyed = rows.map((r) => ({ ...r, url_host: r.url_host ?? '' }));
  return widenUpsert(db, {
    table: 'fetch_ingress',
    keyCols: ['call_key', 'url_host'],
    cols: ['status', 'bytes', 'ts'],
  }, keyed);
}
