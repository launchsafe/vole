import { Database } from '../sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths';
import type { DB } from '../db';
import type { CollectorResult, UsageEvent } from '../types';

/**
 * Devin (Cognition) — activity only. NO TOKEN DATA EXISTS LOCALLY.
 *
 * Devin's editor stores its ACP conversation under
 * ~/Library/Application Support/Devin/User/acp-messages/<uuid>.db — a `messages` table
 * of (position, kind, payload). The payloads are pure content (agent_message,
 * agent_thought, tool_call, user_message); there is no usage, token or model field
 * anywhere. Devin's agent runs on Cognition's servers and its token accounting stays
 * there, exactly like Cursor and Antigravity.
 *
 * So we emit one `activity_only` row per agent turn (grouped by `turnId`), with a real
 * session id and timestamp and NULL tokens — never a guessed number.
 *
 * (The editor also bundles the anthropic.claude-code extension; those runs are covered
 * by the Claude Code collector via ~/.claude and are not double-counted here.)
 */

interface Content {
  _meta?: Record<string, string>;
}

interface Payload {
  turnId?: string;
  // Real ACP rows vary by kind: agent_message payloads carry an array of
  // chunks, tool_call payloads carry a single content OBJECT. Normalize both.
  content?: Content[] | Content;
}

/** content as a list, whatever shape the row used. */
function contentList(p: Payload): Content[] {
  const c = p.content;
  if (Array.isArray(c)) return c;
  if (c && typeof c === 'object') return [c];
  return [];
}

/** The row's own timestamp, if any content element states one. */
function contentTimestamp(p: Payload): number | null {
  const iso = contentList(p)[0]?._meta?.['cognition.ai/timestamp'];
  const ts = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ts) ? null : ts;
}

export function collectDevin(_db: DB): CollectorResult {
  const dir = paths.devinAcpMessages();
  const events: UsageEvent[] = [];
  const notes: string[] = [];

  if (!existsSync(dir)) {
    return { tool: 'devin', events, filesScanned: 0, notes: [`No Devin data at ${dir}`], sourceState: 'no_source' };;
  }

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.db'));
  } catch (err) {
    return { tool: 'devin', events, filesScanned: 0, notes: [`Could not list ${dir}: ${(err as Error).message}`], sourceState: 'error' };
  }

  let failed = 0;
  for (const file of files) {
    const dbPath = join(dir, file);
    const sessionId = file.replace(/\.db$/, '');
    let mtime = Date.now(); // explicit fallback clock, only when stat fails
    try {
      mtime = statSync(dbPath).mtimeMs;
    } catch {
      /* keep now() */
    }

    let src: DB;
    try {
      src = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (err) {
      notes.push(`Could not open ${file} read-only: ${(err as Error).message}`);
      continue;
    }

    try {
      const rows = src
        .prepare(`SELECT position, kind, payload FROM messages ORDER BY position`)
        .all() as { position: number; kind: string; payload: string }[];

      // Streaming writes many agent_message chunks per turn; collapse to one row per turnId.
      const seen = new Set<string>();
      for (const r of rows) {
        let p: Payload;
        try {
          p = JSON.parse(r.payload) as Payload;
        } catch {
          continue;
        }

        if (r.kind !== 'agent_message') continue;

        const turn = p.turnId ?? `pos${r.position}`;
        if (seen.has(turn)) continue;
        seen.add(turn);

        const ts = contentTimestamp(p) ?? mtime;

        events.push({
          event_key: `devin:${sessionId}:${turn}`,
          tool: 'devin',
          model: null,
          session_id: sessionId,
          project: null,
          git_branch: null,
          ts,
          input_tokens: null,
          output_tokens: null,
          cache_write_5m_tokens: null,
          cache_write_1h_tokens: null,
          cache_read_tokens: null,
          reasoning_tokens: null,
          total_tokens: null,
          cost_usd: null,
          confidence: 'activity_only',
          is_error: 0,
          stop_reason: null,
          source: 'live',
          tools: null,
          agent_id: null,
          context_window: null,
      duration_ms: null, duration_kind: null,
          raw_ref: `${dbPath}#turn/${turn}`,
        });
      }
    } catch (err) {
      // Isolate the session. Without this the throw escaped collectDevin, and
      // collectAll's catch discarded the whole result — every turn already read
      // from every OTHER session in this pass went with it.
      notes.push(`Could not read ${file}: ${(err as Error).message}`);
      failed++;
    } finally {
      src.close();
    }
  }

  notes.push(`Devin records no token data locally; ${files.length} session(s) recorded as activity only.`);
  return {
    tool: 'devin',
    events,
    filesScanned: files.length,
    notes,
    // Partial reads are not a clean pass: say so rather than reporting ok.
    sourceState: failed > 0 ? 'error' : undefined,
  };
}
