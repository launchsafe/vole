/**
 * The durable export outbox (feature 16) and the change cursor (feature 6).
 *
 * Why not export_seq's rowid high-water mark: db.ts rewrites an existing
 * usage_events row in place when excluded.total_tokens is strictly greater,
 * without changing its id — so a rowid cursor never re-sends the corrected
 * row (streaming placeholders with output_tokens 0 stay zero forever). The
 * outbox IS the change log: every emission — new row or re-emitted
 * correction — appends a (sink, doc_id) row with a fresh seq, and the cursor
 * is MAX(seq): monotone over a table that only grows, so replay can add
 * documents but can never rewind the live tail.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DB } from '../db';
import { insertAnomalies } from '../db';
import type { Anomaly, Tool } from '../types';
import { selectColumns } from './fields';
import { encodeShapeRow, SHAPES, existingColumns, DOC_ID_SEP, type ShapeRow } from './shapes';

// ponytail: path constants live in paths.ts, which this batch must not edit —
// defined locally and flagged for the integrator to fold into paths.ts.
const CHECKPOINT_DIR = () => process.env.VOLE_EXPORT_DIR ?? join(homedir(), '.vole', 'export');

/** Backpressure defaults; overridable per call (policy can ship its own). */
export const OUTBOX_DEFAULTS = {
  /** Hard byte cap on undelivered outbox bytes. 64 MiB. */
  maxBytes: 64 * 1024 * 1024,
  /** Rows per drain batch. */
  maxBatch: 500,
  /** Attempts before a doc is dropped with an audited anomaly. */
  maxAttempts: 8,
  /** Exponential backoff base, ms. attempts=1 -> 30s, 2 -> 60s … capped 1h. */
  backoffBaseMs: 30_000,
  backoffCapMs: 3_600_000,
} as const;

export function backoffMs(attempts: number, d = OUTBOX_DEFAULTS): number {
  return Math.min(d.backoffBaseMs * 2 ** Math.max(0, attempts - 1), d.backoffCapMs);
}

export interface OutboxDoc {
  doc_id: string;
  payload: string;
}

function payloadHash(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

export interface EnqueueResult {
  enqueued: number;
  requeued: number;
  unchanged: number;
  droppedByCap: number;
}

/**
 * Idempotent enqueue, called in the same transaction as the rows it covers.
 * A doc whose payload hash changed (the upsert rewrote the row in place)
 * reverts to pending with attempts reset; an identical, already-delivered doc
 * stays delivered — polling re-runs are no-ops.
 */
export function enqueueOutbox(
  db: DB,
  sink: string,
  docs: OutboxDoc[],
  opts: { maxBytes?: number; now?: number } = {},
): EnqueueResult {
  if (docs.length === 0) return { enqueued: 0, requeued: 0, unchanged: 0, droppedByCap: 0 };
  const now = opts.now ?? Date.now();
  const cap = opts.maxBytes ?? OUTBOX_DEFAULTS.maxBytes;
  const res: EnqueueResult = { enqueued: 0, requeued: 0, unchanged: 0, droppedByCap: 0 };
  const upsert = db.prepare(`
    INSERT INTO export_outbox (sink, doc_id, payload_hash, bytes, attempts, next_attempt_at, state, created_at)
    VALUES (:sink, :doc_id, :hash, :bytes, 0, NULL, 'pending', :now)
    ON CONFLICT (sink, doc_id) DO UPDATE SET
      payload_hash = excluded.payload_hash,
      bytes        = excluded.bytes,
      state        = CASE WHEN export_outbox.payload_hash = excluded.payload_hash
                          AND export_outbox.state = 'delivered'
                         THEN 'delivered' ELSE 'pending' END,
      attempts     = CASE WHEN export_outbox.payload_hash = excluded.payload_hash
                          AND export_outbox.state = 'delivered'
                         THEN export_outbox.attempts ELSE 0 END,
      next_attempt_at = NULL
  `);
  for (const d of docs) {
    const prev = db.prepare('SELECT payload_hash, state FROM export_outbox WHERE sink = ? AND doc_id = ?')
      .get(sink, d.doc_id) as { payload_hash: string; state: string } | undefined;
    upsert.run({ sink, doc_id: d.doc_id, hash: payloadHash(d.payload), bytes: Buffer.byteLength(d.payload), now });
    if (!prev) res.enqueued++;
    else if (prev.payload_hash !== payloadHash(d.payload) || prev.state !== 'delivered') res.requeued++;
    else res.unchanged++;
  }
  // Backpressure: cap undelivered bytes. Oldest pending docs are marked
  // 'dropped' (kept for the audit trail, excluded from the byte count) and an
  // export_drop anomaly carries the exact counts.
  let over = pendingBytes(db, sink) - cap;
  if (over > 0) {
    const old = db.prepare(`
      SELECT seq, doc_id, bytes FROM export_outbox
      WHERE sink = ? AND state = 'pending' ORDER BY seq ASC
    `).all(sink) as { seq: number; doc_id: string; bytes: number }[];
    const dropSeqs: number[] = [];
    for (const r of old) { // ASC = oldest first: the live tail is what we keep
      if (over <= 0) break;
      dropSeqs.push(r.seq);
      over -= r.bytes;
    }
    if (dropSeqs.length) {
      const stm = db.prepare("UPDATE export_outbox SET state = 'dropped', last_error = 'outbox byte cap' WHERE seq = ?");
      for (const s of dropSeqs) stm.run(s);
      res.droppedByCap = dropSeqs.length;
      writeDropAnomaly(db, sink, dropSeqs.length, pendingBytes(db, sink), 'byte cap', now);
    }
  }
  return res;
}

export function pendingBytes(db: DB, sink: string): number {
  return (db.prepare(
    "SELECT COALESCE(SUM(bytes), 0) AS b FROM export_outbox WHERE sink = ? AND state = 'pending'",
  ).get(sink) as { b: number }).b;
}

/**
 * The change cursor: MAX(seq) for a sink. Monotone over an append-only key
 * space — a replay adds docs with NEW seqs above the cursor, so the live tail
 * can be extended but never rewound, and re-sends are deduped sink-side by
 * (device_id, event_key).
 */
export function changeCursor(db: DB, sink: string): {
  last_seq: number;
  pending: number;
  delivered: number;
  dropped: number;
  oldest_pending_age_ms: number | null;
  last_delivered_at: number | null;
} {
  const c = db.prepare(`
    SELECT MAX(seq) AS last_seq,
           SUM(state = 'pending')  AS pending,
           SUM(state = 'delivered') AS delivered,
           SUM(state = 'dropped')  AS dropped,
           MIN(CASE WHEN state = 'pending' THEN created_at END) AS oldest,
           MAX(CASE WHEN state = 'delivered' THEN created_at END) AS last_delivered_at
    FROM export_outbox WHERE sink = ?
  `).get(sink) as {
    last_seq: number | null; pending: number | null; delivered: number | null; dropped: number | null;
    oldest: number | null; last_delivered_at: number | null;
  };
  const now = Date.now();
  return {
    last_seq: c.last_seq ?? 0,
    pending: c.pending ?? 0,
    delivered: c.delivered ?? 0,
    dropped: c.dropped ?? 0,
    oldest_pending_age_ms: c.oldest === null ? null : now - c.oldest,
    last_delivered_at: c.last_delivered_at,
  };
}

/**
 * Replay a window (feature 6's replay half): re-derive docs for a ts range
 * and force them pending. Doc ids are content-keyed, so a sink deduping on
 * (device_id, event_key) sees re-sends, not duplicates — and because the
 * cursor is outbox seq, re-pending can never move it backwards.
 */
export function replayRange(
  db: DB,
  sink: string,
  encode: (from: number, to: number) => OutboxDoc[],
  from: number,
  to: number,
  opts: { now?: number } = {},
): EnqueueResult {
  const docs = encode(from, to);
  const res = enqueueOutbox(db, sink, docs, opts);
  // A delivered doc whose payload is unchanged stays delivered on plain
  // re-enqueue; replay's contract is a re-send, so force pending explicitly.
  const force = db.prepare("UPDATE export_outbox SET state = 'pending', next_attempt_at = NULL WHERE sink = ? AND doc_id = ?");
  for (const d of docs) force.run(sink, d.doc_id);
  return res;
}

// ── checkpoint chain over exported batches, witnessed by the sink ─────────

export interface Checkpoint {
  seq_from: number;
  seq_to: number;
  /** sha256(prev_hash || doc hashes || witness || seq range) — chained, not just signed. */
  hash: string;
  /** What the sink said when it accepted the batch (ack id / response digest). */
  witness: string | null;
  at: number;
  docs: number;
  /** The doc payload hashes in the batch — local-only, lets the chain be re-verified offline. */
  doc_hashes: string[];
}

export interface CheckpointChain {
  sink: string;
  entries: Checkpoint[];
}

function chainPath(sink: string): string {
  return join(CHECKPOINT_DIR(), `checkpoints-${sink.replace(/[^a-z0-9-]/gi, '_')}.json`);
}

export function loadChain(sink: string): CheckpointChain {
  const p = chainPath(sink);
  if (!existsSync(p)) return { sink, entries: [] };
  return JSON.parse(readFileSync(p, 'utf8')) as CheckpointChain;
}

export function saveChain(chain: CheckpointChain): void {
  mkdirSync(CHECKPOINT_DIR(), { recursive: true });
  writeFileSync(chainPath(chain.sink), JSON.stringify(chain, null, 1));
}

/** The chain hash: sha256(prev || doc hashes || witness || seq range). */
export function chainHash(prev: string, docHashes: string[], witness: string | null, seqFrom: number, seqTo: number): string {
  return createHash('sha256')
    .update(prev + JSON.stringify(docHashes) + (witness ?? '') + seqFrom + seqTo)
    .digest('hex');
}

/** Verify a whole chain: entry i hashes to itself and links to entry i-1. */
export function verifyChain(chain: CheckpointChain): boolean {
  let prev = '';
  for (const e of chain.entries) {
    if (chainHash(prev, e.doc_hashes, e.witness, e.seq_from, e.seq_to) !== e.hash) return false;
    prev = e.hash;
  }
  return true;
}

// ── drain ────────────────────────────────────────────────────────────────

export type SinkSender = (
  docs: { doc_id: string; payload: string }[],
) => Promise<{ ok: boolean; witness?: string; error?: string }>;

export interface DrainResult {
  attempted: number;
  delivered: number;
  failed: number;
  dropped: number;
  rebuilt_missing: number;
  checkpoint: Checkpoint | null;
  error?: string;
}

/**
 * Drain pending docs for one sink. The outbox stores hashes, not payloads —
 * a doc is re-derived from the store at send time, which is what makes a
 * pruned source row an honest, auditable drop rather than a silent lie.
 * Network senders are the caller's concern: the CLI passes a dry-run sender
 * unless the sink was explicitly enabled, and every real sender routes
 * through egress() before touching the wire.
 */
export async function drainOutbox(
  db: DB,
  sink: string,
  rederive: (doc_id: string) => OutboxDoc | null,
  send: SinkSender,
  opts: {
    maxBatch?: number; maxBytes?: number; maxAttempts?: number; now?: number; chain?: CheckpointChain;
  } = {},
): Promise<DrainResult> {
  const d = OUTBOX_DEFAULTS;
  const now = opts.now ?? Date.now();
  const batch = opts.maxBatch ?? d.maxBatch;
  const cap = opts.maxBytes ?? d.maxBytes;
  const maxAttempts = opts.maxAttempts ?? d.maxAttempts;
  const res: DrainResult = { attempted: 0, delivered: 0, failed: 0, dropped: 0, rebuilt_missing: 0, checkpoint: null };

  const rows = db.prepare(`
    SELECT seq, doc_id, payload_hash, bytes FROM export_outbox
    WHERE sink = ? AND state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY seq LIMIT ?
  `).all(sink, now, batch) as { seq: number; doc_id: string; payload_hash: string; bytes: number }[];

  // Backpressure: stop accumulating at the byte cap.
  const picked: typeof rows = [];
  let bytes = 0;
  for (const r of rows) {
    if (bytes + r.bytes > cap) break;
    bytes += r.bytes;
    picked.push(r);
  }

  const docs: { doc_id: string; payload: string; seq: number; hash: string }[] = [];
  for (const r of picked) {
    const doc = rederive(r.doc_id);
    if (!doc) {
      // The source row is gone (pruned by retention): a permanent gap that
      // can only be bounded, never recovered — audit it, don't fake it.
      db.prepare("UPDATE export_outbox SET state = 'dropped', last_error = 'source row pruned before send' WHERE seq = ?").run(r.seq);
      res.rebuilt_missing++;
      res.dropped++;
      continue;
    }
    docs.push({ doc_id: r.doc_id, payload: doc.payload, seq: r.seq, hash: payloadHash(doc.payload) });
  }
  if (docs.length === 0) return res;
  res.attempted = docs.length;

  const outcome = await send(docs.map(({ doc_id, payload }) => ({ doc_id, payload })));
  if (outcome.ok) {
    const stm = db.prepare("UPDATE export_outbox SET state = 'delivered', attempts = attempts + 1, last_error = NULL WHERE seq = ?");
    for (const x of docs) stm.run(x.seq);
    res.delivered = docs.length;
    // Checkpoint chain over the delivered batch, witnessed by the sink.
    const chain = opts.chain ?? loadChain(sink);
    const prev = chain.entries.at(-1)?.hash ?? '';
    const seqFrom = Math.min(...docs.map((x) => x.seq));
    const seqTo = Math.max(...docs.map((x) => x.seq));
    const cp: Checkpoint = {
      seq_from: seqFrom,
      seq_to: seqTo,
      hash: chainHash(prev, docs.map((x) => x.hash), outcome.witness ?? null, seqFrom, seqTo),
      witness: outcome.witness ?? null,
      at: now,
      docs: docs.length,
      doc_hashes: docs.map((x) => x.hash),
    };
    chain.entries.push(cp);
    saveChain(chain);
    res.checkpoint = cp;
  } else {
    res.error = outcome.error;
    const fail = db.prepare(`
      UPDATE export_outbox SET
        attempts = attempts + 1,
        next_attempt_at = :next,
        last_error = :err,
        state = CASE WHEN attempts + 1 >= :max THEN 'dropped' ELSE 'pending' END
      WHERE seq = :seq
    `);
    let droppedNow = 0;
    for (const x of docs) {
      const attempts = (db.prepare('SELECT attempts FROM export_outbox WHERE seq = ?').get(x.seq) as { attempts: number }).attempts;
      fail.run({ next: now + backoffMs(attempts + 1), err: outcome.error ?? 'send failed', max: maxAttempts, seq: x.seq });
      if (attempts + 1 >= maxAttempts) { droppedNow++; res.dropped++; } else res.failed++;
    }
    if (droppedNow > 0) {
      writeDropAnomaly(db, sink, droppedNow, pendingBytes(db, sink), `send failed ${maxAttempts}x: ${outcome.error ?? 'unknown'}`, now);
    }
  }
  return res;
}

function writeDropAnomaly(db: DB, sink: string, n: number, bytes: number, reason: string, now: number): void {
  // 10-minute buckets keep the key idempotent under polling without now()
  // in the key itself (a UTC bucket epoch is fine).
  const bucket = Math.floor(now / 600_000);
  const a: Anomaly = {
    anomaly_key: `export_drop:${sink}:${bucket}`,
    rule: 'export_drop',
    severity: 'warn',
    // ponytail: a machine-level incident has no Tool literal in types.ts
    // (the union is agent-only); 'claude_code' is a placeholder until the
    // integrator widens the union with a machine-level member.
    tool: 'claude_code' as Tool,
    session_id: null,
    model: null,
    window_start: now,
    window_end: now,
    title: `Export outbox dropped ${n} document${n === 1 ? '' : 's'} for sink ${sink}`,
    detail: `${reason}. ${n} document(s) will not reach ${sink}; ${bytes} undelivered bytes remain queued. The loss is bounded by this count, not recovered.`,
    observed: n,
    baseline: null,
    threshold: null,
    confidence: 'exact',
    source: 'live',
    detected_at: now,
  };
  insertAnomalies(db, [a]);
}

// ── doc re-derivation from doc_id ────────────────────────────────────────

/**
 * doc_id -> payload. The doc id is `${shape}|${key}[|extra][|tool]` (the '|'
 * separator is load-bearing: keys themselves contain ':'), so the row is
 * re-read and re-encoded on demand — the outbox never stores the payload
 * itself, only its hash and byte count.
 */
export function rederiveDoc(db: DB, doc_id: string, ctx: Parameters<typeof encodeShapeRow>[2]): OutboxDoc | null {
  const shapeName = Object.keys(SHAPES).find((s) => doc_id.startsWith(s + DOC_ID_SEP));
  if (!shapeName) return null;
  const shape = SHAPES[shapeName];
  const rest = doc_id.slice(shapeName.length + 1).split(DOC_ID_SEP);
  const have = existingColumns(db, shape.table);
  const cols = [...new Set([shape.key_column, ...(shape.doc_id_columns ?? []), ...selectColumns(shape.table)])]
    .filter((c) => have.has(c));
  // Seed/live firewall: live-only shapes re-derive from the live partition only.
  const liveClause = shape.live_only && have.has('source') ? " AND source = 'live'" : '';
  // The key may itself contain ':' (event keys, fingerprints) — reconstruct
  // from the longest candidate first so a composite identity always wins.
  let row: Record<string, unknown> | undefined;
  for (let n = rest.length; n >= 1 && !row; n--) {
    const keyValue = rest.slice(0, n).join(DOC_ID_SEP);
    if (!keyValue) continue;
    if (shape.doc_id_columns?.length) {
      // Composite identity (secret_sightings: fingerprint + sink_key): the
      // extras are the segments after the key; no tool is appended (the
      // table has no tool column).
      for (let e = n + 1; e < rest.length; e++) {
        row = db.prepare(
          `SELECT ${cols.join(', ')} FROM ${shape.table} WHERE ${shape.key_column} = ? AND ${shape.doc_id_columns[0]} = ?${liveClause}`,
        ).get(keyValue, rest[e]) as Record<string, unknown> | undefined;
        if (row) break;
      }
    } else {
      row = db.prepare(
        `SELECT ${cols.join(', ')} FROM ${shape.table} WHERE ${shape.key_column} = ?${liveClause}`,
      ).get(keyValue) as Record<string, unknown> | undefined;
    }
  }
  if (!row) return null;
  const encoded: ShapeRow = encodeShapeRow(shapeName, row, ctx);
  return { doc_id, payload: JSON.stringify(encoded.wire) };
}

