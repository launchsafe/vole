import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { paths } from '../paths';
import type { DB } from '../db';
import { Database } from '../sqlite';
import type { CollectorResult, UsageEvent } from '../types';

/** Same resolution rule as paths.ts: an override root wins, else the real home. */
const home = () => process.env.VOLE_HOME_OVERRIDE ?? homedir();

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

// ── BYOK token extraction (tier 2 #32) ──────────────────────────────────────
//
// None of the three BYOK agents exists on the reference machine, so every parse
// below is keyed to the field names the spec documents and degrades to an
// activity_only row (or nothing) when a shape does not match — an unverified
// format renders 'unverified' in notes, never a guessed token count.

/** Token figures from a BYOK payload, wherever the agent put them. */
function byokTokens(o: Record<string, unknown>): { input: number | null; output: number | null; cacheRead: number | null } {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const u = (o.usage ?? o.tokens ?? o.token_usage ?? o.usageMetadata) as Record<string, unknown> | undefined;
  const src = (u && typeof u === 'object' ? u : o) as Record<string, unknown>;
  return {
    input: num(src.inputTokens) ?? num(src.input_tokens) ?? num(src.promptTokenCount) ?? num(src.prompt_tokens),
    output: num(src.outputTokens) ?? num(src.output_tokens) ?? num(src.candidatesTokenCount) ?? num(src.completion_tokens),
    cacheRead: num(src.cacheReadInputTokens) ?? num(src.cache_read_input_tokens) ?? num(src.cachedPromptTokenCount) ?? num(src.cached_prompt_tokens),
  };
}

function byokModel(o: Record<string, unknown>): string | null {
  const m = o.model ?? o.modelId ?? o.model_id ?? o.provider ?? null;
  return typeof m === 'string' ? m : null;
}

function byokSessionId(o: Record<string, unknown>, fallback: string): string {
  const s = o.sessionId ?? o.session_id ?? o.sessionID;
  return typeof s === 'string' && s ? s : fallback;
}

function byokTs(o: Record<string, unknown>, fileMtimeMs: number): number {
  const iso = o.timestamp ?? o.ts ?? o.createdAt ?? o.created_at ?? o.time;
  if (typeof iso === 'string') {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof iso === 'number' && Number.isFinite(iso) && iso > 0) return iso > 1e12 ? iso : iso * 1000;
  return Math.trunc(fileMtimeMs); // explicit fallback: the file's own clock
}

/** One row per measured BYOK turn; exact only where the source states figures. */
function byokRow(
  tool: UsageEvent['tool'], key: string, o: Record<string, unknown>, rawRef: string, fileMtimeMs: number,
): UsageEvent | null {
  const { input, output, cacheRead } = byokTokens(o);
  if (input === null && output === null && cacheRead === null) return null;
  return {
    event_key: `${tool}:${key}`,
    tool,
    model: byokModel(o),
    session_id: byokSessionId(o, key),
    project: null,
    git_branch: null,
    ts: byokTs(o, fileMtimeMs),
    input_tokens: input,
    output_tokens: output,
    cache_write_5m_tokens: null,
    cache_write_1h_tokens: null,
    cache_read_tokens: cacheRead,
    reasoning_tokens: null,
    total_tokens: input !== null || output !== null ? (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) : null,
    cost_usd: null, // BYOK: the developer's own key, no published plan rate applies
    confidence: 'exact',
    is_error: 0,
    stop_reason: null,
    source: 'live',
    raw_ref: rawRef,
    tools: null,
    agent_id: null,
    context_window: null,
    duration_ms: null, duration_kind: null,
  };
}

// ── Goose: the spec's ~/.local/share store, tokens when stated ──────────────
export function collectGoose(_db: DB): CollectorResult {
  const candidates = [
    join(home(), '.local', 'share', 'goose', 'sessions', 'sessions.db'),
    join(home(), 'Library', 'Application Support', 'goose', 'sessions', 'sessions.db'),
  ];
  const dbPath = candidates.find(existsSync);
  if (dbPath) return collectGooseDb(dbPath);

  // Legacy fallback: the pre-~/.local/share layout (~/.goose) — session
  // records with no token ledger.
  const root = join(home(), '.goose', 'sessions');
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
            'goose', p.replace(home(), '~'), sessionMatch?.[1] ?? e.name,
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

/**
 * Goose's sessions.db: message rows whose payload JSON carries accumulated
 * tokens per provider/model. Table and column names are probed, not assumed —
 * an unrecognised schema yields zero rows plus a note ('unverified format'),
 * never a guessed figure.
 */
function collectGooseDb(dbPath: string): CollectorResult {
  const events: UsageEvent[] = [];
  const notes: string[] = [];
  let src: Database;
  try {
    src = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return { tool: 'goose', events, filesScanned: 0, notes: [`Could not open ${dbPath}: ${(err as Error).message}`] };
  }
  try {
    const tables = (src
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]).map((r) => r.name);
    let scanned = 0;
    for (const table of tables) {
      let cols: { name: string; type: string }[];
      let rows: Record<string, unknown>[];
      try {
        cols = src.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as { name: string; type: string }[];
        rows = src.prepare(`SELECT * FROM ${JSON.stringify(table)}`).all() as Record<string, unknown>[];
      } catch {
        continue;
      }
      scanned += rows.length;
      const textCols = cols.map((c) => c.name);
      const mtime = statSync(dbPath).mtimeMs;
      for (const [ri, row] of rows.entries()) {
        for (const col of textCols) {
          const v = row[col];
          if (typeof v !== 'string' || !v.startsWith('{')) continue;
          let o: Record<string, unknown>;
          try {
            o = JSON.parse(v) as Record<string, unknown>;
          } catch {
            continue;
          }
          const ev = byokRow('goose', `${table}:${row['id'] ?? row['rowid'] ?? ri}:${col}`, o, `${dbPath}#${table}/${col}`, mtime);
          if (ev) {
            // the row-level session id wins when the payload carries none
            const sid = row['session_id'] ?? row['sessionId'];
            if (typeof sid === 'string' && sid) ev.session_id = sid;
            events.push(ev);
          }
        }
      }
    }
    notes.push(`goose sessions.db: ${events.length} measured row(s) from ${tables.length} table(s) — unverified format`);
    return { tool: 'goose', events, filesScanned: 1, notes };
  } finally {
    src.close();
  }
}

// ── Amp: the spec's ~/.local/share/amp/threads, tokens and credits ───────────
export function collectAmp(_db: DB): CollectorResult {
  const root = join(home(), '.local', 'share', 'amp', 'threads');
  const legacy = join(home(), '.amp', 'sessions');
  if (!existsSync(root) && !existsSync(legacy)) {
    return { tool: 'amp', events: [], filesScanned: 0, notes: ['No Amp data'], sourceState: 'no_source' };
  }

  const events: UsageEvent[] = [];
  let files = 0;
  const notes: string[] = [];

  if (existsSync(root)) {
    const walk = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.json')) {
          files++;
          try {
            const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
            const mtime = statSync(p).mtimeMs;
            const objs = Array.isArray(parsed)
              ? (parsed as Record<string, unknown>[])
              : chatObjs(parsed);
            let measured = 0;
            for (const [i, o] of objs.entries()) {
              const ev = byokRow('amp', `${p.replace(home(), '~')}:${i}`, o, `${p}#${i}`, mtime);
              if (ev) {
                events.push(ev);
                measured++;
              }
            }
            if (measured === 0) {
              // A thread that exists but states no figures is still a fact of use.
              events.push(activityRow('amp', p.replace(home(), '~'), basenameNoExt(e.name),
                Math.trunc(mtime), p, null, 'amp thread (no token figures found)'));
            }
          } catch {
            notes.push(`Unreadable Amp thread at ${p}`);
          }
        }
      }
    };
    walk(root);
    return { tool: 'amp', events, filesScanned: files, notes };
  }

  // Legacy: the ~/.amp/sessions session list.
  for (const e of readdirSync(legacy, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const p = join(legacy, e.name);
    events.push(activityRow('amp', e.name, e.name.replace(/\D.*$/, '') || e.name,
      Math.trunc(statSync(p).mtimeMs), p, null, 'amp session (no tokens recorded)'));
  }
  return { tool: 'amp', events, filesScanned: events.length, notes };
}

function basenameNoExt(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

/** An object's message-bearing arrays, whichever key the format uses. */
function chatObjs(parsed: unknown): Record<string, unknown>[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const p = parsed as Record<string, unknown>;
  const out: Record<string, unknown>[] = [];
  for (const key of ['messages', 'thread', 'turns', 'history', 'events']) {
    if (Array.isArray(p[key])) {
      out.push(...(p[key] as Record<string, unknown>[]).filter((o) => o && typeof o === 'object'));
    }
  }
  return out;
}

// ── Continue: dev_data token events + session walk ──────────────────────────
export function collectContinue(_db: DB): CollectorResult {
  const roots = [
    join(home(), '.continue'),
    join(home(), '.local', 'share', 'continue'),
  ].filter(existsSync);
  if (roots.length === 0) {
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
          const mtime = statSync(p).mtimeMs;
          // dev_data/*.jsonl: tokensGenerated / chatInteraction / toolUsage
          // events — tokensGenerated is the one that carries figures.
          let measured = 0;
          const lines = text.split('\n').filter(Boolean);
          for (const [i, line] of lines.entries()) {
            let o: Record<string, unknown>;
            try {
              o = JSON.parse(line) as Record<string, unknown>;
            } catch {
              continue;
            }
            const kind = o.type ?? o.event ?? null;
            if (kind === 'tokensGenerated' || o.tokensGenerated !== undefined) {
              const ev = byokRow('continue', `${p.replace(home(), '~')}:${i}`, o, `${p}#${i}`, mtime);
              if (ev) {
                events.push(ev);
                measured++;
              }
            }
          }
          if (measured === 0) {
            const sessionId = text.match(/"sessionId"\s*:\s*"([^"]+)"/)?.[1] ?? basenameNoExt(e.name);
            events.push(activityRow('continue', `${p.replace(home(), '~')}#${sessionId}`, sessionId,
              Math.trunc(mtime), p, null, 'continue session (no tokens recorded)'));
          }
        } catch {
          /* unreadable: skip */
        }
      }
    }
  };
  for (const r of roots) walk(r);
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

// ── VS Code editor stores ─────────────────────────────────────────────────────
// Retired (tier 2 deep): the chat-session activity and Cline/Roo/Kilo task legs
// produced line-index event keys for the same stores the deep editor-stores
// scanner reads with inode:offset keys — dual-key duplicate rows. The deep
// scanner (scanners/editor-stores.ts) owns these stores now; this stub keeps
// the collector registry's coverage row honest.
export function collectVscodeStores(_db: DB): CollectorResult {
  return {
    tool: 'vscode_chat',
    events: [],
    filesScanned: 0,
    notes: ['editor stores owned by the editor-stores scanner (tier 2 deep)'],
  };
}

// ── Ollama local ─────────────────────────────────────────────────────────────
// Retired (tier 2 deep): the deep reader uses an '#activity'-suffixed cursor key
// so the rows coexist, but this bare collector_state source_path row duplicated
// them. scanners/editor-stores.ts owns the Ollama server log now.
export function collectOllamaLog(_db: DB): CollectorResult {
  return {
    tool: 'ollama_local',
    events: [],
    filesScanned: 0,
    notes: ['ollama log owned by the editor-stores scanner (tier 2 deep)'],
  };
}
