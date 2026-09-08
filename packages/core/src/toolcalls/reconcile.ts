import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import type { DB } from '../db';

/**
 * The independent Claude Code ledger reconciliation (verify --behaviour).
 *
 * The ledger keys a tool call by its OWN id (`claude_code:<toolu_id>`) — one
 * call, one row, whatever transcript file it was read from. Claude Code
 * replays history when a session is forked or continued, so the same
 * tool_use block appears verbatim in several transcript files. A per-file
 * count comparison therefore double-counts on the raw side and can never
 * reconcile; the honest comparison is over the SET of call ids:
 *
 *   - every tool_use id in the transcripts must have a ledger row, unless the
 *     only bytes holding it were appended after the collector's last run
 *     (lagging — the next pass heals it; the source is live);
 *   - every ledger row must name an id some readable transcript still holds,
 *     unless its source file is gone (pruned — the vendor's cleanup horizon).
 *
 * Everything is derived from the raw JSONL and the store, never from a
 * product parse path, so a parser bug cannot cancel itself out.
 */
export interface ToolCallReconciliation {
  transcriptFiles: number;
  toolUseBlocks: number;
  distinctCalls: number;
  /** Occurrences beyond the first per id — the replay/fork duplication. */
  replayedOccurrences: number;
  ledgerRows: number;
  /** Ids in transcripts with no ledger row, whose bytes predate the last run. */
  missing: number;
  /** Missing ids whose only occurrences are in files modified after the last run. */
  lagging: number;
  /** Ledger rows whose id no readable transcript holds, source file gone. */
  pruned: number;
  /** Ledger rows whose id no readable transcript holds, source file still there. */
  bogus: number;
  lastRunAt: number | null;
  /** False only on the numbers that fail the check (missing + bogus). */
  ok: boolean;
}

export function reconcileClaudeToolCalls(db: DB, transcriptRoot: string): ToolCallReconciliation {
  const lastRunAt = (
    db.prepare("SELECT MAX(started_at) AS m FROM collector_runs WHERE tool = 'claude_code'").get() as { m: number | null }
  ).m;

  const idFiles = new Map<string, string[]>();
  let transcriptFiles = 0;
  let toolUseBlocks = 0;
  if (existsSync(transcriptRoot)) {
    const files: string[] = [];
    walkJsonl(transcriptRoot, files);
    for (const f of files) {
      transcriptFiles++;
      let text: string;
      try {
        text = readFileSync(f, 'utf8');
      } catch {
        continue; // unreadable: neither proves nor fails
      }
      for (const line of text.split('\n')) {
        if (!line.includes('"tool_use"')) continue; // cheap pre-filter
        let e: any;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        const c = e?.message?.content;
        if (e?.type !== 'assistant' || !Array.isArray(c)) continue;
        for (const b of c) {
          if (b?.type === 'tool_use' && typeof b.id === 'string' && b.id) {
            toolUseBlocks++;
            const seen = idFiles.get(b.id);
            if (seen) seen.push(f);
            else idFiles.set(b.id, [f]);
          }
        }
      }
    }
  }

  const ledger = new Map<string, string>(); // id -> raw_ref
  for (const r of db
    .prepare("SELECT tool_call_key, raw_ref FROM tool_calls WHERE tool = 'claude_code' AND raw_ref IS NOT NULL")
    .all() as { tool_call_key: string; raw_ref: string }[]) {
    ledger.set(r.tool_call_key.slice('claude_code:'.length), r.raw_ref);
  }

  let missing = 0;
  let lagging = 0;
  const mtimeCache = new Map<string, number>();
  const mtime = (f: string): number => {
    let v = mtimeCache.get(f);
    if (v === undefined) {
      try {
        v = statSync(f).mtimeMs;
      } catch {
        v = 0; // gone: predates any run we can wait for
      }
      mtimeCache.set(f, v);
    }
    return v;
  };
  for (const [id, files] of idFiles) {
    if (ledger.has(id)) continue;
    // Lagging: every file holding this id changed after the last collector run
    // — the pass that would have ingested it has not happened yet.
    if (lastRunAt !== null && files.every((f) => mtime(f) > lastRunAt)) lagging++;
    else missing++;
  }

  let pruned = 0;
  let bogus = 0;
  for (const [id, rawRef] of ledger) {
    if (idFiles.has(id)) continue;
    const hash = rawRef.lastIndexOf('#');
    const file = hash > 0 ? rawRef.slice(0, hash) : rawRef;
    if (!existsSync(file)) pruned++; // the vendor pruned it: cannot re-prove
    else bogus++; // file is still there but holds no such call
  }

  return {
    transcriptFiles,
    toolUseBlocks,
    distinctCalls: idFiles.size,
    replayedOccurrences: toolUseBlocks - idFiles.size,
    ledgerRows: ledger.size,
    missing,
    lagging,
    pruned,
    bogus,
    lastRunAt,
    ok: missing === 0 && bogus === 0,
  };
}

/** Every `*.jsonl` under a directory, at any depth — the walk re-implemented
 *  on purpose: the reconciliation must not share the collector's traversal. */
export function walkJsonl(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}
