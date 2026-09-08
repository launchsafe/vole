/**
 * Tier 7 triage: case identity, structured incident detail, and the
 * append-only disposition ledger.
 *
 * CASE KEY — every time-bucketed rule ends its anomaly_key in the UTC bucket
 * epoch, so the "stable key" triage assumes is not stable across recurrences:
 * the same runaway loop in the next window is a different row. The case key
 * is the identical tuple minus the bucket — rule + source + subject dims —
 * and never a session for billable_burn_spike / rerouted_model, whose stored
 * session_id is merely the FIRST event of the window, not the case's owner.
 * Never now()-derived: the same finding always maps to the same case.
 *
 * STRUCTURED DETAIL — anomalies.detail is free text and the column most
 * likely to leave the machine. detail_key + detail_params (JSON) let an
 * exporter drop or hash individual parameters while the app renders the full
 * sentence locally. The renderer is reader work (Swift + util/format); this
 * module owns the vocabulary and the backfill that stamps existing rows.
 *
 * THE LEDGER — finding_actions is append-only, never UPDATEd, never DELETEd.
 * Writes arrive as one JSON line per action in ~/.vole/inbox/actions.jsonl
 * (O_APPEND, a single write syscall), and the collector ingests them using a
 * byte-offset cursor on that file — the same discipline claude-code.ts uses
 * on transcripts. Two clocks are stored: ts from the writer, ingested_at
 * from the collector, and rows are ingested in arrival order, never
 * reordered. The latest action per case is denormalised onto
 * anomalies.state/state_ts/state_actor by one idempotent statement, so
 * replaying the ledger converges and re-running the collector changes
 * nothing.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DB } from '../db';
import { paths } from '../paths';
import type { AnomalyRule, Source } from '../types';

// ── Case identity ────────────────────────────────────────────────────────────

/** Rules whose anomaly_key ends in a UTC bucket epoch, with their subject dims. */
const BUCKETED_CASE_DIMS: Partial<Record<AnomalyRule, number>> = {
  // key = `<rule>:<tool>:<model>:<session>:<bucket>` — the session is evs[0],
  // not the case owner, so the case dims are tool+model (segments 1..2).
  billable_burn_spike: 2,
  rerouted_model: 2,
  // key = `<rule>:<tool>:<session>:<bucket>` — dims tool+session.
  error_storm: 2,
  context_pressure: 2,
  rate_limit_pressure: 2,
  // key = `<rule>:<tool>:<session>:<agent>:<bucket>` — dims tool+session+agent.
  repeat_call_loop: 3,
};

export interface CaseSubject {
  anomaly_key: string;
  rule: AnomalyRule;
  source: Source;
}

/**
 * The case identity beneath the time bucket. Deterministic, never
 * now()-derived: stripping the bucket from the same key always yields the
 * same case. Non-bucketed rules (the behaviour ledgers, keyed by
 * tool_call_key or session) are their own case minus the source prefix.
 */
export function caseKeyOf(s: CaseSubject): string {
  // detectBySource folds the source in as a prefix so live/seed buckets never
  // collide; the case keeps that partition.
  const stripped = s.anomaly_key.replace(/^(live|seed):/, '');
  const dims = BUCKETED_CASE_DIMS[s.rule];
  if (dims === undefined) return `${s.source}:${stripped}`;
  const seg = stripped.split(':');
  // The bucket is the trailing numeric segment; guard so a key that does not
  // end in digits degrades to its full self rather than a wrong case.
  if (!/^\d+$/.test(seg[seg.length - 1] ?? '')) return `${s.source}:${stripped}`;
  const kept = seg.slice(0, 1 + dims); // rule + dims
  return `${s.source}:${kept.join(':')}`;
}

/**
 * Stamps case_key / detail_key / detail_params on stored anomalies that lack
 * them. NULL-only widening: a stored fact is never overwritten, so a pack
 * bump that mints a new case dims set can never rewrite history silently —
 * it simply leaves the old rows carrying the case they were filed under.
 */
export function applyCaseIdentity(db: DB): number {
  const rows = db
    .prepare(
      'SELECT anomaly_key, rule, source, tool, model, session_id, observed, baseline, threshold, detail FROM anomalies WHERE case_key IS NULL',
    )
    .all() as {
    anomaly_key: string;
    rule: AnomalyRule;
    source: Source;
    tool: string;
    model: string | null;
    session_id: string | null;
    observed: number;
    baseline: number | null;
    threshold: number | null;
    detail: string;
  }[];
  const upd = db.prepare(
    'UPDATE anomalies SET case_key = ?, detail_key = ?, detail_params = ? WHERE anomaly_key = ? AND case_key IS NULL',
  );
  let n = 0;
  for (const r of rows) {
    const dk = detailKeyOf(r.rule);
    const params = JSON.stringify({
      tool: r.tool,
      model: r.model,
      session_id: r.session_id,
      observed: r.observed,
      baseline: r.baseline,
      threshold: r.threshold,
    });
    upd.run(caseKeyOf(r), dk, params, r.anomaly_key);
    n++;
  }
  return n;
}

// ── Structured incident detail ────────────────────────────────────────────────

/** Template keys: the sentence a rule composes, as key + parameters. */
export const DETAIL_TEMPLATES: Record<string, string> = {
  burn_spike: '{observed} in a 10-min window ({rate}/min across the group) — {multiple} this {subject}\'s typical {baseline} window.',
  loop: 'The same call repeated {observed} times in a window (baseline {baseline}).',
  error_storm: '{observed} failed calls in a window (threshold {threshold}).',
  rate_limit: 'Rate-limit headroom at {used_percent}% of the window (threshold {threshold}%).',
  context_pressure: 'Context reached {observed} tokens ({pct}% of window).',
  rerouted_model: 'Model {model} answered under tool {tool}, outside its usual route.',
  behaviour: '{rule} fired: observed {observed}.',
};

/** The template key a rule's sentences render from. */
export function detailKeyOf(rule: AnomalyRule): string {
  switch (rule) {
    case 'billable_burn_spike': return 'burn_spike';
    case 'repeat_call_loop': return 'loop';
    case 'error_storm':
    case 'tool_failure_storm': return 'error_storm';
    case 'rate_limit_pressure': return 'rate_limit';
    case 'context_pressure': return 'context_pressure';
    case 'rerouted_model': return 'rerouted_model';
    default: return 'behaviour';
  }
}

/** Renders the sentence locally from key + params (the app and tests use this). */
export function renderDetail(detail_key: string, params: Record<string, unknown>): string {
  const t = DETAIL_TEMPLATES[detail_key];
  if (!t) return '';
  return t.replace(/\{(\w+)\}/g, (_, k: string) => (params[k] === undefined || params[k] === null ? '—' : String(params[k])));
}

// ── The disposition ledger ────────────────────────────────────────────────────

/** Terminal states: a case reaches one of these and stops. */
export const TERMINAL_ACTION_STATES = ['resolved', 'false_positive', 'expected', 'accepted_risk'] as const;

export type ActionState =
  | 'acknowledged'
  | 'muted'
  | 'escalated'
  | 'reopened'
  | 'queue_opened'
  | (typeof TERMINAL_ACTION_STATES)[number];

export const ACTION_STATES: ActionState[] = [
  'acknowledged', 'muted', 'escalated', 'reopened', 'queue_opened',
  'resolved', 'false_positive', 'expected', 'accepted_risk',
];

export interface LedgerAction {
  /** Deterministic, idempotent: content hash of the action, not a clock. */
  action_id: string;
  case_key?: string | null;
  anomaly_key: string;
  state: ActionState;
  actor?: string | null;
  actor_kind?: 'human' | 'machine' | 'app' | null;
  reason_code?: string | null;
  note?: string | null;
  /** MANDATORY for a mute: epoch-ms after which it no longer applies. */
  expires_at?: number | null;
  content_rev?: number | null;
  label_mode?: 'single' | 'bulk' | null;
  batch_id?: string | null;
  ts: number;
  source?: 'live' | 'seed' | 'app' | null;
}

/** A mute without an expiry is permanent silence by omission: rejected. */
export function validateAction(a: LedgerAction): string | null {
  if (!a.anomaly_key) return 'anomaly_key is required';
  if (!ACTION_STATES.includes(a.state)) return `unknown action state: ${a.state}`;
  if (a.state === 'muted' && (a.expires_at === null || a.expires_at === undefined)) {
    return 'a mute must carry expires_at — a mute can never become permanent silence by omission';
  }
  return null;
}

/**
 * Deterministic action id: the same action content always hashes to the same
 * id, so a spool replayed after a crash converges instead of duplicating.
 * Never derived from now() alone — the caller's ts is part of the intent.
 */
export function actionId(a: Omit<LedgerAction, 'action_id'>): string {
  const h = createHash('sha256');
  h.update(`${a.anomaly_key}|${a.state}|${a.actor ?? ''}|${a.ts}|${a.note ?? ''}|${a.batch_id ?? ''}`);
  return `fa:${h.digest('hex').slice(0, 24)}`;
}

/** The batch id a bulk disposition shares: hash of actor + exact case list + state. */
export function batchId(actor: string, anomalyKeys: string[], state: ActionState): string {
  const h = createHash('sha256');
  h.update(`${actor}|${[...anomalyKeys].sort().join(',')}|${state}`);
  return `batch:${h.digest('hex').slice(0, 16)}`;
}

// ── The spool: ~/.vole/inbox/actions.jsonl ───────────────────────────────────

export function actionsSpoolPath(dbPath: string = paths.db()): string {
  return join(dirname(dbPath), 'inbox', 'actions.jsonl');
}

/**
 * Appends ONE JSON object as ONE line with O_APPEND and a single write
 * syscall — the spool discipline the single-writer store depends on. The
 * app (a read-only consumer of the store) never writes the database.
 */
export function spoolAction(a: Omit<LedgerAction, 'action_id'>, dbPath: string = paths.db()): { action_id: string } {
  const err = validateAction({ ...a, action_id: '' });
  if (err) throw new Error(err);
  const action_id = actionId(a);
  const line = JSON.stringify({ ...a, action_id }) + '\n';
  const file = actionsSpoolPath(dbPath);
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, 'a'); // O_APPEND: concurrent appenders cannot interleave
  try {
    writeSync(fd, line); // one write syscall, one line
  } finally {
    closeSync(fd);
  }
  return { action_id };
}

// ── Ingestion: the byte-offset cursor ────────────────────────────────────────

export interface IngestResult {
  ingested: number;
  duplicates: number;
  malformed: number;
  /** New byte offset to persist as the cursor. */
  offset: number;
}

/**
 * Reads actions.jsonl from `offset` to EOF, inserting each complete line into
 * finding_actions inside the caller's single-writer transaction. Idempotent
 * on action_id; a trailing partial line (a crash mid-write) is left unread —
 * the cursor only ever advances over COMPLETE lines plus their newline.
 * Byte-wise over a Buffer, so a non-ASCII note cannot skew the cursor.
 * Ingested in arrival order, never reordered; ingested_at is the collector's
 * clock and ts stays the writer's.
 */
export function ingestActions(db: DB, fromOffset: number, dbPath: string = paths.db(), now: number = Date.now()): IngestResult {
  const file = actionsSpoolPath(dbPath);
  const res: IngestResult = { ingested: 0, duplicates: 0, malformed: 0, offset: fromOffset };
  if (!existsSync(file)) return res;
  const buf = readFileSync(file);
  if (fromOffset >= buf.length) return res;
  const insert = db.prepare(
    `INSERT INTO finding_actions
       (action_id, case_key, anomaly_key, action, note, until, actor, created_at,
        actor_kind, reason_code, content_rev, label_mode, batch_id, source, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const seen = db.prepare('SELECT 1 AS x FROM finding_actions WHERE action_id = ?');
  let pos = fromOffset;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break; // partial trailing line: leave for the next pass
    const line = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    let a: (LedgerAction & { until?: number | null });
    try {
      a = JSON.parse(line) as typeof a;
    } catch {
      res.malformed++;
      continue;
    }
    if (!a.action_id || !a.anomaly_key || !a.state) { res.malformed++; continue; }
    if (a.state === 'muted' && (a.expires_at ?? a.until) == null) {
      // A mute without expiry never becomes silence: refused at ingest too.
      res.malformed++;
      continue;
    }
    if (seen.get(a.action_id)) { res.duplicates++; continue; }
    insert.run(
      a.action_id, a.case_key ?? null, a.anomaly_key, a.state, a.note ?? null, a.expires_at ?? a.until ?? null,
      a.actor ?? 'app', a.ts, a.actor_kind ?? null, a.reason_code ?? null, a.content_rev ?? null,
      a.label_mode ?? null, a.batch_id ?? null, a.source ?? 'app', now,
    );
    res.ingested++;
  }
  res.offset = pos;
  return res;
}

/**
 * The spool's byte-offset cursor, kept in collector_state exactly like the
 * claude-code transcript cursor: keyed by the file's path, never by time.
 */
export function actionsCursor(db: DB, dbPath: string = paths.db()): number {
  const row = db
    .prepare('SELECT last_offset FROM collector_state WHERE source_path = ?')
    .get(actionsSpoolPath(dbPath)) as { last_offset: number } | undefined;
  return row?.last_offset ?? 0;
}

export function setActionsCursor(db: DB, offset: number, dbPath: string = paths.db()): void {
  db.prepare(
    `INSERT INTO collector_state (source_path, tool, last_offset, last_mtime, last_scanned_at)
     VALUES (?, 'vole_actions', ?, NULL, ?)
     ON CONFLICT(source_path) DO UPDATE SET last_offset = excluded.last_offset, last_scanned_at = excluded.last_scanned_at`,
  ).run(actionsSpoolPath(dbPath), offset, Date.now());
}

/**
 * The one idempotent denormalisation: the latest action per case lands on
 * anomalies.state/state_ts/state_actor. `state IS NOT ?` + `state_ts < ?`
 * makes replay converge — a re-run changes nothing, and a machine transition
 * never overwrites a newer human label.
 */
export function denormaliseState(db: DB): number {
  const r = db.prepare(
    `UPDATE anomalies SET
       state = f.action, state_ts = f.created_at, state_actor = f.actor
     FROM (
       SELECT case_key, action, created_at, actor,
              ROW_NUMBER() OVER (PARTITION BY case_key ORDER BY created_at DESC, id DESC) AS rn
       FROM finding_actions WHERE case_key IS NOT NULL
     ) f
     WHERE anomalies.case_key = f.case_key AND f.rn = 1
       AND (anomalies.state IS NOT f.action OR anomalies.state_ts IS NULL OR anomalies.state_ts < f.created_at)`,
  ).run();
  return r.changes;
}

/**
 * Backfills case_key onto finding_actions rows that predate it (the spool's
 * older format wrote only anomaly_key). NULL-only: never rewrites a stored case.
 */
export function backfillActionCaseKeys(db: DB): number {
  return db.prepare(
    `UPDATE finding_actions SET case_key = (
       SELECT a.case_key FROM anomalies a WHERE a.anomaly_key = finding_actions.anomaly_key
     ) WHERE case_key IS NULL AND EXISTS (
       SELECT 1 FROM anomalies a WHERE a.anomaly_key = finding_actions.anomaly_key AND a.case_key IS NOT NULL)`,
  ).run().changes;
}
