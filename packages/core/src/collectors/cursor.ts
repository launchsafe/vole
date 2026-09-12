import { Database } from '../sqlite';
import { existsSync, statSync } from 'node:fs';
import { paths } from '../paths';
import { getState, setState, type DB } from '../db';
import { count, sumCounts } from '../util/jsonl';
import type { CollectorResult, UsageEvent } from '../types';

/**
 * Cursor — exact tokens, from the editor state store.
 *
 * Cursor keeps two unrelated local stores, and only one of them has usage:
 *
 *   1. `~/.cursor/ai-tracking/ai-code-tracking.db` — code-hash attribution for the
 *      "% AI-written code" feature. Inspected directly: it has NO token columns at
 *      all. This is the file Vole read for a long time, which is why Cursor was
 *      recorded as activity-only and documented as having no local token data.
 *   2. `globalStorage/state.vscdb` — the editor's own KV store. Each message is a
 *      `bubbleId:<composerId>:<bubbleId>` row carrying a real
 *      `tokenCount: { inputTokens, outputTokens }`. Measured, not estimated.
 *
 * The two stores use disjoint id spaces — on the development machine every
 * composerId in (2) was absent from (1) — so they cannot be joined, and (2) is used
 * on its own.
 *
 * CURSOR SPANS TWO TIERS, because it stopped recording. Measured month by month on
 * the development store, every month from May 2025 to March 2026 carried token
 * counts; from April 2026 on there are none — 59 assistant turns that April, more
 * than March had, and not one with a count. The field is still written, as a zero.
 * So Cursor's local usage is an ARCHIVE, not a live feed: turns up to the cutoff are
 * `exact`, and turns after it are `activity_only` — the call demonstrably happened,
 * the tool no longer records what it cost. Inferring a count for the recent ones
 * from text length would be inventing the very number Cursor stopped publishing.
 *
 * TIMESTAMPS: a bubble's own `createdAt` is used when present (about 18% of them).
 * Otherwise it is placed by linear interpolation across its conversation's span, by
 * ordinal in `fullConversationHeadersOnly`. Stamping a whole conversation at its
 * start would drop ninety-odd calls onto one millisecond and manufacture a
 * burn-rate spike out of nothing. Both branches are deterministic and re-derivable,
 * which is what lets verify check them.
 *
 * COST IS USUALLY NULL. A bubble records no model, and the conversation's own model
 * field is typically absent or a placeholder like `default`, so most rows price as
 * unknown rather than $0 — the same shape as Codex: exact tokens, unknown cost.
 */

/**
 * How long a source may go without a single measured token before the collector says
 * so. Long enough not to fire on a quiet fortnight, short enough to catch a tool that
 * has silently stopped recording.
 */
const STALE_TOKENS_AFTER_DAYS = 30;

/** One conversation's timing envelope and message order, from `composerData:<id>`. */
interface Composer {
  createdAt: number | null;
  lastUpdatedAt: number | null;
  model: string | null;
  /** bubbleId -> ordinal, in conversation order. */
  order: Map<string, number>;
  size: number;
}

/**
 * Places a bubble in time within its conversation.
 *
 * Exported for verify: the re-derivation has to run the exact same arithmetic, and a
 * second copy of it in the verifier would drift from this one.
 */
export function bubbleTs(c: Composer, ordinal: number, fallback: number): number {
  const start = c.createdAt ?? c.lastUpdatedAt;
  if (start === null) return fallback;
  const end = c.lastUpdatedAt ?? start;
  if (end <= start || c.size <= 1) return start;
  const step = (end - start) / (c.size - 1);
  return Math.round(start + step * Math.min(ordinal, c.size - 1));
}

function loadComposers(src: DB): Map<string, Composer> {
  const out = new Map<string, Composer>();
  // json_extract keeps the heavy payloads inside SQLite: these rows carry whole code
  // chunks, and parsing all of them in JS to read three scalars is what made a naive
  // pass on a 400 MB store unusable.
  const rows = src
    .prepare(
      `SELECT substr(key, 14)                              AS id,
              json_extract(value, '$.createdAt')           AS createdAt,
              json_extract(value, '$.lastUpdatedAt')       AS lastUpdatedAt,
              json_extract(value, '$.modelId')             AS modelId,
              json_extract(value, '$.modelName')           AS modelName,
              json_extract(value, '$.fullConversationHeadersOnly') AS headers
         FROM cursorDiskKV
        WHERE key LIKE 'composerData:%'`,
    )
    .all() as {
    id: string;
    createdAt: number | null;
    lastUpdatedAt: number | null;
    modelId: string | null;
    modelName: string | null;
    headers: string | null;
  }[];

  for (const r of rows) {
    const order = new Map<string, number>();
    if (r.headers) {
      try {
        const list = JSON.parse(r.headers) as { bubbleId?: string }[];
        if (Array.isArray(list)) {
          list.forEach((h, i) => {
            if (h && typeof h.bubbleId === 'string') order.set(h.bubbleId, i);
          });
        }
      } catch {
        /* a malformed header list costs ordering, not the row */
      }
    }
    // `default` is Cursor's placeholder for "whatever the picker was on", which is
    // not a model id and must not be priced as one.
    const model = r.modelId ?? (r.modelName && r.modelName !== 'default' ? r.modelName : null);
    out.set(r.id, {
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : null,
      lastUpdatedAt: typeof r.lastUpdatedAt === 'number' ? r.lastUpdatedAt : null,
      model,
      order,
      size: order.size,
    });
  }
  return out;
}

export function collectCursor(db: DB): CollectorResult {
  const statePath = paths.cursorStateDb();
  const events: UsageEvent[] = [];
  const notes: string[] = [];

  if (!existsSync(statePath)) {
    return {
      tool: 'cursor',
      events,
      filesScanned: 0,
      notes: [`No Cursor state store at ${statePath}`],
      sourceState: 'no_source',
    };
  }

  // The store is large and rewritten constantly; skip the pass entirely when the file
  // has not changed since the last one.
  const mtime = Math.trunc(statSync(statePath).mtimeMs);
  const cursorKey = 'cursor:state-mtime';
  const seen = getState(db, cursorKey);
  if (seen && seen.last_mtime === mtime) {
    return { tool: 'cursor', events, filesScanned: 1, notes: ['No change since the last pass.'] };
  }

  let src: DB;
  try {
    // Read-only: Cursor is usually running and holding this file.
    src = new Database(statePath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return {
      tool: 'cursor',
      events,
      filesScanned: 0,
      notes: [`Could not open Cursor state store read-only: ${(err as Error).message}`],
      sourceState: 'error',
    };
  }

  try {
    const composers = loadComposers(src);

    // Every real assistant turn, whether or not Cursor recorded tokens for it. A turn
    // with neither tokens nor text is a placeholder the editor never filled in — not
    // evidence that a call happened — so those are left out entirely.
    const bubbles = src
      .prepare(
        `SELECT key,
                json_extract(value, '$.tokenCount.inputTokens')  AS inTok,
                json_extract(value, '$.tokenCount.outputTokens') AS outTok,
                json_extract(value, '$.createdAt')               AS createdAt
           FROM cursorDiskKV
          WHERE key LIKE 'bubbleId:%'
            AND json_extract(value, '$.type') = 2
            AND (json_extract(value, '$.tokenCount.inputTokens')  > 0
              OR json_extract(value, '$.tokenCount.outputTokens') > 0
              OR trim(coalesce(json_extract(value, '$.text'), '')) <> '')`,
      )
      .all() as {
      key: string;
      inTok: number | null;
      outTok: number | null;
      createdAt: string | null;
    }[];

    let unplaced = 0;
    for (const b of bubbles) {
      const parts = b.key.split(':');
      if (parts.length < 3) continue;
      const composerId = parts[1]!;
      const bubbleId = parts[2]!;
      const c = composers.get(composerId);

      const input = count(b.inTok);
      const output = count(b.outTok);
      // Cursor stopped persisting token counts locally around April 2026 — the field
      // is still written, as a zero. A turn with real text but no count is a real
      // call whose usage the tool no longer records: activity_only, never a guess.
      const measured = input > 0 || output > 0;

      // A bubble's own createdAt is exact when present (~18% of them); interpolation
      // across the conversation is the fallback, not the first choice.
      const own = b.createdAt ? Date.parse(b.createdAt) : NaN;
      let ts: number;
      if (Number.isFinite(own)) {
        ts = own;
      } else if (c) {
        ts = bubbleTs(c, c.order.get(bubbleId) ?? 0, mtime);
      } else {
        // A bubble whose conversation record is gone cannot be placed in time at all.
        // Dropping it would silently lose real spend, so it is kept at the store's
        // own mtime and counted in a note rather than pretending to a real time.
        ts = mtime;
        unplaced++;
      }

      events.push({
        event_key: `cursor:bubble:${composerId}:${bubbleId}`,
        tool: 'cursor',
        model: c?.model ?? null,
        session_id: composerId,
        project: null,
        git_branch: null,
        ts,
        input_tokens: measured ? input : null,
        output_tokens: measured ? output : null,
        // Cursor reports no cache split; absent, not zero.
        cache_write_5m_tokens: null,
        cache_write_1h_tokens: null,
        cache_read_tokens: null,
        reasoning_tokens: null,
        total_tokens: measured ? sumCounts(input, output) : null,
        // No model on the row means no rate: unknown, never $0.
        cost_usd: null,
        confidence: measured ? 'exact' : 'activity_only',
        estimation_method: null,
        is_error: 0,
        stop_reason: null,
        source: 'live',
        raw_ref: `${statePath}#bubbleId:${composerId}:${bubbleId}`,
        tools: null,
        agent_id: null,
        context_window: null,
        duration_ms: null,
        duration_kind: null,
      });
    }

    const measuredRows = events.filter((e) => e.confidence === 'exact');
    const newestMeasured = measuredRows.reduce((n, e) => Math.max(n, e.ts), 0);
    notes.push(
      `${measuredRows.length} message(s) with exact token counts, ` +
        `${events.length - measuredRows.length} activity-only. Cost is unknown: Cursor ` +
        'records no model on a message.',
    );
    // A parser that still works on a source that has gone quiet looks identical to a
    // healthy one, and the number it reports simply stops growing. Say so out loud.
    if (newestMeasured > 0) {
      const days = Math.floor((Date.now() - newestMeasured) / 86_400_000);
      if (days >= STALE_TOKENS_AFTER_DAYS) {
        notes.push(
          `No token counts recorded for ${days} days (newest ${new Date(newestMeasured)
            .toISOString()
            .slice(0, 10)}). Cursor stopped persisting them locally; recent turns are ` +
            'activity-only and this total will not grow.',
        );
      }
    }
    if (unplaced > 0) {
      notes.push(`${unplaced} message(s) had no surviving conversation record to place them in time.`);
    }
    setState(db, cursorKey, 'cursor', 0, mtime);
  } catch (err) {
    notes.push(`Cursor state query failed: ${(err as Error).message}`);
  } finally {
    src.close();
  }

  return { tool: 'cursor', events, filesScanned: 1, notes };
}
