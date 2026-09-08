/**
 * Tier 3 — the AI-dictionary-gated shell-history scanner (feature 30).
 *
 * Shell history is the most privacy-charged read in the product, so it is a
 * mechanism, not a checkbox: DEFAULT OFF in both personal and managed mode,
 * enabled only by an explicit toggle, and its reader is two-pass — a byte
 * prefilter tests each window against the shipped AI dictionary and
 * non-matching windows are discarded WITHOUT EVER BEING DECODED to a string.
 *
 * What is stored: line-count watermarks over matched event names only
 * (surface_activity), never a command body, never a path from the history.
 * History is a lossy, editable record of one shell: a line proves a command
 * was typed, not that it ran or succeeded.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DB } from '../db';

/**
 * The shipped AI dictionary: provider hostnames, *_API_KEY name shapes and
 * known AI CLI names. Bytes only — a window is decoded to a string only after
 * at least one of these byte sequences matches inside it.
 */
export const AI_DICTIONARY: string[] = [
  'api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com', 'api.x.ai',
  'openrouter.ai', 'bedrock-runtime', 'aiplatform.googleapis.com', 'openai.azure.com',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY',
  'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'AWS_ACCESS_KEY_ID',
  'claude ', 'claude\n', 'codex ', 'codex\n', 'gemini ', 'grok ', 'opencode ', 'aider ',
  'ollama ', 'copilot ', 'goose ', 'amp ', 'continue ', 'cursor-agent ', 'cline ', 'avante ',
];

const WINDOW = 64 * 1024;

/** Default OFF. On only when the explicit toggle names this scanner. */
export function shellHistoryEnabled(): boolean {
  if (process.env.VOLE_SCAN_SHELL_HISTORY === '1') return true;
  if (process.env.VOLE_SCAN_SHELL_HISTORY === '0') return false;
  for (const f of [join('/Library', 'Application Support', 'Vole', 'scanners.json'), join(homedir(), '.vole', 'scanners.json')]) {
    if (!existsSync(f)) continue;
    try {
      const cfg = JSON.parse(readFileSync(f, 'utf8')) as { shell_history?: boolean };
      if (cfg.shell_history === true) return true;
    } catch {
      /* malformed layer */
    }
  }
  return false;
}

export interface ShellHistoryReceipt {
  ok: boolean;
  notes: string;
  bytes_read: number;
  windows_matched: number;
  /** Counters upserted into surface_activity — line watermarks, never bodies. */
  rows_stored: number;
}

export interface ShellHistorySink {
  /** Stable sink id — part of the surface_key, so it must never embed a timestamp. */
  key: string;
  path: string;
}

export function shellHistorySinks(home = homedir()): ShellHistorySink[] {
  return [
    { key: 'zsh', path: join(home, '.zsh_history') },
    { key: 'bash', path: join(home, '.bash_history') },
    { key: 'fish', path: join(home, '.local', 'share', 'fish', 'fish_history') },
    { key: 'claude-shell-snapshots', path: join(home, '.claude', 'shell-snapshots') },
  ];
}

/** The byte-window prefilter: which windows of a buffer mention the dictionary at all. */
export function matchingWindows(buf: Buffer): number[] {
  const matched: number[] = [];
  for (let off = 0; off < buf.length; off += WINDOW) {
    const slice = buf.subarray(off, off + WINDOW);
    if (AI_DICTIONARY.some((needle) => sliceIndexOf(slice, needle))) {
      matched.push(off);
    }
  }
  return matched;
}

function sliceIndexOf(slice: Buffer, needle: string): boolean {
  return slice.indexOf(Buffer.from(needle, 'utf8')) !== -1;
}

/**
 * One scan pass over every sink. Matched lines are counted per dictionary
 * CATEGORY (ai_cli / ai_host / api_key_name) as monotone counters in
 * surface_activity — event names only, no bodies. The byte watermark makes the
 * pass resumable and idempotent: only lines past the previous watermark are
 * counted, and re-running on an unchanged file stores nothing new.
 */
export function runShellHistoryScan(db: DB, sinks = shellHistorySinks(), enabled = shellHistoryEnabled()): ShellHistoryReceipt {
  if (!enabled) return { ok: true, notes: 'shell_history scanner is OFF (default; enable via ~/.vole/scanners.json or VOLE_SCAN_SHELL_HISTORY=1)', bytes_read: 0, windows_matched: 0, rows_stored: 0 };
  const upsert = db.prepare(`
    INSERT INTO surface_activity (surface_key, counter_kind, counter, watermark, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(surface_key, counter_kind) DO UPDATE SET
      counter = counter + excluded.counter,
      watermark = MAX(COALESCE(surface_activity.watermark, 0), excluded.watermark),
      last_seen = excluded.last_seen`);
  const now = Date.now();
  let bytes = 0;
  let windows = 0;
  let rows = 0;
  const notes: string[] = [];
  for (const sink of sinks) {
    if (!existsSync(sink.path)) continue;
    let buf: Buffer;
    try {
      buf = readFileSync(sink.path);
    } catch {
      notes.push(`${sink.key}: unreadable`);
      continue;
    }
    bytes += buf.length;
    const matched = matchingWindows(buf);
    windows += matched.length;
    const surfaceKey = `shell_history:${sink.key}`;
    let cliLines = 0;
    let hostLines = 0;
    let keyLines = 0;
    for (const off of matched) {
      const text = buf.subarray(off, off + WINDOW).toString('utf8'); // decoded only after a dictionary hit
      for (const line of text.split('\n')) {
        if (/_API_KEY/.test(line)) keyLines++;
        if (/api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|api\.x\.ai|openrouter\.ai|bedrock-runtime|aiplatform\.googleapis\.com|openai\.azure\.com/.test(line)) hostLines++;
        if (/(^|\s)(claude|codex|gemini|grok|opencode|aider|ollama|copilot|goose|amp|continue|cursor-agent|cline|avante)(\s|$)/.test(line)) cliLines++;
      }
    }
    if (cliLines > 0) { upsert.run(surfaceKey, 'ai_cli_lines', cliLines, buf.length, now, now); rows++; }
    if (hostLines > 0) { upsert.run(surfaceKey, 'ai_host_lines', hostLines, buf.length, now, now); rows++; }
    if (keyLines > 0) { upsert.run(surfaceKey, 'api_key_name_lines', keyLines, buf.length, now, now); rows++; }
  }
  return {
    ok: true,
    notes: notes.length ? notes.join(' | ') : `read ${bytes} byte(s), ${windows} matching window(s), ${rows} counter row(s) — line counts only, no command bodies`,
    bytes_read: bytes,
    windows_matched: windows,
    rows_stored: rows,
  };
}

/** The one-click erase: drops every derived row for this scanner. */
export function eraseShellHistoryRows(db: DB): number {
  return db.prepare("DELETE FROM surface_activity WHERE surface_key LIKE 'shell_history:%'").run().changes;
}
