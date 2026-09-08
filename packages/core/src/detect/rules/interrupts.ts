import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The human-interrupt ledger (tier 5 #28): the literal '[Request interrupted by
 * user]' marker. This is a TEXT MARKER, not a structured vendor field — it is
 * version-fragile and a user pasting the same string into a prompt reproduces it,
 * so every surface that consumes it must label it '(text marker)'.
 *
 * Only the session, timestamp and the interrupted tool_use id leave this scanner;
 * the marker's surrounding text is read and discarded.
 */

export const INTERRUPT_MARKER = '[Request interrupted by user]';

export interface InterruptRow {
  session_id: string;
  ts: number | null;
  /** claude_code:<tool_use.id> of the last unbound tool call before the marker. */
  tool_call_key: string | null;
  project: string | null;
}

interface ParsedLine {
  timestamp?: unknown;
  message?: unknown;
  [k: string]: unknown;
}

/**
 * Scan a Claude projects directory for interrupt markers. `sinceTs` bounds the
 * scan to files modified after it (0 = full scan, run once); the marker is
 * matched on the raw line, but only the envelope fields are kept.
 */
export function scanInterruptMarkers(projectsDir: string, sinceTs: number): InterruptRow[] {
  const out: InterruptRow[] = [];
  let slugs: string[] = [];
  try {
    slugs = readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const slug of slugs) {
    const dir = join(projectsDir, slug);
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      const full = join(dir, file);
      try {
        if (sinceTs > 0 && statSync(full).mtimeMs < sinceTs - 300_000) continue;
      } catch {
        continue;
      }
      scanFile(full, file, slug, out);
    }
  }
  return out;
}

function scanFile(path: string, file: string, slug: string, out: InterruptRow[]): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  // The last tool_use issued before the marker, not yet answered by a result —
  // that is the call the human interrupted.
  let pendingToolUseId: string | null = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let entry: ParsedLine | null = null;
    try {
      entry = JSON.parse(line) as ParsedLine;
    } catch {
      continue;
    }
    const msg = entry.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(msg?.content) ? (msg.content as Array<Record<string, unknown>>) : [];
    for (const b of blocks) {
      if (b && typeof b === 'object') {
        if (b.type === 'tool_use' && typeof b.id === 'string') pendingToolUseId = b.id;
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string' && pendingToolUseId === b.tool_use_id) {
          pendingToolUseId = null;
        }
      }
    }
    if (!line.includes(INTERRUPT_MARKER)) continue;
    const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.isFinite(entry.timestamp as number) ? (entry.timestamp as number) : null;
    out.push({
      session_id: file.replace(/\.jsonl$/, ''),
      ts: ts !== null && Number.isFinite(ts) ? ts : null,
      tool_call_key: pendingToolUseId ? `claude_code:${pendingToolUseId}` : null,
      project: slug,
    });
    pendingToolUseId = null; // the interrupt consumed the in-flight call
  }
}
