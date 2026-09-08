import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { editorRoots, paths } from '../paths';
import { Database } from '../sqlite';
import { openDb } from '../db';
import type { DB, Scanner } from '../db';

/**
 * Deleted agent sessions (tier 2 feature 24), proved by the stores that
 * outlived them: Kiro's session-index jsonl remove-ops whose session directory
 * is now empty, and the editor's agent-host.db tombstone rows for sessions the
 * agent UI 'clear chat' removed. A deletion is not misconduct and the record
 * proves only that a session existed and stopped existing — never why, and
 * never its content. A zero in the Coverage strip's Deleted column must
 * therefore never read as 'nothing happened'.
 */

export interface DeletedSession {
  source: 'kiro' | 'agent-host';
  sessionId: string;
  removedAt: number | null;
  /** The surviving evidence that names the session. */
  evidence: string;
  stillOnDisk: boolean;
}

/** Kiro: op:'remove' rows in ~/.kiro/session-index/*.jsonl whose session dir is gone/empty. */
export function kiroDeletedSessions(kiroHome: string): DeletedSession[] {
  const out: DeletedSession[] = [];
  let files: string[];
  try {
    files = readdirSync(join(kiroHome, 'session-index')).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return out;
  }
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(kiroHome, 'session-index', f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec: { op?: string; sessionPath?: string; at?: number };
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        continue; // malformed index line: skip, never guess
      }
      if (rec.op !== 'remove' || typeof rec.sessionPath !== 'string') continue;
      const sessionId = rec.sessionPath.split('/').pop() ?? rec.sessionPath;
      const candidates = [join(kiroHome, rec.sessionPath), join(kiroHome, 'sessions', rec.sessionPath)];
      let entries: string[] | null = null;
      for (const dir of candidates) {
        try {
          entries = readdirSync(dir);
          break;
        } catch {
          /* not here */
        }
      }
      const stillOnDisk = entries !== null && entries.length > 0;
      if (!stillOnDisk) {
        out.push({
          source: 'kiro',
          sessionId,
          removedAt: typeof rec.at === 'number' ? rec.at : null,
          evidence: `~/.kiro/session-index/${f} op=remove sessionPath=${rec.sessionPath}`,
          stillOnDisk: false,
        });
      }
    }
  }
  return out;
}

/** The editor's agent-host.db: sessionTombstone:* metadata rows (+ backfill markers). */
export function agentHostDeletedSessions(dbPath: string): { deleted: DeletedSession[]; liveExternal: number | null } {
  const deleted: DeletedSession[] = [];
  let liveExternal: number | null = null;
  if (!existsSync(dbPath)) return { deleted, liveExternal };
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    if (tables.some((t) => t.name === 'metadata')) {
      const rows = db.prepare("SELECT key, value FROM metadata WHERE key LIKE 'sessionTombstone:%'").all() as { key: string; value: string | null }[];
      for (const r of rows) {
        const uuid = (r.key.split(':')[2] ?? r.key).replace(/^\//, '');
        deleted.push({
          source: 'agent-host',
          sessionId: uuid,
          removedAt: null, // tombstone rows carry no removal timestamp
          evidence: `agent-host.db metadata ${r.key}`,
          stillOnDisk: false,
        });
      }
    }
    // The double-count hazard: VS Code discovering and hosting Claude Code's own
    // sessions (external = 1, registration_source = 'discovery') — collectors
    // must dedupe on the uuid, so we surface the live count.
    const liveTable = tables.find((t) => t.name !== 'metadata');
    if (liveTable) {
      const cols = db.prepare(`PRAGMA table_info("${liveTable.name}")`).all() as { name: string }[];
      if (cols.some((c) => c.name === 'session_uri')) {
        liveExternal = (db.prepare(`SELECT COUNT(*) AS n FROM "${liveTable.name}" WHERE external = 1`).get() as { n: number }).n;
      }
    }
  } catch {
    /* unreadable agent-host.db: no rows, never a guess */
  } finally {
    db?.close();
  }
  return { deleted, liveExternal };
}

function upsertSurface(db: DB, s: DeletedSession, now: number): void {
  db.prepare(`
    INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, extra, scanner, first_seen, last_seen)
    VALUES (?, 'deleted_session', ?, ?, ?, ?, 'deleted-sessions', ?, ?)
    ON CONFLICT(surface_key) DO UPDATE SET
      last_seen = excluded.last_seen, evidence = excluded.evidence, extra = excluded.extra`).run(
    `deleted-session:${s.source}:${s.sessionId}`,
    `Deleted session ${s.sessionId} (${s.source})`,
    null,
    `${s.evidence} — the store that outlived it names a session that no longer exists; a deletion is what 'clear chat' does, never evidence of why`,
    JSON.stringify({ source: s.source, session_id: s.sessionId, removed_at: s.removedAt }),
    now,
    now,
  );
}

export const deletedSessionsScanner: Scanner = {
  name: 'deleted-sessions',
  cadenceMs: 15 * 60_000,
  run: () => {
    const db: DB = openDb();
    const now = Date.now();
    const kiro = kiroDeletedSessions(paths.kiroHome());
    for (const s of kiro) upsertSurface(db, s, now);
    let hosted = 0;
    let liveExternal: number | null = null;
    for (const r of editorRoots()) {
      const agentHost = join(r.root, 'User', 'globalStorage', 'agent-host.db');
      const { deleted, liveExternal: live } = agentHostDeletedSessions(agentHost);
      for (const s of deleted) upsertSurface(db, s, now);
      hosted += deleted.length;
      liveExternal = liveExternal ?? live;
    }
    return {
      ok: true,
      notes:
        `${kiro.length} Kiro deletion(s), ${hosted} agent-host tombstone(s)` +
        (liveExternal !== null ? ` · ${liveExternal} live external session(s) hosted by the editor — a double-count hazard collectors must dedupe on the uuid` : '') +
        ` — a deletion is not misconduct; each entry names the surviving evidence or states none remains`,
    };
  },
};
