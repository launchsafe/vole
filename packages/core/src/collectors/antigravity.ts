import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths';
import type { DB } from '../db';
import type { CollectorResult, UsageEvent } from '../types';

/**
 * Antigravity — activity only. NO TOKEN DATA EXISTS LOCALLY.
 *
 * Two hard constraints, both verified on this machine:
 *   1. Antigravity is a flat-rate subscription product and exposes no client-readable
 *      per-token usage anywhere on disk.
 *   2. Its conversation payloads (~/.gemini/antigravity-ide/conversations/*.pb) are
 *      high-entropy encrypted blobs, not readable protobuf.
 *
 * The plaintext artifacts under brain/<conversation-id>/ prove a conversation happened,
 * so we emit one `activity_only` row per conversation — real session, real timestamp,
 * NULL tokens. We do NOT multiply a turn count by a guessed constant: that would be a
 * fabricated number, and this project reports token counts that are exact or not at all.
 */
export function collectAntigravity(_db: DB): CollectorResult {
  const brainRoot = paths.antigravityBrain();
  const convRoot = paths.antigravityConversations();
  const events: UsageEvent[] = [];
  const notes: string[] = [];

  if (!existsSync(brainRoot)) {
    return {
      tool: 'antigravity',
      events,
      filesScanned: 0,
      notes: [`No Antigravity data at ${brainRoot}`],
    };
  }

  let scanned = 0;
  for (const conversationId of readdirSync(brainRoot)) {
    const dir = join(brainRoot, conversationId);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    scanned++;

    const artifacts = readdirSync(dir);
    if (artifacts.length === 0) continue;

    // Prefer the conversation blob's mtime for timing; fall back to the brain dir.
    let ts = st.mtimeMs;
    const blob = join(convRoot, `${conversationId}.pb`);
    if (existsSync(blob)) {
      try {
        ts = statSync(blob).mtimeMs;
      } catch {
        /* keep brain-dir mtime */
      }
    }

    events.push({
      event_key: `antigravity:${conversationId}:${Math.round(ts)}`,
      tool: 'antigravity',
      model: null,
      session_id: conversationId,
      project: null,
      git_branch: null,
      ts: Math.round(ts),
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
      raw_ref: `${dir} (${artifacts.length} artifacts; no token data)`,
    });
  }

  notes.push(
    `Antigravity conversations are encrypted and expose no token counts; ${scanned} recorded as activity only.`,
  );
  return { tool: 'antigravity', events, filesScanned: scanned, notes };
}
