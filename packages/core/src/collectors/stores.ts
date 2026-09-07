import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { paths } from '../paths';
import type { DB } from '../db';
import { Database } from '../sqlite';
import type { CollectorResult, UsageEvent } from '../types';

/**
 * The BYOK and editor-store collectors: agents whose local artifacts prove that
 * a session happened, but carry no token figures. Every row is activity_only —
 * the call existed, nothing was measured — with the session id and the artifact
 * as evidence, so the People/Breakdown views can say "used", never "cost".
 */

/** One activity row: a call that happened, with nothing measured. */
function activityRow(
  tool: UsageEvent['tool'], key: string, sessionId: string | null, ts: number, rawRef: string,
  model: string | null = null, note?: string,
): UsageEvent {
  return {
    event_key: `${tool}:${key}`,
    tool,
    model,
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
    stop_reason: note ?? null,
    source: 'live',
    raw_ref: rawRef,
    tools: null,
    agent_id: null,
    context_window: null,
      duration_ms: null, duration_kind: null,
  };
}

// ── Aider: ~/.aider.chat.history.md + ~/.aider* — repo-side, per-worktree ─────
export function collectAider(_db: DB): CollectorResult {
  const home = homedir();
  const files = [
    join(home, '.aider.chat.history.md'),
    join(home, '.aider.chat.history.md.bak'),
    ...readdirSync(home, { withFileTypes: true })
      .filter((e) => e.name.startsWith('.aider.input'))
      .map((e) => join(home, e.name)),
  ].filter(existsSync);
  if (files.length === 0) {
    return { tool: 'aider', events: [], filesScanned: 0, notes: ['No Aider history'], sourceState: 'no_source' };
  }
  const events: UsageEvent[] = [];
  for (const f of files) {
    // One row per turn marker (# Your prompt: heading) — dated where stated.
    const text = readFileSync(f, 'utf8');
    const markers = [...text.matchAll(/^# {2,4}>? ?(.+)$/gm)];
    for (const [i, m] of markers.entries()) {
      const ts = statSync(f).mtimeMs;
      events.push(activityRow('aider', `${f}#${i}`, null, Math.trunc(ts), f, null, 'aider turn'));
    }
  }
  return { tool: 'aider', events, filesScanned: files.length, notes: [] };
}

// ── Goose: ~/.goose/sessions — session records, no tokens ───────────────────
export function collectGoose(_db: DB): CollectorResult {
  const root = join(homedir(), '.goose', 'sessions');
  if (!existsSync(root)) {
    return { tool: 'goose', events: [], filesScanned: 0, notes: ['No Goose sessions'], sourceState: 'no_source' };
  }
  const events: UsageEvent[] = [];
  let files = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl') || e.name.endsWith('.json')) {
        files++;
        try {
          const text = readFileSync(p, 'utf8');
          const sessionMatch = text.match(/"session_id"\s*:\s*"([^"]+)"/);
          events.push(activityRow(
            'goose', p.replace(homedir(), '~'), sessionMatch?.[1] ?? e.name,
            Math.trunc(statSync(p).mtimeMs), p, null, 'goose session (no tokens recorded)',
          ));
        } catch {
          /* unreadable: skip */
        }
      }
    }
  };
  walk(root);
  return { tool: 'goose', events, filesScanned: files, notes: [] };
}

// ── Amp: ~/.amp — session list, no tokens ───────────────────────────────────
export function collectAmp(_db: DB): CollectorResult {
  const root = join(homedir(), '.amp');
  if (!existsSync(root)) {
    return { tool: 'amp', events: [], filesScanned: 0, notes: ['No Amp data'], sourceState: 'no_source' };
  }
  const events: UsageEvent[] = [];
  const sessionsDir = join(root, 'sessions');
  if (existsSync(sessionsDir)) {
    for (const e of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const p = join(sessionsDir, e.name);
      events.push(activityRow('amp', e.name, e.name.replace(/\D.*$/, '') || e.name,
        Math.trunc(statSync(p).mtimeMs), p, null, 'amp session (no tokens recorded)'));
    }
  }
  return { tool: 'amp', events, filesScanned: events.length, notes: [] };
}

// ── Continue: ~/.continue/sessions + repo-side dev_data ─────────────────────
export function collectContinue(_db: DB): CollectorResult {
  const root = join(homedir(), '.continue');
  if (!existsSync(root)) {
    return { tool: 'continue', events: [], filesScanned: 0, notes: ['No Continue data'], sourceState: 'no_source' };
  }
  const events: UsageEvent[] = [];
  let files = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        files++;
        try {
          const text = readFileSync(p, 'utf8');
          const sessionId = text.match(/"sessionId"\s*:\s*"([^"]+)"/)?.[1] ?? e.name;
          events.push(activityRow('continue', `${p.replace(homedir(), '~')}#${sessionId}`, sessionId,
            Math.trunc(statSync(p).mtimeMs), p, null, 'continue session (no tokens recorded)'));
        } catch {
          /* unreadable: skip */
        }
      }
    }
  };
  walk(root);
  return { tool: 'continue', events, filesScanned: files, notes: [] };
}

// ── Copilot CLI: sessions with modelMetrics where present ────────────────────
export function collectCopilotCli(_db: DB): CollectorResult {
  const root = join(homedir(), '.copilot', 'sessions');
  if (!existsSync(root)) {
    return { tool: 'copilot_cli', events: [], filesScanned: 0, notes: ['No Copilot CLI sessions'], sourceState: 'no_source' };
  }
  const events: UsageEvent[] = [];
  let files = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        files++;
        try {
          for (const line of readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
            let entry: {
              type?: string; timestamp?: string; sessionId?: string;
              modelMetrics?: { model?: string; inputTokens?: number; outputTokens?: number; totalTokens?: number };
            };
            try {
              entry = JSON.parse(line);
            } catch {
              continue;
            }
            const m = entry.modelMetrics;
            if (entry.type !== 'session.shutdown' || !m) continue;
            const inTok = m.inputTokens ?? 0;
            const outTok = m.outputTokens ?? 0;
            events.push({
              event_key: `copilot_cli:${entry.sessionId ?? p}`,
              tool: 'copilot_cli',
              model: m.model ?? null,
              session_id: entry.sessionId ?? null,
              project: null,
              git_branch: null,
              ts: entry.timestamp ? Date.parse(entry.timestamp) : Math.trunc(statSync(p).mtimeMs),
              input_tokens: inTok || null,
              output_tokens: outTok || null,
              cache_write_5m_tokens: 0,
              cache_write_1h_tokens: 0,
              cache_read_tokens: null,
              reasoning_tokens: null,
              total_tokens: m.totalTokens ?? (inTok + outTok || null),
              cost_usd: null, // no Copilot-CLI metered rate is loaded
              confidence: (inTok + outTok) > 0 || m.totalTokens ? 'exact' : 'activity_only',
              is_error: 0,
              stop_reason: null,
              source: 'live',
              raw_ref: p,
              tools: null,
              agent_id: null,
              context_window: null,
      duration_ms: null, duration_kind: null,
            });
          }
        } catch {
          /* unreadable: skip */
        }
      }
    }
  };
  walk(root);
  return { tool: 'copilot_cli', events, filesScanned: files, notes: [] };
}

// ── VS Code editor stores: chat sessions + Cline/Roo/Kilo tasks ──────────────
export function collectVscodeStores(_db: DB): CollectorResult {
  const dbPath = join(homedir(), 'Library/Application Support/Code/User/globalStorage/state.vscdb');
  if (!existsSync(dbPath)) {
    return { tool: 'vscode_chat', events: [], filesScanned: 0, notes: ['No VS Code state database'], sourceState: 'no_source' };
  }
  const events: UsageEvent[] = [];
  const gsRoot = join(homedir(), 'Library/Application Support/Code/User/globalStorage');
  let files = 0;
  try {
    // The chat session index: one entry per chat, with timestamps — activity.
    const vscdb = new Database(dbPath, { readonly: true, fileMustExist: true });
    const raw = vscdb
      .prepare("SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'")
      .get() as { value: string } | undefined;
    vscdb.close();
    if (raw?.value) {
      files++;
      const index = JSON.parse(raw.value) as {
        entries?: Record<string, { sessionId?: string; lastMessageDate?: number; isEmpty?: boolean }>;
      };
      for (const [id, entry] of Object.entries(index.entries ?? {})) {
        if (entry.isEmpty) continue;
        events.push(activityRow('vscode_chat', id, entry.sessionId ?? id,
          entry.lastMessageDate ?? 0, `${dbPath}#chat:${id}`, null, 'vs code chat session'));
      }
    }
    // Cline / Roo / Kilo tasks: globalStorage/<ext>/tasks/*.json
    const TASK_EXT_DIRS = [/^saoudrizwan\.claude-dev/, /^rooveterinaryinc\.roo-cline/, /^kilocode\.kilo-code/];
    for (const e of readdirSync(gsRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || !TASK_EXT_DIRS.some((re) => re.test(e.name))) continue;
      const tasksDir = join(gsRoot, e.name, 'tasks');
      if (!existsSync(tasksDir)) continue;
      for (const t of readdirSync(tasksDir, { withFileTypes: true })) {
        if (!t.isDirectory()) continue;
        const ui = join(tasksDir, t.name, 'ui_messages.json');
        const ap = join(tasksDir, t.name, 'api_conversation_history.json');
        const src = existsSync(ui) ? ui : existsSync(ap) ? ap : null;
        if (!src) continue;
        files++;
        events.push(activityRow('clines', `${e.name}/${t.name}`, t.name,
          Math.trunc(statSync(src).mtimeMs), src, null,
          `${e.name.split('.')[0]} task (vendor totals, no per-call tokens)`));
      }
    }
  } catch {
    return { tool: 'vscode_chat', events, filesScanned: files, notes: ['state.vscdb unreadable'] };
  }
  if (files === 0) {
    return { tool: 'vscode_chat', events, filesScanned: 0, notes: ['No chat sessions or agent tasks in editor stores'], sourceState: 'no_source' };
  }
  return { tool: 'vscode_chat', events, filesScanned: files, notes: [] };
}

// ── Ollama local: activity rows from the runtime's own server log ────────────
export function collectOllamaLog(_db: DB): CollectorResult {
  const logPath = join(homedir(), '.ollama', 'logs', 'server.log');
  if (!existsSync(logPath)) {
    return { tool: 'ollama_local', events: [], filesScanned: 0, notes: ['No Ollama server log'], sourceState: 'no_source' };
  }
  const events: UsageEvent[] = [];
  try {
    const lines = readFileSync(logPath, 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      // Request lines name the model; the log carries no token figures.
      const m = line.match(/"?model"?[:=]\s*"?([\w:.\/-]+)"?/i);
      const ts = line.match(/^time="([^"]+)"/)?.[1];
      if (!m) continue;
      events.push(activityRow('ollama_local', `${i}`, null,
        ts ? Date.parse(ts) || 0 : 0, `${logPath}#${i}`, m[1] ?? null,
        'ollama local request (log carries no token figures)'));
      if (events.length > 2000) break; // a huge log is not a licence to hang the poll
    }
  } catch {
    return { tool: 'ollama_local', events, filesScanned: 1, notes: ['Ollama log unreadable'] };
  }
  return { tool: 'ollama_local', events: events.length ? events : [], filesScanned: 1, notes: [] };
}
