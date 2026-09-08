import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DB } from './db';
import { paths } from './paths';
import { Database } from './sqlite';
import { contentOf, type Content } from './content';

/**
 * The opaque-payload ledger (tier 4 #136 + tier 5 payload_origin): one row per
 * payload NO REGEX CAN READ — images and persisted tool output — counted by
 * bytes and media type, never decoded, never stored. Bytes on disk (the file
 * the agent read) and bytes received (what base64 length arithmetic says the
 * wire carried) are kept apart, because conflating them is how an exposure
 * figure becomes a lie. NULL is the only 'unknown': rows with no on-disk size
 * print 'N rows with no recorded size', never 0.
 *
 * Each image row is origin-classified with evidence that already exists: the
 * tool_use_id joins back to the Read's input.file_path, so a screenshot pasted
 * from the OS, a repo asset under a consented root, a file outside every root
 * and an unresolved origin are four different rows — and an image of a stack
 * trace is indistinguishable from an image of a customer record, which is why
 * this ledger measures exposure volume and never renders a verdict.
 */

export type PayloadOrigin = 'screen_capture' | 'outside_work_roots' | 'repo_asset' | 'unresolved';

export interface PayloadSightingRow {
  sighting_key: string;
  session_id: string | null;
  kind: string;
  media_type: string | null;
  bytes_on_disk: number | null;
  bytes_received: number | null;
  scannable: 0 | 1;
  context_class: PayloadOrigin | null;
}

/** Exact decoded bytes from base64 length arithmetic — never decoded. */
export function base64DecodedLength(b64: string): number {
  const unpadded = b64.replace(/=+$/, '');
  const rem = unpadded.length % 4;
  // Standard base64: 3 bytes per 4 chars; a trailing 2-char group is 1 byte, 3 chars is 2.
  return Math.floor(unpadded.length / 4) * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0);
}

const SCREENSHOT_NAME = /screen[ _-]?shots?|screenshot/i;

/**
 * Where the bytes came from, from evidence that exists: the OS screenshot
 * naming pattern or a screenshot-named directory, a work root with the file
 * in its .git/index, no root at all, or nothing to resolve from. A bare temp
 * directory is NOT enough — the whole macOS tmp tree lives under /var/folders.
 */
export function classifyOrigin(
  filePath: string | null,
  workRoots: string[],
): PayloadOrigin {
  if (!filePath) return 'unresolved';
  if (SCREENSHOT_NAME.test(filePath)) return 'screen_capture';
  const root = workRoots.find((r) => filePath === r || filePath.startsWith(r + '/'));
  if (!root) return 'outside_work_roots';
  // Present in the repo's own index — a read-only git probe, no content touched.
  const ls = spawnSync('git', ['-C', root, 'ls-files', '--error-unmatch', relative(root, filePath)], { timeout: 4000 });
  return ls.status === 0 ? 'repo_asset' : 'unresolved';
}

const PAYLOAD_UPSERT = `
INSERT INTO payload_sightings
  (sighting_key, session_id, kind, media_type, bytes_on_disk, bytes_received,
   scannable, context_class, first_seen, last_seen)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(sighting_key) DO UPDATE SET
  last_seen     = excluded.last_seen,
  bytes_on_disk = COALESCE(payload_sightings.bytes_on_disk, excluded.bytes_on_disk),
  bytes_received = COALESCE(payload_sightings.bytes_received, excluded.bytes_received),
  context_class = COALESCE(payload_sightings.context_class, excluded.context_class)`;

function writePayloads(db: DB, rows: PayloadSightingRow[], now: number): number {
  const stmt = db.prepare(PAYLOAD_UPSERT);
  let n = 0;
  for (const r of rows) {
    stmt.run(r.sighting_key, r.session_id, r.kind, r.media_type, r.bytes_on_disk,
      r.bytes_received, r.scannable, r.context_class, now, now);
    n++;
  }
  return n;
}

interface ClaudeEntry {
  type?: string;
  sessionId?: string;
  message?: { id?: string; content?: unknown };
  toolUseResult?: Record<string, unknown>;
}

interface ImageBlock {
  type?: string;
  source?: { media_type?: string; data?: string };
  tool_use_id?: string;
  content?: unknown;
}

/** Walks the Claude Code transcript tree and emits one row per opaque payload. */
export function collectClaudePayloads(db: DB, workRoots: string[], now: number): number {
  const root = paths.claudeCodeProjects();
  if (!existsSync(root)) return 0;
  const rows: PayloadSightingRow[] = [];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(root);

  for (const file of files) {
    let text: Content;
    try {
      const st = statSync(file);
      if (st.size > 64 * 1024 * 1024) continue; // ponytail: per-file ceiling, stream-parse if transcripts grow past this
      text = contentOf(readFileSync(file, 'utf8'));
    } catch { continue; }
    const sessionIdFromFile = file.split('/').pop()?.replace(/\.jsonl$/, '') ?? null;
    // tool_use_id → the Read's file_path, built while streaming so every
    // later tool_result image can resolve its own origin.
    const readPaths = new Map<string, string>();
    const lines = text.split('\n').filter((l) => l.length > 0);
    for (let li = 0; li < lines.length; li++) {
      let entry: ClaudeEntry;
      try {
        entry = JSON.parse(lines[li]!) as ClaudeEntry;
      } catch { continue; }
      const msgId = entry.message?.id ?? `${sessionIdFromFile}:${li}`;
      const content = Array.isArray(entry.message?.content) ? (entry!.message!.content as ImageBlock[]) : null;

      if (entry.type === 'assistant' && content) {
        for (const block of content) {
          if (block?.type !== 'tool_use') continue;
          const input = (block as unknown as { input?: { file_path?: string } }).input;
          if (typeof input?.file_path === 'string') {
            readPaths.set((block as unknown as { id?: string }).id ?? '', input.file_path);
          }
        }
        continue;
      }
      if (entry.type !== 'user') continue;

      // Direct human-turn images.
      if (content) {
        for (let bi = 0; bi < content.length; bi++) {
          const block = content[bi]!;
          if (block.type === 'image' && block.source?.data) {
            rows.push({
              sighting_key: `claude:${msgId}:img:${bi}`,
              session_id: entry.sessionId ?? sessionIdFromFile,
              kind: 'image_human_turn',
              media_type: block.source.media_type ?? null,
              bytes_on_disk: null,
              bytes_received: base64DecodedLength(block.source.data),
              scannable: 0,
              context_class: 'unresolved',
            });
          }
          // Images nested inside tool_result.content[] — counted separately.
          if (block.type === 'tool_result' && Array.isArray(block.content)) {
            for (let ci = 0; ci < block.content.length; ci++) {
              const inner = block.content[ci] as ImageBlock | null;
              if (inner?.type !== 'image' || !inner.source?.data) continue;
              const from = readPaths.get(block.tool_use_id ?? '') ?? null;
              let onDisk: number | null = null;
              if (from) {
                try { onDisk = statSync(from).size; } catch { /* file gone: NULL, never 0 */ }
              }
              rows.push({
                sighting_key: `claude:${msgId}:tr-img:${block.tool_use_id ?? ''}:${ci}`,
                session_id: entry.sessionId ?? sessionIdFromFile,
                kind: 'image_tool_result',
                media_type: inner.source.media_type ?? null,
                bytes_on_disk: onDisk,
                bytes_received: base64DecodedLength(inner.source.data),
                scannable: 0,
                context_class: classifyOrigin(from, workRoots),
              });
            }
          }
        }
      }

      // toolUseResult.file: images the agent read off disk itself.
      const file = entry.toolUseResult?.file as
        | { base64?: string; originalSize?: number; type?: string }
        | undefined;
      if (file && (file.base64 !== undefined || file.originalSize !== undefined)) {
        const from = content?.[0] && 'tool_use_id' in content[0] ? readPaths.get(content[0].tool_use_id ?? '') ?? null : null;
        rows.push({
          sighting_key: `claude:${msgId}:file`,
          session_id: entry.sessionId ?? sessionIdFromFile,
          kind: 'read_file_image',
          media_type: file.type ?? null,
          bytes_on_disk: typeof file.originalSize === 'number' ? file.originalSize : null,
          bytes_received: typeof file.base64 === 'string' ? base64DecodedLength(file.base64) : null,
          scannable: 0,
          context_class: classifyOrigin(from, workRoots),
        });
      }
      // toolUseResult.persistedOutputPath: Bash output too large for context.
      const spillPath = entry.toolUseResult?.persistedOutputPath;
      if (typeof spillPath === 'string') {
        rows.push({
          sighting_key: `claude:${msgId}:spill`,
          session_id: entry.sessionId ?? sessionIdFromFile,
          kind: 'persisted_output',
          media_type: 'text/plain',
          bytes_on_disk: typeof entry.toolUseResult!.persistedOutputSize === 'number'
            ? (entry.toolUseResult!.persistedOutputSize as number)
            : null,
          bytes_received: null,
          scannable: 1,
          context_class: null,
        });
      }
    }
  }
  return writePayloads(db, rows, now);
}

/** OpenCode attachments: the fifth parse site — part.data carries the original filename verbatim. */
export function collectOpencodePayloads(db: DB, workRoots: string[], now: number): number {
  const dbPath = paths.opencodeDb();
  if (!existsSync(dbPath)) return 0;
  const rows: PayloadSightingRow[] = [];
  let store: Database;
  try {
    store = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch { return 0; }
  try {
    const parts = store.prepare(
      `SELECT p.id, p.session_id, p.data FROM part p WHERE json_extract(p.data, '$.type') = 'file'`,
    ).all() as unknown as { id: string; session_id: string | null; data: string }[];
    for (const p of parts) {
      let d: { file?: { mime?: string; filename?: string; data?: string } };
      try {
        d = JSON.parse(p.data);
      } catch { continue; }
      const f = d.file;
      if (!f) continue;
      let onDisk: number | null = null;
      if (f.filename) {
        try { onDisk = statSync(f.filename).size; } catch { /* gone: NULL, never 0 */ }
      }
      rows.push({
        sighting_key: `opencode:${p.id}`,
        session_id: p.session_id,
        kind: 'file_attachment',
        media_type: f.mime ?? null,
        bytes_on_disk: onDisk,
        bytes_received: typeof f.data === 'string' ? base64DecodedLength(f.data) : null,
        scannable: 0,
        context_class: classifyOrigin(f.filename ?? null, workRoots),
      });
    }
  } finally {
    store.close();
  }
  return writePayloads(db, rows, now);
}

/** Both parse passes; the scanner entry point the integrator registers. */
export function collectPayloadSightings(db: DB, workRoots: string[], now = Date.now()): {
  ok: boolean;
  notes: string[];
} {
  const claude = collectClaudePayloads(db, workRoots, now);
  const opencode = collectOpencodePayloads(db, workRoots, now);
  const noSize = (db.prepare(
    'SELECT COUNT(*) AS n FROM payload_sightings WHERE bytes_on_disk IS NULL AND bytes_received IS NULL',
  ).get() as { n: number }).n;
  return {
    ok: true,
    notes: [
      `payload_sightings: ${claude} Claude row(s), ${opencode} OpenCode row(s)`,
      ...(noSize ? [`${noSize} row(s) with no recorded size — the honest denominator, never 0`] : []),
    ],
  };
}
