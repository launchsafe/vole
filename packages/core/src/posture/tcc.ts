import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db';
import { recordScanAccess, home } from './shared';

/**
 * os_grants: which AI app can read the screen and the keystrokes. The most
 * literal version of 'an agent read data from my system without permission'
 * is an AI desktop app holding Screen Recording or Accessibility — it sees
 * every window and every keystroke with no tool call, no MCP server and no
 * transcript to parse.
 *
 * Both TCC databases are opened read-only. Verified on a real machine that
 * BOTH refuse without Full Disk Access — so the refusal is recorded as a
 * scan_access denial (a permission fact), never rendered as 'no grants'.
 */

export const TCC_SERVICES = [
  'kTCCServiceScreenCapture',
  'kTCCServiceAccessibility',
  'kTCCServiceListenEvent',
  'kTCCServicePostEvent',
  'kTCCServiceSystemPolicyAllFiles',
  'kTCCServiceMicrophone',
] as const;

export interface TccGrant {
  db_path: 'system' | 'user';
  service: string;
  client: string;
  client_type: number | null;
  auth_value: number | null;
  auth_reason: number | null;
  last_modified: number | null;
}

/** Bundle-id / path fragments of AI desktop apps. Everything else in the table
 *  is out of scope for this ledger — a full TCC browser is a different product. */
const AI_APP_MATCHERS: RegExp[] = [
  /anthropic/i, /claude/i, /openai/i, /chatgpt/i, /cursor/i, /windsurf/i,
  /kiro/i, /antigravity/i, /gemini/i, /copilot/i, /codeium/i, /continue\b/i,
  /perplexity/i, /raycast/i, /warp/i, /elevenlabs/i, /aider/i, /devin/i,
  /poeditor.*ai/i, /figma.*ai/i, /notion.*ai/i,
];

export function isAiApp(client: string, extraAiSurfaces: string[] = []): boolean {
  const c = client.toLowerCase();
  if (AI_APP_MATCHERS.some((re) => re.test(c))) return true;
  return extraAiSurfaces.some((s) => c.includes(s.toLowerCase()));
}

export function readTcc(path: string, dbPath: 'system' | 'user'): { rows: TccGrant[]; error: string | null } {
  if (!existsSync(path)) return { rows: [], error: 'ENOENT' };
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const stmt = db.prepare(
        `SELECT service, client, client_type, auth_value, auth_reason, last_modified
         FROM access WHERE service IN (${TCC_SERVICES.map(() => '?').join(',')})`,
      );
      const rows = stmt.all(...TCC_SERVICES) as Record<string, unknown>[];
      return {
        rows: rows.map((r) => ({
          db_path: dbPath,
          service: String(r.service),
          client: String(r.client),
          client_type: r.client_type == null ? null : Number(r.client_type),
          auth_value: r.auth_value == null ? null : Number(r.auth_value),
          auth_reason: r.auth_reason == null ? null : Number(r.auth_reason),
          last_modified: r.last_modified == null ? null : Number(r.last_modified),
        })),
        error: null,
      };
    } finally {
      db.close();
    }
  } catch (e) {
    return { rows: [], error: (e as NodeJS.ErrnoException).code ?? 'EUNKNOWN' };
  }
}

export function sweepOsGrants(db: DB, now: number): { grants: number; readable: number; denied: number } {
  const system = readTcc('/Library/Application Support/com.apple.TCC/TCC.db', 'system');
  const user = readTcc(join(home(), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db'), 'user');
  recordScanAccess(db, '/Library/Application Support/com.apple.TCC/TCC.db', 'os-grants', system.error, system.rows.length, now);
  recordScanAccess(db, join(home(), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db'), 'os-grants', user.error, user.rows.length, now);
  const readable = (system.error ? 0 : 1) + (user.error ? 0 : 1);

  // The AI-app census join: bundle ids and app names Vole already knows.
  const surfaces = db.prepare("SELECT name FROM ai_surfaces WHERE kind = 'app'").all() as { name: string }[];
  const upsert = db.prepare(`
    INSERT INTO grants (grant_key, agent, source_file, kind, entry, granted_by, path_class, origin, scope, first_seen, last_seen)
    VALUES (?, ?, ?, 'os_tcc', ?, ?, 'managed', 'os_default', 'device', ?, ?)
    ON CONFLICT(grant_key) DO UPDATE SET last_seen = excluded.last_seen`);
  let grants = 0;
  for (const r of [...system.rows, ...user.rows]) {
    if (!isAiApp(r.client, surfaces.map((s) => s.name))) continue;
    upsert.run(
      `os_tcc:${r.db_path}:${r.service}:${r.client}`,
      r.client,
      r.db_path === 'system' ? '/Library/Application Support/com.apple.TCC/TCC.db' : '~/Library/Application Support/com.apple.TCC/TCC.db',
      r.service,
      'macOS TCC access table',
      now, now,
    );
    grants++;
  }
  return { grants, readable, denied: 2 - readable };
}
