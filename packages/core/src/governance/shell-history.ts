import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import type { DB } from '../db';
import { resolveScannerSwitch, userScannersFile } from './scanner-manifest';
import { appendScopeEvent } from './scope-history';

/**
 * The AI-dictionary-gated shell-history scanner (tier 3 #30).
 *
 * Shell history is the most privacy-charged read in the product, so it gets a
 * mechanism rather than a checkbox:
 *  - It appears in the shipped read manifest as `shell-history`, defaults OFF
 *    in both personal and managed mode, and is enabled only by an explicit
 *    toggle that writes who enabled it and when into the scope-change ledger.
 *  - Its reader is two-pass: a byte-window prefilter tests each window against
 *    the shipped AI dictionary (provider hostnames, *_API_KEY name shapes,
 *    known CLI names) and non-matching windows are discarded without ever
 *    being decoded to a string. Only a matching window is decoded, and even
 *    then what is stored is a count and a sha256 fingerprint of the matched
 *    lines — never the command text, never the arguments.
 *
 * History is a lossy, editable record of one shell, not of the machine:
 * HISTCONTROL and hist_ignore_space hide commands, a line proves a command was
 * typed rather than that it ran or succeeded, and timestamps exist only where
 * extended history is enabled.
 */

/** The shipped AI dictionary: byte patterns the prefilter hunts for. */
export const AI_DICTIONARY: readonly string[] = [
  // provider hostnames
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'api.groq.com',
  'openrouter.ai',
  'api.x.ai',
  'api.mistral.ai',
  'api.cohere.ai',
  'bedrock-runtime',
  'aiplatform.googleapis.com',
  'localhost:11434',
  // credential name shapes (names only, never values)
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'API_KEY=',
  // known AI CLI names
  'claude ',
  'claude\t',
  'codex ',
  'aider ',
  'ollama ',
  'gemini ',
  'qwen ',
  'gh copilot',
  'copilot ',
  'cursor-agent',
  'goose ',
];

export const SHELL_HISTORY_FILES: readonly string[] = [
  '~/.zsh_history',
  '~/.bash_history',
  '~/.local/share/fish/fish_history',
];

export function shellHistoryPaths(home = homedir()): string[] {
  return SHELL_HISTORY_FILES.map((p) => p.replace(/^~(?=\/)/, home));
}

export interface PrefilterReceipt {
  bytes: number;
  windows: number;
  windows_matched: number;
}

/**
 * Pass one: slide a byte window over the buffer and test it against the
 * dictionary with Buffer.indexOf — pure byte comparison, no decode. Windows
 * overlap by half so a pattern crossing a boundary cannot slip through.
 */
export function prefilter(buf: Buffer, windowBytes = 4096, dict: readonly string[] = AI_DICTIONARY): PrefilterReceipt {
  const stride = Math.max(1, Math.floor(windowBytes / 2));
  let windows = 0;
  let windows_matched = 0;
  for (let off = 0; off < Math.max(1, buf.length); off += stride) {
    const win = buf.subarray(off, Math.min(buf.length, off + windowBytes));
    windows++;
    let hit = false;
    for (const needle of dict) {
      if (win.indexOf(needle) !== -1) {
        hit = true;
        break;
      }
    }
    if (hit) windows_matched++;
    if (off + windowBytes >= buf.length) break;
  }
  return { bytes: buf.length, windows, windows_matched };
}

export interface ShellHistoryScanResult {
  ok: boolean;
  notes: string;
  receipt: { file: string; bytes_read: number; windows: number; windows_matched: number; lines_matched: number; rows_stored: number };
}

/**
 * Pass two (only for a matched file): decode, take the lines that hit the
 * dictionary, store ONE ai_surfaces row per history file carrying the byte
 * receipt and a sha256 fingerprint of the matched lines. The command text
 * itself never leaves this function.
 */
export function scanShellHistoryFile(
  db: DB,
  file: string,
  now = Date.now(),
  windowBytes = 4096,
): ShellHistoryScanResult {
  const base: ShellHistoryScanResult['receipt'] = {
    file,
    bytes_read: 0,
    windows: 0,
    windows_matched: 0,
    lines_matched: 0,
    rows_stored: 0,
  };
  if (!existsSync(file)) {
    return { ok: true, notes: `absent: ${file}`, receipt: { ...base, rows_stored: 0 } };
  }
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return { ok: false, notes: `unreadable: ${file}`, receipt: { ...base, rows_stored: 0 } };
  }
  const pre = prefilter(buf, windowBytes);
  base.bytes_read = pre.bytes;
  base.windows = pre.windows;
  base.windows_matched = pre.windows_matched;
  if (pre.windows_matched === 0) {
    return { ok: true, notes: `no AI-dictionary window in ${file} — nothing decoded, nothing stored`, receipt: { ...base, rows_stored: 0 } };
  }
  // Only now is the file decoded — and only the matched lines are kept, hashed, and dropped.
  const text = buf.toString('utf8');
  const matched = text.split('\n').filter((line) => AI_DICTIONARY.some((needle) => line.includes(needle)));
  base.lines_matched = matched.length;
  const fingerprint = createHash('sha256').update(matched.join('\n')).digest('hex');
  const surfaceKey = `shell_history:${file.split('/').pop()}`;
  db.prepare(`
    INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, version, extra, first_seen, last_seen)
    VALUES (?, 'cli', 'Shell history (AI-gated)', ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(surface_key) DO UPDATE SET
      last_seen = excluded.last_seen, evidence = excluded.evidence, extra = excluded.extra`)
    .run(
      surfaceKey,
      file,
      `bytes_read=${pre.bytes} windows=${pre.windows} windows_matched=${pre.windows_matched} lines_matched=${matched.length} sha256=${fingerprint}`,
      JSON.stringify({ receipt: base, fingerprint }),
      now,
      now,
    );
  db.prepare('UPDATE ai_surfaces SET scanner = ?, evidence_kind = ? WHERE surface_key = ?').run(
    'shell-history',
    'byte-receipt',
    surfaceKey,
  );
  return {
    ok: true,
    notes: `${file}: ${pre.bytes} bytes, ${pre.windows_matched}/${pre.windows} windows matched, ${matched.length} AI lines fingerprinted (text never stored)`,
    receipt: { ...base, rows_stored: 1 },
  };
}

/**
 * The scanner-lane entry. Gated by the manifest switch — OFF unless explicitly
 * enabled, in personal AND managed mode. Integration registers this object in
 * scanners/index.ts SCANNERS (run(db) there; the opts are for tests and any
 * lane that relocates the home or the override files).
 */
export interface ShellScannerOpts {
  home?: string;
  userFile?: string;
  managedFiles?: string[];
}

export const shellHistoryScanner = {
  name: 'shell-history',
  cadenceMs: 300_000,
  run: (db?: DB, opts: ShellScannerOpts = {}): ShellHistoryScanResult[] => {
    const sw = resolveScannerSwitch('shell-history', { userFile: opts.userFile, managedFiles: opts.managedFiles });
    if (!sw.enabled) {
      return [{
        ok: true,
        notes: `off (${sw.basis}${sw.locked ? ', pinned by managed policy' : ''}) — shell history not read`,
        receipt: { file: '', bytes_read: 0, windows: 0, windows_matched: 0, lines_matched: 0, rows_stored: 0 },
      }];
    }
    if (!db) {
      return [{
        ok: false,
        notes: 'enabled but no store handle passed — nothing read',
        receipt: { file: '', bytes_read: 0, windows: 0, windows_matched: 0, lines_matched: 0, rows_stored: 0 },
      }];
    }
    return shellHistoryPaths(opts.home).map((p) => scanShellHistoryFile(db, p));
  },
};

/**
 * The explicit toggle. Writes who enabled it and when into the scope-change
 * ledger (the spec's own requirement), then flips the user override file.
 */
export function setShellHistoryEnabled(
  db: DB,
  who: string,
  enabled: boolean,
  opts: { userFile?: string; now?: number } = {},
): void {
  const file = opts.userFile ?? userScannersFile();
  let overrides: Record<string, boolean> = {};
  if (existsSync(file)) {
    try {
      overrides = JSON.parse(readFileSync(file, 'utf8')) as Record<string, boolean>;
    } catch {
      /* corrupt override file: start over from the manifest defaults */
    }
  }
  overrides['shell-history'] = enabled;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(overrides, null, 2) + '\n');
  appendScopeEvent(db, `shell-history scanner ${enabled ? 'enabled' : 'disabled'} by ${who}`, {
    source: 'shell-history-toggle',
    now: opts.now,
  });
}

/** One-click erase: drops every derived row for this scanner. */
export function eraseShellHistoryRows(db: DB): number {
  const rows = db
    .prepare("SELECT COUNT(*) AS n FROM ai_surfaces WHERE scanner = 'shell-history' OR surface_key LIKE 'shell_history:%'")
    .get() as { n: number };
  db.prepare("DELETE FROM ai_surfaces WHERE scanner = 'shell-history' OR surface_key LIKE 'shell_history:%'").run();
  return rows.n;
}
