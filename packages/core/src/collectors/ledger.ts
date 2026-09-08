import type { DB } from '../db';

/**
 * Collector-side ledger writes for the tables the foundation migrations
 * created but no collector filled (tier 5/6/7/8). Everything here is an
 * idempotent upsert on the table's own UNIQUE key, written from the parse
 * loop or the collector's `commit` (after insertEvents, so `observed_at`
 * stamping sees stored rows). NULL-only widening throughout: a stored fact
 * is never overwritten by a re-derived one.
 */

// ── event_links: the vendor-join key ledger (tier 7 #37) ──────────────────────

export interface EventLinkRow {
  event_key: string;
  vendor: string;
  link_kind: string; // toolu_id | response_id | turn_id | root_turn_id | thread_id | request_id | prompt_id | web_search_requests | ...
  link_id: string;
}

const INSERT_LINK = `
INSERT INTO event_links (event_key, vendor, link_kind, link_id, first_seen)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(event_key, vendor, link_kind, link_id) DO NOTHING`;

export function insertEventLinks(db: DB, rows: EventLinkRow[]): number {
  if (!rows.length) return 0;
  const stmt = db.prepare(INSERT_LINK);
  const now = Date.now();
  return db.transaction(() => {
    let n = 0;
    for (const r of rows) n += stmt.run(r.event_key, r.vendor, r.link_kind, r.link_id, now).changes;
    return n;
  })();
}

// ── agent_edges: the spawn tree (tier 5) ─────────────────────────────────────

export interface AgentEdgeRow {
  edge_key: string;
  session_id: string;
  agent_id?: string | null;
  parent_agent_id?: string | null;
  workflow_id?: string | null;
  agent_type?: string | null;
  spawn_depth?: number | null;
  parent_call_key?: string | null;
}

const INSERT_EDGE = `
INSERT INTO agent_edges
  (edge_key, session_id, agent_id, parent_agent_id, workflow_id, agent_type, spawn_depth, parent_call_key, first_seen, last_seen)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(edge_key) DO UPDATE SET
  agent_type = COALESCE(agent_edges.agent_type, excluded.agent_type),
  spawn_depth = COALESCE(agent_edges.spawn_depth, excluded.spawn_depth),
  last_seen = excluded.last_seen`;

export function insertAgentEdges(db: DB, rows: AgentEdgeRow[]): number {
  if (!rows.length) return 0;
  const stmt = db.prepare(INSERT_EDGE);
  const now = Date.now();
  return db.transaction(() => {
    let n = 0;
    for (const r of rows) {
      n += stmt.run(
        r.edge_key, r.session_id, r.agent_id ?? null, r.parent_agent_id ?? null,
        r.workflow_id ?? null, r.agent_type ?? null, r.spawn_depth ?? null,
        r.parent_call_key ?? null, now, now,
      ).changes;
    }
    return n;
  })();
}

// ── two clocks: observed_at, stamped only where still NULL ───────────────────

/**
 * The collector's clock on every row (tier 7 #39). `insertEvents` cannot
 * write the column (its upsert predates it), so the collector's commit stamps
 * it NULL-only after the rows are stored. The difference `observed_at - ts`
 * is the measured observation lag; a row whose source timestamp was invented
 * (the Date.now() fallback) shows a lag near zero — labelled by that fact,
 * not by a column the schema does not carry (flagged for a foundation change).
 */
export function stampObservedAt(db: DB, eventKeys: string[], observedAt: number): number {
  if (!eventKeys.length) return 0;
  const stmt = db.prepare('UPDATE usage_events SET observed_at = ? WHERE event_key = ? AND observed_at IS NULL');
  return db.transaction(() => {
    let n = 0;
    for (const k of eventKeys) n += stmt.run(observedAt, k).changes;
    return n;
  })();
}

// ── session_identity: the session-proved plan (tier 3 #21) ───────────────────

/**
 * Codex's rate_limits payload proves the plan from the session's own file —
 * never from auth.json (which holds three live tokens). Stored NULL-only:
 * buildSessionIdentity's rebuild upserts only last_seen, so a collector-written
 * plan survives, and a stored plan is never downgraded.
 */
export function recordSessionPlan(
  db: DB,
  sessionId: string,
  plan: string,
  tool: string,
  ts: number,
): void {
  db.prepare(
    `INSERT INTO session_identity (session_id, tool, plan, binding_evidence, first_seen, last_seen)
     VALUES (?, ?, ?, 'session_proved', ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       plan             = COALESCE(session_identity.plan, excluded.plan),
       tool             = COALESCE(session_identity.tool, excluded.tool),
       binding_evidence = CASE WHEN session_identity.binding_evidence IN ('session_proved', 'store_origin')
                                 THEN session_identity.binding_evidence
                                 ELSE 'session_proved' END,
       last_seen        = excluded.last_seen`,
  ).run(sessionId, tool, plan, ts, ts);
}

// ── quota_observations: the meter's own limits (tier 8 seam) ────────────────

export interface QuotaRow {
  tool: string;
  session_id: string | null;
  ts: number;
  kind: string;
  used_percent?: number | null;
  limit_value?: number | null;
  reset_at?: number | null;
}

export function insertQuotaObservations(db: DB, rows: QuotaRow[]): number {
  if (!rows.length) return 0;
  const stmt = db.prepare(
    `INSERT INTO quota_observations (tool, session_id, ts, kind, used_percent, limit_value, reset_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tool, session_id, ts, kind) DO NOTHING`,
  );
  return db.transaction(() => {
    let n = 0;
    for (const r of rows) {
      n += stmt.run(r.tool, r.session_id, r.ts, r.kind, r.used_percent ?? null, r.limit_value ?? null, r.reset_at ?? null).changes;
    }
    return n;
  })();
}

// ── tool_calls widening: the posture columns INSERT_CALL does not carry ──────

export interface ToolCallWiden {
  server?: string | null;
  tool_name?: string | null;
  permission_mode?: string | null;
  autonomy_rank?: string | null;
  target_scope?: string | null;
  origin_kind?: string | null;
  execution_context_id?: string | null;
  authority_evidence?: string | null;
  authorization_basis?: string | null;
}

/**
 * Fills the tier-5/6 posture columns on stored tool_calls rows, NULL-only.
 * The two-phase bind's INSERT cannot carry them (its upsert predates the
 * migration), so a collector that knows the turn's posture widens the calls
 * it emitted in that turn by their source-native key.
 */
export function widenToolCalls(db: DB, keys: string[], w: ToolCallWiden): number {
  if (!keys.length) return 0;
  const cols = Object.entries(w).filter(([, v]) => v !== undefined && v !== null);
  if (!cols.length) return 0;
  const setSql = cols.map(([k]) => `${k} = COALESCE(tool_calls.${k}, ?)`).join(', ');
  const stmt = db.prepare(`UPDATE tool_calls SET ${setSql} WHERE tool_call_key = ?`);
  return db.transaction(() => {
    let n = 0;
    for (const k of keys) n += stmt.run(...cols.map(([, v]) => v), k).changes;
    return n;
  })();
}

// ── Grok upload posture: bulk_uploads + upload_decisions (tier 5 #7) ─────────

export interface UploadStart {
  upload_key: string;
  repo_path?: string | null;
  turn?: number | null;
  max_file_bytes?: number | null;
  phase?: string | null;
  started_at?: number | null;
}

const UPSERT_UPLOAD = `
INSERT INTO bulk_uploads (upload_key, repo_path, turn, max_file_bytes, started_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(upload_key) DO UPDATE SET
  repo_path      = COALESCE(bulk_uploads.repo_path, excluded.repo_path),
  turn           = COALESCE(bulk_uploads.turn, excluded.turn),
  max_file_bytes = COALESCE(bulk_uploads.max_file_bytes, excluded.max_file_bytes),
  started_at     = COALESCE(bulk_uploads.started_at, excluded.started_at)`;

/** The start of a repo-state upload: size stays NULL until (unless) an enqueued line lands. */
export function recordUploadStart(db: DB, u: UploadStart): void {
  db.prepare(UPSERT_UPLOAD).run(u.upload_key, u.repo_path ?? null, u.turn ?? null, u.max_file_bytes ?? null, u.started_at ?? null);
}

export interface UploadEnqueued {
  upload_key: string;
  size_bytes?: number | null;
  gcs_path?: string | null;
  blobs?: number | null;
}

const WIDEN_UPLOAD = `
UPDATE bulk_uploads SET
  size_bytes = COALESCE(size_bytes, ?),
  gcs_path   = COALESCE(gcs_path, ?),
  blobs      = COALESCE(blobs, ?)
WHERE upload_key = ?`;

/** The receipt: the compressed size exists only on enqueued records. NULL-only widen. */
export function recordUploadEnqueued(db: DB, u: UploadEnqueued): void {
  db.prepare(WIDEN_UPLOAD).run(u.size_bytes ?? null, u.gcs_path ?? null, u.blobs ?? null, u.upload_key);
}

export interface UploadDecision {
  upload_key: string;
  ts: number | null;
  uploads_enabled?: number | null;
  upload_reason?: string | null;
  trace_upload_source?: string | null;
  telemetry_mode?: string | null;
  data_collection_disabled?: number | null;
  in_env_trace_upload?: number | null;
  in_cfg_telemetry_trace_upload?: number | null;
  in_remote_trace_upload_enabled?: number | null;
  has_remote_settings?: number | null;
  in_requirement_pin?: number | null;
  telemetry_source?: string | null;
}

/**
 * One row per decision, one column per input in the vendor's own precedence
 * chain — the columns are the inputs, so the ladder can be rendered env →
 * config → remote → effective without inventing anything.
 * (in_requirement_pin and telemetry_source are parsed from the line but the
 * table carries no column for them — flagged for a foundation change.)
 */
export function recordUploadDecision(db: DB, d: UploadDecision): void {
  db.prepare(
    `INSERT INTO upload_decisions (
       upload_key, uploads_enabled, upload_reason, trace_upload_source, telemetry_mode,
       data_collection_disabled, in_env_trace_upload, in_cfg_telemetry_trace_upload,
       in_remote_trace_upload_enabled, has_remote_settings, in_requirement_pin, telemetry_source, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(upload_key) DO NOTHING`,
  ).run(
    d.upload_key,
    d.uploads_enabled ?? null,
    d.upload_reason ?? null,
    d.trace_upload_source ?? null,
    d.telemetry_mode ?? null,
    d.data_collection_disabled ?? null,
    d.in_env_trace_upload ?? null,
    d.in_cfg_telemetry_trace_upload ?? null,
    d.in_remote_trace_upload_enabled ?? null,
    d.has_remote_settings ?? null,
    d.in_requirement_pin ?? null,
    d.telemetry_source ?? null,
    d.ts,
  );
}

// ── posture_levers: config-read posture, evidence attached (tier 4/6) ────────

export interface PostureLeverRow {
  agent: string;
  lever: string;
  observed_value: string | null;
  source_file: string;
}

/** e.g. Gemini CLI's telemetry.logPrompts — the DLP fact that full prompts land on disk. */
export function recordPostureLever(db: DB, r: PostureLeverRow): void {
  db.prepare(
    `INSERT INTO posture_levers (agent, lever, observed_value, source_file, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent, lever, source_file) DO UPDATE SET
       observed_value = COALESCE(excluded.observed_value, posture_levers.observed_value),
       last_seen = excluded.last_seen`,
  ).run(r.agent, r.lever, r.observed_value, r.source_file, Date.now(), Date.now());
}
