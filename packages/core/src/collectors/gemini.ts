import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths';
import type { DB } from '../db';
import { recordPostureLever } from './ledger';
import type { CollectorResult, UsageEvent } from '../types';

/**
 * Gemini CLI (tier 2 #29) — two sources under ~/.gemini:
 *
 * 1. tmp/<project_hash>/chats/*.json: per-project conversations with token
 *    usage and tool executions per turn. One EXACT row per model turn, keyed
 *    gemini_cli:<project_hash>:<chat-id>:<turn-index> — model and token counts
 *    verbatim from the tool's own file. Gemini deletes chats after 30 days, so
 *    these totals carry that horizon and are never presented as lifetime.
 *
 * 2. tmp/<session>/stats.json: the per-session cumulative meter. Kept as the
 *    fallback row for sessions whose chats directory has aged out — the
 *    tokens-only-grow upsert keeps the two shapes consistent on totals.
 *
 * Posture: settings.json telemetry.logPrompts defaults to TRUE — a Gemini CLI
 * with logPrompts on writes full prompt text to a local file, a DLP surface the
 * company almost certainly does not know exists. Recorded as a posture_levers
 * row with the settings file as evidence; telemetry.outfile names the path when
 * set. Vole itself never reads the prompt files.
 */

interface GeminiStats {
  total_token_count?: number;
  models?: Record<string, unknown>;
}

/** The token fields Gemini CLI writes per turn, across the shapes it has used. */
function turnTokens(t: Record<string, unknown>): { input: number | null; output: number | null } {
  const u = (t.usage ?? t.tokenCount ?? t.tokens ?? t.usageMetadata) as Record<string, unknown> | undefined;
  const src = (u && typeof u === 'object' ? u : t) as Record<string, unknown>;
  const num = (...names: string[]): number | null => {
    for (const n of names) {
      const v = src[n];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  };
  return {
    input: num('inputTokens', 'input_tokens', 'promptTokenCount', 'prompt_tokens'),
    output: num('outputTokens', 'output_tokens', 'candidatesTokenCount', 'output_tokens', 'completion_tokens'),
  };
}

function turnModel(t: Record<string, unknown>): string | null {
  const m = t.model ?? t.modelId ?? t.model_id;
  return typeof m === 'string' ? m : null;
}

function turnTools(t: Record<string, unknown>): string[] {
  // Tool executions name the tool (functionCalls / toolExecutions / actions).
  const raw =
    (t.functionCalls ?? t.toolExecutions ?? t.actions ?? t.tools) as unknown[] | undefined;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const c of raw) {
    const name = c && typeof c === 'object' ? (c as Record<string, unknown>).name : null;
    if (typeof name === 'string' && name) names.push(name);
  }
  return names;
}

/** The chat file's turn list, across the shapes the CLI has written. */
function chatTurns(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed.filter((t) => t && typeof t === 'object') as Record<string, unknown>[];
  if (parsed && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>;
    for (const key of ['turns', 'history', 'messages', 'chat']) {
      if (Array.isArray(p[key])) return p[key]!.filter((t) => t && typeof t === 'object') as Record<string, unknown>[];
    }
  }
  return [];
}

function turnTs(t: Record<string, unknown>, fileMtime: number): number {
  const iso = t.timestamp ?? t.ts ?? t.createdAt ?? t.created_at;
  if (typeof iso === 'string') {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof iso === 'number' && Number.isFinite(iso) && iso > 0) return iso > 1e12 ? iso : iso * 1000;
  // explicit fallback: the file's own mtime, not the collector's clock
  return Math.trunc(fileMtime);
}

/** telemetry.logPrompts posture — the prompts-logged-to-disk fact, with evidence. */
function recordGeminiPosture(db: DB, geminiHome: string): void {
  const settingsPath = join(geminiHome, 'settings.json');
  if (!existsSync(settingsPath)) return;
  try {
    const s = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      telemetry?: { logPrompts?: boolean; outfile?: string | null };
    };
    if (s.telemetry?.logPrompts === undefined) return;
    recordPostureLever(db, {
      agent: 'gemini',
      lever: 'telemetry.logPrompts',
      observed_value: String(s.telemetry.logPrompts),
      source_file: settingsPath,
    });
    if (s.telemetry.outfile) {
      recordPostureLever(db, {
        agent: 'gemini',
        lever: 'telemetry.outfile',
        observed_value: s.telemetry.outfile,
        source_file: settingsPath,
      });
    }
  } catch {
    /* unreadable settings: no posture claim, never a guessed one */
  }
}

export function collectGemini(db: DB): CollectorResult {
  const geminiHome = paths.geminiHome();
  const root = join(geminiHome, 'tmp');
  const events: UsageEvent[] = [];
  const notes: string[] = [];

  if (!existsSync(root)) {
    return { tool: 'gemini', events, filesScanned: 0, notes: ['No Gemini CLI data'], sourceState: 'no_source' };
  }

  recordGeminiPosture(db, geminiHome);

  let sessions = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectHash = entry.name;
    const chatsDir = join(root, projectHash, 'chats');

    // 1. The per-turn ledger from the chats directory.
    if (existsSync(chatsDir)) {
      for (const chat of readdirSync(chatsDir, { withFileTypes: true })) {
        if (!chat.isFile() || !chat.name.endsWith('.json')) continue;
        const chatPath = join(chatsDir, chat.name);
        const chatId = chat.name.replace(/\.json$/, '');
        let parsed: unknown;
        let mtime: number;
        try {
          parsed = JSON.parse(readFileSync(chatPath, 'utf8'));
          mtime = statSync(chatPath).mtimeMs;
        } catch {
          notes.push(`Unreadable chat at ${chatPath}`);
          continue;
        }
        sessions++;
        for (const [i, turn] of chatTurns(parsed).entries()) {
          const { input, output } = turnTokens(turn);
          if (input === null && output === null) continue; // nothing measured on this turn
          const tools = turnTools(turn);
          events.push({
            event_key: `gemini_cli:${projectHash}:${chatId}:${i}`,
            tool: 'gemini',
            model: turnModel(turn),
            session_id: chatId,
            project: null,
            git_branch: null,
            ts: turnTs(turn, mtime),
            input_tokens: input,
            output_tokens: output,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            cache_read_tokens: null,
            reasoning_tokens: null,
            total_tokens: input !== null && output !== null ? input + output : (input ?? output),
            cost_usd: null, // no Gemini CLI rate is loaded
            confidence: 'exact',
            is_error: 0,
            stop_reason: null,
            source: 'live',
            raw_ref: `${chatPath}#${i}`,
            tools: tools.length ? tools.join(',') : null,
            agent_id: null,
            context_window: null,
            duration_ms: null, duration_kind: null,
          });
        }
      }
    }

    // 2. The cumulative stats meter — the fallback for aged-out chats.
    const statsFile = join(root, projectHash, 'stats.json');
    if (existsSync(statsFile)) {
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
        event_key: `gemini:${projectHash}`,
        tool: 'gemini',
        model: Object.keys(stats.models ?? {})[0] ?? null,
        session_id: projectHash,
        project: null,
        git_branch: null,
        ts: Math.trunc(statSync(statsFile).mtimeMs), // the file's own clock, never now()
        input_tokens: null,
        output_tokens: null,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        cache_read_tokens: null,
        reasoning_tokens: null,
        total_tokens: total,
        cost_usd: null, // no Gemini CLI rate is loaded
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
  }
  return { tool: 'gemini', events, filesScanned: sessions, notes };
}
