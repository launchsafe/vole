import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths';
import type { DB } from '../db';
import type { CollectorResult, UsageEvent } from '../types';
/**
 * Gemini CLI — exact tokens from the per-session stats file the CLI itself
 * writes (~/.gemini/tmp/<session>/stats.json, cumulative total_token_count).
 * One row per session per pass delta: the stats file is a METER, not an event
 * stream, so each new reading is the delta since the stored one, and re-reads
 * at the same value emit nothing.
 *
 * Posture note (Tier 4's concern, stated here because the file proves it):
 * Gemini CLI also logs full PROMPTS to disk under ~/.gemini/tmp. Vole reads the
 * stats file only and never touches those — the note names the fact, the code
 * keeps the boundary.
 */
interface GeminiStats {
  total_token_count?: number;
  models?: Record<string, unknown>;
}

export function collectGemini(_db: DB): CollectorResult {
  const root = join(paths.geminiHome(), 'tmp');
  const events: UsageEvent[] = [];
  const notes: string[] = [];

  if (!existsSync(root)) {
    return { tool: 'gemini', events, filesScanned: 0, notes: ['No Gemini CLI data'], sourceState: 'no_source' };
  }

  let sessions = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const statsFile = join(root, entry.name, 'stats.json');
    if (!existsSync(statsFile)) continue;
    sessions++;
    let stats: GeminiStats;
    try {
      stats = JSON.parse(readFileSync(statsFile, 'utf8')) as GeminiStats;
    } catch {
      notes.push(`Unreadable stats at ${statsFile}`);
      continue;
    }
    const total = stats.total_token_count ?? 0;
    if (total <= 0) continue;
    // The meter is cumulative per session; the row carries the full reading and
    // the store's tokens-only-grow upsert keeps it monotone. A session id is the
    // directory name — stable across re-reads.
    events.push({
      event_key: `gemini:${entry.name}`,
      tool: 'gemini',
      model: Object.keys(stats.models ?? {})[0] ?? null,
      session_id: entry.name,
      project: null,
      git_branch: null,
      ts: Date.now(),
      input_tokens: null,
      output_tokens: null,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: 0,
      cache_read_tokens: null,
      reasoning_tokens: null,
      total_tokens: total,
      cost_usd: null, // no xAI-free Gemini CLI rate is loaded
      confidence: 'exact',
      is_error: 0,
      stop_reason: null,
      source: 'live',
      raw_ref: statsFile,
      tools: null,
      agent_id: null,
      context_window: null,
      duration_ms: null, duration_kind: null,
    });
  }
  return { tool: 'gemini', events, filesScanned: sessions, notes };
}
