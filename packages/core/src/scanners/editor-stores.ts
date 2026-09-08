import { readdirSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DB } from '../db';
import { openDb, insertEvents } from '../db';
import type { Scanner } from '../db';
import type { UsageEvent } from '../types';
import { upsertSurface, type Surface } from './ai-surfaces';
import { editorRoots } from './editor-census';
import { consentedRoots } from './deps';

/**
 * The editor-store collectors (tier 2): usage rows the vendors' own stores
 * already count. Four shapes live here:
 *
 *  - VS Code chatSessions/*.jsonl: one exact row per request (completionTokens
 *    only — the store has no input or cache count, so those stay NULL and the
 *    rows are excluded from token aggregates by the TOKEN_FILTER, correctly).
 *  - Cline / Roo / Kilo taskHistory.json: the vendor's own running totals, one
 *    row per task, keyed by task id so the monotone upsert survives re-reads
 *    and context-condense rewrites.
 *  - Ollama server-*.log: logfmt model-load and [GIN] request lines, keyed by
 *    inode:byte-offset so no poll-time value ever enters the key.
 *  - Repo-only agents: Aider footprints and Continue dev_data, discovered under
 *    consented repo roots only.
 *
 * Content boundary: the one field we read from a chat session line is a token
 * count and ids; the one field we read from a dev_data line is an event NAME.
 */

function ev(over: Partial<UsageEvent> & Pick<UsageEvent, 'event_key' | 'tool' | 'ts'>): UsageEvent {
  return {
    model: null, session_id: null, project: null, git_branch: null,
    input_tokens: null, output_tokens: null, cache_write_5m_tokens: null,
    cache_write_1h_tokens: null, cache_read_tokens: null, reasoning_tokens: null,
    total_tokens: null, cost_usd: null, confidence: 'exact', is_error: 0,
    stop_reason: null, source: 'live', raw_ref: null, tools: null, agent_id: null,
    context_window: null, duration_ms: null, duration_kind: null,
    ...over,
  };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** ── VS Code chat request rows ──────────────────────────────────────────── */

/** The fields one chatSessions line can carry; everything else is ignored. */
export function parseChatSessionLine(line: string): {
  requestId: string | null;
  responseId: string | null;
  completionTokens: number | null;
  totalElapsed: number | null;
  timeSpentWaiting: number | null;
  isSystemInitiated: boolean | null;
  model: string | null;
} | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const pick = (src: Record<string, unknown>, key: string): unknown => {
    const v = src[key];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    if (v && typeof v === 'object') return v;
    return undefined;
  };
  const top = o as Record<string, unknown>;
  const nested = ['value', 'data', 'agentResult', 'usage', 'timing'].map((k) => top[k]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  const get = (key: string): unknown => pick(top, key) ?? nested.map((s) => pick(s, key)).find((v) => v !== undefined);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const out = {
    requestId: str(get('requestId')),
    responseId: str(get('responseId')),
    completionTokens: num(get('completionTokens')),
    totalElapsed: num(get('totalElapsed')),
    timeSpentWaiting: num(get('timeSpentWaiting')),
    isSystemInitiated: typeof get('isSystemInitiated') === 'boolean' ? (get('isSystemInitiated') as boolean) : null,
    model: str(get('model')),
  };
  if (!out.requestId && !out.responseId && out.completionTokens === null && out.totalElapsed === null && out.timeSpentWaiting === null) return null;
  return out;
}

/** One row per request across every workspaceStorage chatSessions dir and the empty-window store. */
export function vscodeChatCensus(db: DB, home: string, now: number): number {
  const events: UsageEvent[] = [];
  for (const root of editorRoots(home)) {
    const user = join(root.appSupport, 'User');
    if (!existsSync(user)) continue;
    const sessionDirs = [
      ...readdirSafe(join(user, 'workspaceStorage')).map((h) => join(user, 'workspaceStorage', h, 'chatSessions')),
      join(user, 'globalStorage/emptyWindowChatSessions'),
    ];
    for (const dir of sessionDirs) {
      for (const f of readdirSafe(dir).filter((x) => x.endsWith('.jsonl'))) {
        const file = join(dir, f);
        let mtime = now;
        try {
          mtime = Math.trunc(statSync(file).mtimeMs);
        } catch {
          /* keep scan time — the store carries no per-request clock */
        }
        const sessionId = f.replace(/\.jsonl$/, '');
        let text: string;
        try {
          text = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          const r = parseChatSessionLine(line);
          if (!r) continue;
          events.push(ev({
            event_key: `vscode-chat:${sessionId}:${r.responseId ?? r.requestId}`,
            tool: 'vscode_chat',
            model: r.model,
            session_id: sessionId,
            ts: mtime,
            output_tokens: r.completionTokens,
            duration_ms: r.totalElapsed ?? r.timeSpentWaiting,
            duration_kind: r.totalElapsed !== null || r.timeSpentWaiting !== null ? 'measured' : null,
            agent_id: r.isSystemInitiated === true ? 'system' : null,
            raw_ref: file,
            confidence: 'exact',
          }));
        }
      }
    }
  }
  return insertEvents(db, events);
}

/** ── Cline / Roo / Kilo task totals ────────────────────────────────────── */

const CLINE_EXTENSIONS = ['saoudrizwan.claude-dev', 'rooveterinaryinc.roo-cline', 'kilocode.kilo-code'];

interface ClineTask {
  id: string;
  ts: number;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  cacheWrites: number | null;
  cacheReads: number | null;
  totalCost: number | null;
  workspace: string | null;
}

export function parseTaskHistory(text: string): ClineTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ClineTask[] = [];
  for (const t of parsed as Record<string, unknown>[]) {
    if (typeof t.id !== 'string' && typeof t.id !== 'number') continue;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    out.push({
      id: String(t.id),
      ts: num(t.ts) ?? 0,
      model: typeof t.model === 'string' ? t.model : '',
      tokensIn: num(t.tokensIn),
      tokensOut: num(t.tokensOut),
      cacheWrites: num(t.cacheWrites),
      cacheReads: num(t.cacheReads),
      totalCost: num(t.totalCost),
      workspace: typeof t.workspace === 'string' ? t.workspace : null,
    });
  }
  return out;
}

export function clineTaskCensus(db: DB, home: string, now: number): number {
  const events: UsageEvent[] = [];
  for (const root of editorRoots(home)) {
    const user = join(root.appSupport, 'User');
    if (!existsSync(user)) continue;
    const globalStorages = [
      join(user, 'globalStorage'),
      ...readdirSafe(join(user, 'profiles')).map((p) => join(user, 'profiles', p, 'globalStorage')),
    ];
    for (const gs of globalStorages) {
      for (const extId of CLINE_EXTENSIONS) {
        const file = join(gs, extId, 'state/taskHistory.json');
        if (!existsSync(file)) continue;
        let text: string;
        try {
          text = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        for (const t of parseTaskHistory(text)) {
          events.push(ev({
            // Keyed by task id only: no line index, no mtime — the totals only
            // ever grow while a task runs, which is what the monotone upsert
            // already implements, and it survives context-condense rewrites.
            event_key: `cline:${extId}:${t.id}`,
            tool: 'clines',
            model: t.model || null,
            session_id: t.id,
            project: t.workspace,
            ts: t.ts,
            input_tokens: t.tokensIn,
            output_tokens: t.tokensOut,
            // Cline reports one undated cache-write bucket; the 5m column is that bucket.
            cache_write_5m_tokens: t.cacheWrites,
            cache_read_tokens: t.cacheReads,
            total_tokens: (t.tokensIn ?? 0) + (t.tokensOut ?? 0) + (t.cacheWrites ?? 0) + (t.cacheReads ?? 0) || null,
            cost_usd: t.totalCost,
            raw_ref: file,
          }));
        }
      }
    }
  }
  void now;
  return insertEvents(db, events);
}

/** ── Ollama server logs ───────────────────────────────────────────────── */

/** One logfmt line → key/value map (values keep their quotes stripped). */
export function parseLogfmt(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/([a-zA-Z_]+)=("([^"]*)"|\S+)/g)) {
    out[m[1]!] = m[3] ?? m[2]!;
  }
  return out;
}

export interface OllamaEvent {
  event_key: string;
  ts: number | null;
  model: string | null;
  kind: 'model_load' | 'request';
}

export function parseOllamaLine(line: string, inode: number, offset: number): OllamaEvent | null {
  const gin = line.match(/\[GIN\]\s+(\d{4}\/\d{2}\/\d{2})\s*-\s*(\d{2}:\d{2}:\d{2}).*\|\s*(\d+)\s*\|.*\|\s*(POST|GET)\s+"([^"]*)"/);
  if (gin) {
    const ts = Date.parse(`${gin[1]!.replace(/\//g, '-')}T${gin[2]}`);
    return {
      event_key: `ollama:${inode}:${offset}`,
      ts: Number.isNaN(ts) ? null : ts,
      model: null,
      kind: 'request',
    };
  }
  const kv = parseLogfmt(line);
  if (!kv.model || !/load/i.test(kv.msg ?? '')) return null;
  const ts = kv.time ? Date.parse(kv.time) : NaN;
  return {
    event_key: `ollama:${inode}:${offset}`,
    ts: Number.isNaN(ts) ? null : ts,
    // Verbatim from the load line — a path or a tag, never a token count.
    model: kv.model,
    kind: 'model_load',
  };
}

/** Incremental, cursor-safe: re-reads are no-ops and no poll-time value enters a key. */
export function ollamaLogCensus(db: DB, home: string, now: number): number {
  const logsDir = join(home, '.ollama', 'logs');
  let inserted = 0;
  for (const f of readdirSafe(logsDir).filter((x) => /^server.*\.log$/.test(x))) {
    const file = join(logsDir, f);
    let inode: number;
    let size: number;
    try {
      const st = statSync(file);
      inode = st.ino;
      size = st.size;
    } catch {
      continue;
    }
    // Cursor keyed on a suffixed source_path: the legacy stores.ts ollama reader
    // owns the bare-path row for the same file, and two cursors on one row would
    // fight. The suffix keeps this reader's offset its own.
    const cursorKey = `${file}#activity`;
    const state = db
      .prepare('SELECT last_offset FROM collector_state WHERE source_path = ?')
      .get(cursorKey) as { last_offset: number } | undefined;
    const from = state?.last_offset ?? 0;
    if (size < from) continue; // rotated/truncated: restart next pass rather than mis-key
    if (size === from) continue;
    const buf = Buffer.allocUnsafe(size - from);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buf, 0, size - from, from);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) continue; // no complete line yet
    const consumed = from + Buffer.byteLength(text.slice(0, lastNewline), 'utf8') + 1;
    const events: UsageEvent[] = [];
    let offset = from;
    for (const line of text.slice(0, lastNewline).split('\n')) {
      const lineStart = offset;
      offset += Buffer.byteLength(line, 'utf8') + 1;
      if (!line.trim()) continue;
      const e = parseOllamaLine(line, inode, lineStart);
      if (!e) continue;
      events.push(ev({
        event_key: e.event_key,
        tool: 'ollama_local',
        model: e.model,
        session_id: f,
        ts: e.ts ?? now,
        confidence: 'activity_only', // Ollama logs no per-request tokens — forever
        raw_ref: file,
      }));
    }
    inserted += insertEvents(db, events);
    db.prepare(`
      INSERT INTO collector_state (source_path, tool, last_offset, last_scanned_at)
      VALUES (?, 'ollama_local', ?, ?)
      ON CONFLICT(source_path) DO UPDATE SET last_offset = excluded.last_offset, last_scanned_at = excluded.last_scanned_at`)
      .run(cursorKey, consumed, now);
  }
  return inserted;
}

/** ── Repo-only agents: Aider footprint, Continue dev_data ─────────────── */

const AIDER_ARTIFACTS = ['.aider.chat.history.md', '.aider.input.history', '.aider.model.metadata.json'];

/** dev_data event names we count — names only, bodies never read. */
const CONTINUE_EVENTS = ['tokensGenerated', 'chatInteraction', 'toolUsage', 'autocomplete'];

export function repoAgentCensus(db: DB, now: number): { aiderRoots: number; continueRoots: number } {
  const surfaces: Surface[] = [];
  let aiderRoots = 0;
  let continueRoots = 0;
  for (const root of consentedRoots(db)) {
    // Aider: footprint only, no telemetry — an evidence-ladder 'footprint' row.
    const found: string[] = [];
    for (const rel of AIDER_ARTIFACTS) if (existsSync(join(root, rel))) found.push(rel);
    for (const d of readdirSafe(root).filter((x) => /^\.aider\.tags\.cache\.v/.test(x))) found.push(d);
    if (found.length) {
      aiderRoots++;
      upsertRepoArtifacts(db, root, found.map((rel) => ({ rel, kind: rel.includes('tags') ? 'aider_tags' : 'aider_history' })), now);
      surfaces.push({
        surface_key: `repo-agent:aider:${root}`,
        kind: 'cli',
        name: 'Aider (repo footprint)',
        path: root,
        evidence: `Aider artifacts in ${root}: ${found.join(', ')} — footprint only, no telemetry; Aider records tokens only through opt-in analytics`,
        depth: { evidence_kind: 'repo_artifact', scanner: 'editor-stores', discovery: 'repo_artifact' },
      });
    }
    // Continue: dev_data line-count watermark over event names only.
    const devData = join(root, '.continue', 'dev_data');
    if (existsSync(devData)) {
      continueRoots++;
      const counts = new Map<string, number>();
      let bytes = 0;
      for (const f of readdirSafe(devData).filter((x) => x.endsWith('.jsonl'))) {
        const file = join(devData, f);
        const key = `continue-devdata:${file}`;
        const state = db.prepare('SELECT cursor_int FROM repo_scan_state WHERE root_path = ?').get(key) as { cursor_int: number } | undefined;
        const from = state?.cursor_int ?? 0;
        let size = 0;
        try {
          size = statSync(file).size;
        } catch {
          continue;
        }
        if (size < from) continue;
        let text = '';
        if (size > from) {
          const buf = Buffer.allocUnsafe(size - from);
          const fd = openSync(file, 'r');
          try {
            readSync(fd, buf, 0, size - from, from);
          } finally {
            closeSync(fd);
          }
          text = buf.toString('utf8');
        }
        const lastNewline = text.lastIndexOf('\n');
        if (lastNewline !== -1) {
          const consumed = from + Buffer.byteLength(text.slice(0, lastNewline), 'utf8') + 1;
          for (const line of text.slice(0, lastNewline).split('\n')) {
            if (!line.trim()) continue;
            // The ONE field read from a dev_data line: the event name.
            try {
              const o = JSON.parse(line) as Record<string, unknown>;
              const name = typeof o.name === 'string' ? o.name : typeof o.event === 'string' ? o.event : typeof o.type === 'string' ? o.type : null;
              if (name && CONTINUE_EVENTS.includes(name)) counts.set(name, (counts.get(name) ?? 0) + 1);
            } catch {
              /* malformed: skip */
            }
          }
          db.prepare(`
            INSERT INTO repo_scan_state (root_path, cursor_int, bytes_scanned, last_scan_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(root_path) DO UPDATE SET cursor_int = excluded.cursor_int, last_scan_at = excluded.last_scan_at`)
            .run(key, consumed, consumed, now);
          bytes = consumed;
        }
      }
      for (const [name, count] of counts) {
        db.prepare(`
          INSERT INTO surface_activity (surface_key, counter_kind, counter, watermark, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(surface_key, counter_kind) DO UPDATE SET
            counter = surface_activity.counter + excluded.counter,
            watermark = COALESCE(excluded.watermark, surface_activity.watermark)`)
          .run(`continue-devdata:${root}`, name, count, bytes || null, now, now);
      }
      upsertRepoArtifacts(db, root, readdirSafe(devData).filter((x) => x.endsWith('.jsonl')).map((rel) => ({ rel: `.continue/dev_data/${rel}`, kind: 'continue_dev_data' })), now);
      surfaces.push({
        surface_key: `repo-agent:continue:${root}`,
        kind: 'cli',
        name: 'Continue (repo dev_data)',
        path: join(root, '.continue'),
        evidence: `Continue per-project dev_data in ${root} — line-count watermark over event names only (${CONTINUE_EVENTS.join(', ')}), no bodies read`,
        depth: { evidence_kind: 'repo_artifact', scanner: 'editor-stores', discovery: 'repo_artifact' },
      });
    }
  }
  for (const s of surfaces) upsertSurface(db, s, now);
  return { aiderRoots, continueRoots };
}

function upsertRepoArtifacts(db: DB, root: string, artifacts: { rel: string; kind: string }[], now: number): void {
  const upsert = db.prepare(`
    INSERT INTO repo_artifacts (artifact_key, root_path, rel_path, kind, tracked_state, sha256, size_bytes, mtime, first_seen, last_seen)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
    ON CONFLICT(artifact_key) DO UPDATE SET
      last_seen = excluded.last_seen,
      size_bytes = COALESCE(excluded.size_bytes, repo_artifacts.size_bytes),
      mtime = COALESCE(excluded.mtime, repo_artifacts.mtime)`);
  for (const { rel, kind } of artifacts) {
    const file = join(root, rel);
    let sha: string | null = null;
    let size: number | null = null;
    let mtime: number | null = null;
    try {
      const buf = readFileSync(file);
      sha = createHash('sha256').update(buf).digest('hex');
      size = buf.length;
      mtime = Math.trunc(statSync(file).mtimeMs);
    } catch {
      /* a directory (tags cache): counts only */
      try {
        size = null;
        mtime = Math.trunc(statSync(file).mtimeMs);
      } catch {
        /* gone already */
      }
    }
    upsert.run(`repo-artifact:${root}:${rel}`, root, rel, kind, sha, size, mtime, now, now);
  }
}

export function scanEditorStores(): { ok: boolean; notes?: string } {
  const db: DB = openDb();
  const now = Date.now();
  const home = homedir();
  const chat = vscodeChatCensus(db, home, now);
  const cline = clineTaskCensus(db, home, now);
  const ollama = ollamaLogCensus(db, home, now);
  const repo = repoAgentCensus(db, now);
  return {
    ok: true,
    notes: `${chat} editor chat request(s) · ${cline} Cline task row(s) · ${ollama} Ollama activity row(s) · ` +
      `${repo.aiderRoots} Aider root(s), ${repo.continueRoots} Continue root(s) under consented roots`,
  };
}

export const editorStoresScanner: Scanner = {
  name: 'editor-stores',
  cadenceMs: 5 * 60_000,
  run: scanEditorStores,
};
