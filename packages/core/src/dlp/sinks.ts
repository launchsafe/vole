import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { asContent, scanBuffer, type RawSighting } from './engine';

/**
 * The at-rest sinks (#130, #131, #134, #139, #140): the files the agents write
 * FOR you that happen to hold prompts, commands and credentials. Enumerated
 * from the local filesystem only — a sink registry entry states what exists,
 * and an encrypted or absent sink still records its denominator honestly.
 */

export interface Sink {
  key: string;
  path: string;
  /** What kind of content the tool itself left here. */
  holds: string;
  /** The 30-day cleanup horizon, where the vendor deletes its own evidence. */
  expiresInDays?: number;
  byteOffsetBase?: number;
}

/** Enumerates every sink that exists on this machine, newest evidence first. */
export function enumerateSinks(): Sink[] {
  const home = homedir();
  const sinks: Sink[] = [];

  const push = (key: string, path: string, holds: string, expiresInDays?: number) => {
    if (existsSync(path)) sinks.push({ key, path, holds, expiresInDays });
  };

  // Claude Code's own at-rest sinks.
  const shellSnapshots = join(home, '.claude', 'shell-snapshots');
  if (existsSync(shellSnapshots)) {
    for (const f of readdirSync(shellSnapshots).sort().reverse()) {
      push(`claude-shell-snapshot:${f}`, join(shellSnapshots, f),
        'the user\'s shell environment and command history snapshot Claude Code took at session start');
    }
  }
  // File-history: every file Claude Code edited, kept under the project dir.
  const projects = join(home, '.claude', 'projects');
  if (existsSync(projects)) {
    for (const slug of readdirSync(projects)) {
      const fh = join(projects, slug, 'file-history');
      if (!existsSync(fh)) continue;
      push(`claude-file-history:${slug}`, fh,
        'every file the agent edited in this project, with content history');
    }
  }
  // Rotating config backups of ~/.claude.json (session + account state).
  const claudeJson = join(home, '.claude.json');
  if (existsSync(claudeJson)) {
    push('claude-config', claudeJson, 'the Claude Code config with account and MCP state', 30);
  }
  // Permission allowlists with inline commands.
  for (const p of [join(home, '.claude', 'settings.json'), join(home, '.claude', 'settings.local.json')]) {
    push(`claude-permissions:${p.endsWith('local.json') ? 'local' : 'global'}`, p,
      'permission allowlist entries, including inline shell commands');
  }

  // Codex thread history: the vendor's own prompt record.
  push('codex-thread-history', join(home, '.codex', 'thread_history_1.sqlite'),
    'per-turn prompts and responses Codex itself retains', 30);

  // Copilot's session store.
  push('copilot-sessions', join(home, '.copilot', 'ide'),
    'Copilot IDE session state (prompts on disk)', 30);

  // Cursor / Antigravity / Devin: encrypted or opaque — the denominator, not the content.
  push('cursor-tracking', join(home, '.cursor', 'ai-tracking', 'ai-code-tracking.db'),
    'Cursor\'s own content store (readable structure, content tables may be empty)');
  const agBrain = join(home, '.gemini', 'antigravity-ide', 'brain');
  if (existsSync(agBrain)) {
    for (const d of readdirSync(agBrain)) {
      push(`antigravity-brain:${d.slice(0, 8)}`, join(agBrain, d),
        'Antigravity conversation artifacts — markdown plans and screenshots');
    }
  }
  const devinSessions = join(home, 'Library/Application Support/Devin/User/acp-messages');
  if (existsSync(devinSessions)) {
    push('devin-acp-messages', devinSessions, 'Devin conversation payloads (per-thread sqlite)', 30);
  }

  return sinks;
}

export interface SinkScanResult {
  sinkKey: string;
  path: string;
  sightings: RawSighting[];
  bytesScanned: number;
  bytesUnreadable: number;
  completed: boolean;
}

/**
 * Scans one sink under its byte budget. Text sinks are scanned whole; sqlite
 * sinks are scanned as raw bytes (the engine's regexes still find key shapes in
 * page data, which is exactly how at-rest scanning of opaque stores works).
 */
export function scanSink(sink: Sink, byteBudget: number): SinkScanResult {
  const textSinks = !sink.path.endsWith('.sqlite') && !sink.path.endsWith('.db');
  const files: { path: string; size: number }[] = [];
  try {
    const st = statSync(sink.path);
    if (st.isDirectory()) {
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else files.push({ path: p, size: statSync(p).size });
        }
      };
      walk(sink.path);
    } else {
      files.push({ path: sink.path, size: st.size });
    }
  } catch {
    return { sinkKey: sink.key, path: sink.path, sightings: [], bytesScanned: 0, bytesUnreadable: 0, completed: true };
  }

  let bytesScanned = 0;
  let bytesUnreadable = 0;
  let overBudget = false;
  const sightings: RawSighting[] = [];
  const MAX_FILES_PER_SINK = 5000;   // a directory sink with 100k files must not
  let filesScanned = 0;              // cost a full statSync walk before the budget

  for (const f of files) {
    if (filesScanned >= MAX_FILES_PER_SINK) { overBudget = true; break; }
    if (bytesScanned + f.size > byteBudget) {
      overBudget = true;
      break; // the cursor state lets the next scan resume
    }
    filesScanned++;
    try {
      const raw = readFileSync(f.path);
      bytesScanned += f.size;
      if (textSinks || f.size < 8 * 1024 * 1024) {
        // Content-branded at the boundary: measurable, never storable.
        const text = asContent(raw.toString('utf8'));
        const found = scanBuffer(text, 0);
        for (const s of found) sightings.push({ ...s, byteOffset: s.byteOffset });
        void sink;
      }
    } catch {
      bytesUnreadable += f.size; // the honest denominator
    }
  }
  void textSinks;
  return {
    sinkKey: sink.key,
    path: sink.path,
    sightings,
    bytesScanned,
    bytesUnreadable,
    completed: !overBudget,
  };
}
