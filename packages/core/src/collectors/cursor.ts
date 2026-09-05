import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { paths } from '../paths';
import type { DB } from '../db';
import type { CollectorResult, UsageEvent } from '../types';

/**
 * Cursor — activity only. NO TOKEN DATA EXISTS LOCALLY.
 *
 * Verified on this machine: ~/.cursor/ai-tracking/ai-code-tracking.db has no token
 * columns at all. Its `ai_code_hashes` table records which code came from which model
 * and request (attribution for the AI-written-code percentage feature), and
 * globalStorage/state.vscdb holds no usage keys either. Cursor's token accounting lives
 * server-side behind its account, which this project will not touch.
 *
 * So these rows carry real models, sessions and timestamps with NULL tokens and
 * `confidence='activity_only'`. Estimating tokens from lines of code was considered and
 * rejected: it would be a fabricated number wearing an "estimated" badge.
 *
 * One row is emitted per requestId (a model call), not per code hash — 715 hashes on
 * this machine correspond to only 8 actual requests.
 */

interface HashRow {
  requestId: string | null;
  conversationId: string | null;
  model: string | null;
  firstTs: number | null;
  fileCount: number;
}

export function collectCursor(_db: DB): CollectorResult {
  const dbPath = paths.cursorTrackingDb();
  const events: UsageEvent[] = [];
  const notes: string[] = [];

  if (!existsSync(dbPath)) {
    return { tool: 'cursor', events, filesScanned: 0, notes: [`No Cursor tracking DB at ${dbPath}`] };
  }

  let src: Database.Database;
  try {
    // Read-only: Cursor may be running and holding this file.
    src = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return {
      tool: 'cursor',
      events,
      filesScanned: 0,
      notes: [`Could not open Cursor DB read-only: ${(err as Error).message}`],
    };
  }

  try {
    const rows = src
      .prepare(
        `SELECT requestId,
                conversationId,
                model,
                MIN(COALESCE(timestamp, createdAt)) AS firstTs,
                COUNT(*) AS fileCount
         FROM ai_code_hashes
         WHERE requestId IS NOT NULL
         GROUP BY requestId`,
      )
      .all() as HashRow[];

    for (const r of rows) {
      if (!r.requestId) continue;
      events.push({
        event_key: `cursor:${r.requestId}`,
        tool: 'cursor',
        model: r.model,
        session_id: r.conversationId,
        project: null,
        git_branch: null,
        ts: r.firstTs ?? Date.now(),
        // Every token field is NULL on purpose. Cursor does not record them.
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
        raw_ref: `${dbPath}#request:${r.requestId}`,
      });
    }
    notes.push('Cursor persists no token counts locally; rows are activity-only.');
  } catch (err) {
    notes.push(`Cursor query failed: ${(err as Error).message}`);
  } finally {
    src.close();
  }

  return { tool: 'cursor', events, filesScanned: 1, notes };
}
