import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { asContent, scanBuffer, type RawSighting } from './engine';
import { paths } from '../paths';

/**
 * The at-rest sinks (#130, #131, #134, #139, #140): the files the agents write
 * FOR you that happen to hold prompts, commands and credentials. Enumerated
 * from the local filesystem only — a sink registry entry states what exists,
 * and an encrypted or absent sink still records its denominator honestly.
 *
 * Sinks whose store is a DATABASE carry `structured: true`: the structured
 * readers in dlp/structured-sinks.ts own them (ordinal watermarks, per-item
 * direction, vendor-table ledgers), and the raw byte scan deliberately skips
 * them so the same finding is never counted once as at_rest noise and once as
 * a directed row.
 */

export interface Sink {
  key: string;
  path: string;
  /** What kind of content the tool itself left here. */
  holds: string;
  /** The 30-day cleanup horizon, where the vendor deletes its own evidence. */
  expiresInDays?: number;
  byteOffsetBase?: number;
  /** A structured reader owns this sink; scanSink's raw byte pass skips it. */
  structured?: boolean;
}

/** Local resolvers for stores paths.ts does not carry yet (see integrationNeeds). */
const home = () => process.env.VOLE_HOME_OVERRIDE ?? homedir();
export const gooseLogsDir = () =>
  process.env.VOLE_GOOSE_LOGS ?? join(home(), '.local', 'state', 'goose', 'logs');
/** Copilot's editor globalStorage roots, probed in order for github.copilot-chat/session-store.db. */
export const copilotGlobalStorageRoots = (): string[] =>
  (process.env.VOLE_COPILOT_GLOBAL_STORAGE
    ? [process.env.VOLE_COPILOT_GLOBAL_STORAGE]
    : [
        join(home(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage'),
        join(home(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage'),
      ]);
export const copilotSessionStorePaths = (): string[] =>
  copilotGlobalStorageRoots().map((r) => join(r, 'github.copilot-chat', 'session-store.db'));

/** Enumerates every sink that exists on this machine, newest evidence first. */
export function enumerateSinks(): Sink[] {
  const sinks: Sink[] = [];

  const push = (key: string, path: string, holds: string, expiresInDays?: number, structured?: boolean) => {
    if (existsSync(path)) sinks.push({ key, path, holds, expiresInDays, structured });
  };

  const claude = paths.claudeConfigDir();

  // Claude Code's own at-rest sinks.
  const shellSnapshots = join(claude, 'shell-snapshots');
  if (existsSync(shellSnapshots)) {
    for (const f of readdirSync(shellSnapshots).sort().reverse()) {
      push(`claude-shell-snapshot:${f}`, join(shellSnapshots, f),
        'the user\'s shell environment and command history snapshot Claude Code took at session start');
    }
  }
  // File-history: every file Claude Code edited, kept under the project dir.
  const projects = paths.claudeCodeProjects();
  if (existsSync(projects)) {
    for (const slug of readdirSync(projects)) {
      const fh = join(projects, slug, 'file-history');
      if (existsSync(fh)) {
        push(`claude-file-history:${slug}`, fh,
          'every file the agent edited in this project, with content history');
      }
      // Tool-results spill files (#131 deep): tool output over Claude Code's
      // inline limit lands here and toolUseResult.persistedOutputPath points
      // at it — a first-class at-rest sink with real prompt-adjacent content.
      // Independent of file-history: a project can have either without the other.
      let sessions: string[] = [];
      try {
        sessions = readdirSync(join(projects, slug), { withFileTypes: true })
          .filter((e) => e.isDirectory()).map((e) => e.name);
      } catch { /* unreadable project dir */ }
      for (const sess of sessions) {
        const tr = join(projects, slug, sess, 'tool-results');
        if (!existsSync(tr)) continue;
        push(`claude-tool-results:${slug}:${sess}`, tr,
          'tool output Claude Code spilled to disk (persistedOutputPath targets)', undefined);
      }
    }
  }
  // Rotating config backups of ~/.claude.json (session + account state).
  const claudeJson = join(home(), '.claude.json');
  if (existsSync(claudeJson)) {
    push('claude-config', claudeJson, 'the Claude Code config with account and MCP state', 30);
  }
  // The vendor's own rotating backup directory for the same config.
  push('claude-config-backups', join(claude, 'backups'),
    'rotating Claude Code config backups (account and MCP state)', 30);
  // Permission allowlists with inline commands.
  for (const p of [join(claude, 'settings.json'), join(claude, 'settings.local.json')]) {
    push(`claude-permissions:${p.endsWith('local.json') ? 'local' : 'global'}`, p,
      'permission allowlist entries, including inline shell commands');
  }

  // Codex thread history: the vendor's own prompt record — structured reader owns it.
  push('codex-thread-history', join(paths.codexHome(), 'thread_history_1.sqlite'),
    'per-turn prompts and responses Codex itself retains', 30, true);

  // Copilot's session store (the editor globalStorage sqlite, not ~/.copilot).
  for (const store of copilotSessionStorePaths()) {
    push('copilot-session-store', store,
      'Copilot Chat sessions, prompts and the vendor-normalised file-to-tool ledger', 30, true);
  }

  // Cursor / Antigravity / Devin: content stores with no model attribution —
  // structured readers parse what is parseable; provider stays NULL.
  push('cursor-tracking', paths.cursorTrackingDb(),
    'Cursor\'s own content store (tracked_file_content + ai_code_hashes)', undefined, true);
  const agBrain = paths.antigravityBrain();
  if (existsSync(agBrain)) {
    for (const d of readdirSync(agBrain)) {
      push(`antigravity-brain:${d.slice(0, 8)}`, join(agBrain, d),
        'Antigravity conversation artifacts — markdown plans and screenshots', undefined, true);
    }
  }
  push('devin-acp-messages', paths.devinAcpMessages(),
    'Devin conversation payloads (per-thread sqlite)', 30, true);

  // Non-Claude prompt sinks (#141): tools Vole collects no usage from still log
  // raw prompts to disk. The registry row IS the finding surface: a tool whose
  // own configuration logs prompts gets a warning row; an installed tool with
  // an empty store gets its own distinct state, never 'no usage'.
  push('gemini-prompt-log-config', join(paths.geminiHome(), 'settings.json'),
    'Gemini CLI telemetry settings — logPrompts decides whether prompts are written to disk');
  const geminiTmp = join(paths.geminiHome(), 'tmp');
  if (existsSync(geminiTmp)) {
    for (const d of readdirSync(geminiTmp)) {
      const p = join(geminiTmp, d, 'prompt.log');
      if (existsSync(p)) {
        push(`gemini-prompt-log:${d.slice(0, 8)}`, p,
          'raw prompts the Gemini CLI logged to disk while logPrompts was on');
      }
    }
  }
  push('goose-llm-request-logs', gooseLogsDir(),
    'raw prompts and responses goose logs to llm_request.*.jsonl (last 10 kept)');

  return sinks;
}

// ── The registry with per-sink metadata ────────────────────────────────────

export type SinkState = 'present' | 'installed_store_empty' | 'absent';

export interface SinkMeta {
  key: string;
  path: string;
  holds: string;
  state: SinkState;
  /** Total bytes on disk for this sink (file or walked directory). NULL when absent. */
  sizeBytes: number | null;
  /** Octal mode of the sink file (e.g. '0644'); NULL for directories/absent. */
  mode: string | null;
  worldReadable: boolean | null;
  fileCount: number | null;
  /** Age histogram of the sink's files, in bytes — the expiry countdown's data. */
  ageHistogram: { bucket: 'd0_7' | 'd7_30' | 'd30_90' | 'd90p'; files: number; bytes: number }[];
  /** The tool's own prompt-logging configuration, READ never assumed. */
  promptLoggingFlag: 'true' | 'false' | 'default_true_documented' | null;
  /** Sinks whose vendor records no model per message: a known gap, never an error. */
  modelAttribution: 'none' | null;
  /** Sighting direction comes from the vendor's own row type, zero inference. */
  directionExact: boolean;
  expiresInDays?: number;
  structured: boolean;
}

const BUCKETS = ['d0_7', 'd7_30', 'd30_90', 'd90p'] as const;
const DAY_MS = 24 * 3600_000;

function walkFiles(path: string, out: { path: string; size: number; mtime: number }[], limit = 20000): boolean {
  try {
    const st = statSync(path);
    if (st.isFile()) {
      out.push({ path, size: st.size, mtime: st.mtimeMs });
      return true;
    }
    if (!st.isDirectory()) return false;
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= limit) return;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else {
          try {
            const s = statSync(p);
            out.push({ path: p, size: s.size, mtime: s.mtimeMs });
          } catch { /* raced away: not counted, not hidden */ }
        }
      }
    };
    walk(path);
    return true;
  } catch {
    return false;
  }
}

/** One registry row per sink, with the honest per-sink metadata the At-rest tab renders. */
export function sinkMeta(sink: Sink, now = Date.now()): SinkMeta {
  const files: { path: string; size: number; mtime: number }[] = [];
  const reachable = walkFiles(sink.path, files);
  let mode: string | null = null;
  let worldReadable: boolean | null = null;
  try {
    // The sink's own mode, file or directory: what the At-rest tab's
    // world-readable column is about.
    const st = statSync(sink.path);
    mode = (st.mode & 0o777).toString(8).padStart(4, '0');
    worldReadable = (st.mode & 0o004) !== 0;
  } catch { /* absent */ }
  const sizeBytes = reachable ? files.reduce((n, f) => n + f.size, 0) : null;
  const state: SinkState =
    !reachable ? 'absent' : sizeBytes === 0 ? 'installed_store_empty' : 'present';

  const hist = { d0_7: [0, 0], d7_30: [0, 0], d30_90: [0, 0], d90p: [0, 0] } as Record<string, [number, number]>;
  for (const f of files) {
    const age = (now - f.mtime) / DAY_MS;
    const b = age <= 7 ? 'd0_7' : age <= 30 ? 'd7_30' : age <= 90 ? 'd30_90' : 'd90p';
    hist[b]![0]++;
    hist[b]![1] += f.size;
  }

  const key = sink.key;
  const isGeminiConfig = key === 'gemini-prompt-log-config';
  const isGeminiLog = key.startsWith('gemini-prompt-log:');
  const isGoose = key === 'goose-llm-request-logs';
  let promptLoggingFlag: SinkMeta['promptLoggingFlag'] = null;
  if (isGeminiConfig || isGeminiLog) {
    // The flag is read when the settings file exists; an ABSENT config file
    // means the documented vendor default applies (true) — stated, never guessed.
    let declared: boolean | null = null;
    try {
      const s = JSON.parse(readFileSync(join(paths.geminiHome(), 'settings.json'), 'utf8')) as {
        telemetry?: { logPrompts?: boolean };
      };
      if (typeof s.telemetry?.logPrompts === 'boolean') declared = s.telemetry.logPrompts;
    } catch { /* absent or malformed: the documented default applies */ }
    promptLoggingFlag = declared === null ? 'default_true_documented' : declared ? 'true' : 'false';
  } else if (isGoose) {
    // goose's llm_request log IS prompt logging by design; presence of files is the observation.
    promptLoggingFlag = reachable && files.some((f) => /llm_request/.test(f.path)) ? 'true' : null;
  }

  const noModelAttribution =
    key === 'cursor-tracking' || key.startsWith('antigravity-brain:') || key === 'devin-acp-messages';

  return {
    key,
    path: sink.path,
    holds: sink.holds,
    state,
    sizeBytes,
    mode,
    worldReadable,
    fileCount: reachable ? files.length : null,
    ageHistogram: BUCKETS.map((bucket) => ({ bucket, files: hist[bucket]![0], bytes: hist[bucket]![1] })),
    promptLoggingFlag,
    modelAttribution: noModelAttribution ? 'none' : null,
    directionExact: key === 'codex-thread-history',
    expiresInDays: sink.expiresInDays,
    structured: !!sink.structured,
  };
}

/** The full Prompt-sinks / At-rest registry — every sink, present or not. */
export function describeSinks(now = Date.now()): SinkMeta[] {
  // Enumerate what exists, then add the named sinks that do NOT exist so the
  // registry shows 'absent'/'installed, store empty' states instead of silence.
  const seen = new Map(enumerateSinks().map((s) => [s.key, s]));
  const always: Sink[] = [
    { key: 'codex-thread-history', path: join(paths.codexHome(), 'thread_history_1.sqlite'),
      holds: 'per-turn prompts and responses Codex itself retains', expiresInDays: 30, structured: true },
    { key: 'cursor-tracking', path: paths.cursorTrackingDb(),
      holds: 'Cursor\'s own content store (tracked_file_content + ai_code_hashes)', structured: true },
    { key: 'devin-acp-messages', path: paths.devinAcpMessages(),
      holds: 'Devin conversation payloads (per-thread sqlite)', expiresInDays: 30, structured: true },
    { key: 'goose-llm-request-logs', path: gooseLogsDir(),
      holds: 'raw prompts and responses goose logs to llm_request.*.jsonl (last 10 kept)' },
    { key: 'gemini-prompt-log-config', path: join(paths.geminiHome(), 'settings.json'),
      holds: 'Gemini CLI telemetry settings — logPrompts decides whether prompts are written to disk' },
  ];
  for (const s of always) if (!seen.has(s.key)) seen.set(s.key, s);
  for (const store of copilotSessionStorePaths()) {
    if (![...seen.values()].some((s) => s.path === store)) {
      seen.set(`copilot-session-store:${store.includes('Cursor') ? 'cursor' : 'code'}`, {
        key: `copilot-session-store:${store.includes('Cursor') ? 'cursor' : 'code'}`,
        path: store,
        holds: 'Copilot Chat sessions, prompts and the vendor-normalised file-to-tool ledger',
        expiresInDays: 30, structured: true,
      });
    }
  }
  return [...seen.values()].map((s) => sinkMeta(s, now));
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
 * page data, which is exactly how at-rest scanning of opaque stores works) —
 * EXCEPT structured sinks, which the structured readers own (see above).
 */
export function scanSink(sink: Sink, byteBudget: number): SinkScanResult {
  if (sink.structured) {
    // The structured reader in dlp/structured-sinks.ts owns this store: it
    // scans with per-row direction and its own watermark cursor. The raw pass
    // must not double-count the same bytes as direction-less at_rest rows.
    return { sinkKey: sink.key, path: sink.path, sightings: [], bytesScanned: 0, bytesUnreadable: 0, completed: true };
  }
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
      if (f.size < 8 * 1024 * 1024) {
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
  return {
    sinkKey: sink.key,
    path: sink.path,
    sightings,
    bytesScanned,
    bytesUnreadable,
    completed: !overBudget,
  };
}
