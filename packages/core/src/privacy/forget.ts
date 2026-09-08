/**
 * Tier 8: erasure that survives the next poll, the Art. 19 propagation
 * report, and device decommission (seal, attest, erase).
 *
 * v1's plain DELETE does not work: only the Claude Code collector is
 * incremental, and the other six re-read their entire source every poll, so
 * erased rows reappear within one cycle. Erasure is keyed by SUBJECT, not by
 * time, so a watermark cannot express it — the answer is a subject-keyed
 * register (entries in `suppression`, kind='erasure', distinct from the
 * rule-off register) that the single write path consults before insert. The
 * ingest-side check is the coordinated integration step in db.ts
 * insertEvents/insertAnomalies; this module owns the register, the deletion
 * pass, the report and the audit trail.
 *
 * Erasure in Vole is not erasure on the machine: the underlying transcript
 * in ~/.claude/projects or ~/.codex/sessions still holds the content, and
 * deleting those breaks `claude --resume`. Rows in a signed zip on someone's
 * laptop, or a batch a sink already accepted, cannot be recalled — the
 * report says so rather than pretending otherwise.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { DB } from '../db';
import { paths } from '../paths';
import { encodeFields, type EncodeCtx } from '../export/fields';

/** The register key for one erased subject — the entry insertEvents must check. */
export function erasureRuleId(principalKey: string): string {
  return `erasure:subject:${principalKey}`;
}

export interface ErasureRegisterEntry {
  rule: string;
  reason: string | null;
  suppressed_at: number;
  hidden_count: number;
  kind: string | null;
  entry_id: string | null;
  set_by: string | null;
  expires_at: number | null;
  mode: string | null;
}

/** The register, newest first — the proof that an erasure still holds. */
export function erasureRegister(db: DB): ErasureRegisterEntry[] {
  return db.prepare(
    `SELECT rule, reason, suppressed_at, hidden_count, kind, entry_id, set_by, expires_at, mode
     FROM suppression WHERE kind = 'erasure' ORDER BY suppressed_at DESC`,
  ).all() as ErasureRegisterEntry[];
}

export function isSubjectErased(db: DB, principalKey: string): boolean {
  return (
    (db.prepare(
      `SELECT 1 AS x FROM suppression WHERE kind = 'erasure' AND entry_id = ? AND
        (expires_at IS NULL OR expires_at > ?) LIMIT 1`,
    ).get(principalKey, Date.now()) as { x: number } | undefined) !== undefined
  );
}

/** Session tables the deletion pass walks, in dependency-free order. */
const SESSION_TABLES = [
  'file_writes', 'agent_edges', 'payload_sightings', 'context_edges',
  'fetch_ingress', 'autonomy_intervals', 'tool_calls',
] as const;

export interface ForgetResult {
  principal_key: string;
  deleted: { table: string; rows: number }[];
  /** Rows suppressed at ingest since the erasure — filled by the write path, 0 here. */
  register_entry: string;
  total_rows: number;
}

/**
 * Deletes a subject's live rows and writes the register entry that makes the
 * erasure survive the next poll (once insertEvents consults it). Seed rows
 * are never touched: the seed/live firewall holds on the delete side too.
 * The pseudonymous principal row itself is kept — the register entry and the
 * audit trail key on it, and it is a digest, not a person.
 */
export function forgetSubject(
  db: DB,
  principalKey: string,
  opts: { setBy?: string; now?: number } = {},
): ForgetResult {
  const now = opts.now ?? Date.now();
  const sessions = (
    db.prepare(`SELECT session_id FROM session_identity WHERE principal_key = ?`).all(principalKey) as { session_id: string }[]
  ).map((s) => s.session_id);
  const deleted: { table: string; rows: number }[] = [];
  const ph = sessions.map(() => '?').join(',');
  if (sessions.length > 0) {
    for (const t of SESSION_TABLES) {
      if (t === 'context_edges' || t === 'fetch_ingress') {
        // Keyed by call_key: reach through the tool_calls sessions.
        const rows = db.prepare(
          `DELETE FROM ${t} WHERE call_key IN (SELECT tool_call_key FROM tool_calls WHERE session_id IN (${ph}))`,
        ).run(...sessions).changes;
        deleted.push({ table: t, rows });
      } else {
        const rows = db.prepare(`DELETE FROM ${t} WHERE session_id IN (${ph})`).run(...sessions).changes;
        deleted.push({ table: t, rows });
      }
    }
    // anomalies: only the live partition (seed incidents are demo fiction).
    deleted.push({
      table: 'anomalies (live)',
      rows: db.prepare(`DELETE FROM anomalies WHERE session_id IN (${ph}) AND source = 'live'`).run(...sessions).changes,
    });
    // usage_events BEFORE session_identity: the binding is the second deletion path.
    deleted.push({
      table: 'usage_events (live)',
      rows: db.prepare(`DELETE FROM usage_events WHERE source = 'live' AND (subject_id = ? OR session_id IN (${ph}))`)
        .run(principalKey, ...sessions).changes,
    });
    deleted.push({ table: 'session_identity', rows: db.prepare(`DELETE FROM session_identity WHERE principal_key = ?`).run(principalKey).changes });
  }
  // Rows carrying subject_id but no bound session (imported contexts).
  deleted.push({
    table: 'usage_events (unbound subject)',
    rows: db.prepare(`DELETE FROM usage_events WHERE source = 'live' AND subject_id = ?`).run(principalKey).changes,
  });

  const register = erasureRuleId(principalKey);
  db.prepare(
    `INSERT INTO suppression (rule, reason, suppressed_at, hidden_count, kind, entry_id, set_by, expires_at, mode)
     VALUES (?, ?, ?, 0, 'erasure', ?, ?, NULL, 'mute_scan')
     ON CONFLICT(rule) DO UPDATE SET suppressed_at = excluded.suppressed_at, set_by = excluded.set_by`,
  ).run(register, 'Art. 17 erasure request — subject-keyed, survives re-reads', now, principalKey, opts.setBy ?? 'vole forget');
  return {
    principal_key: principalKey,
    deleted,
    register_entry: register,
    total_rows: deleted.reduce((a, d) => a + d.rows, 0),
  };
}

// ── Art. 19 propagation report ──────────────────────────────────────────────

export interface SinkReport {
  sink: string;
  docs: number;
  last_send: number | null;
  state: string | null;
  recall: 'recalled' | 'cannot_recall' | 'nothing_pending';
  reason: string;
}

export interface Art19Report {
  generated_at: number;
  sinks: SinkReport[];
  network_calls: { caller: string; destination: string; purpose: string | null; ts: number }[];
  /** The honest paragraph: what no report can claim. */
  limits: string[];
}

/**
 * 'Where your data went': one row per sink with target, last send, row count
 * and a recall verdict with its reason. Locally pending outbox documents can
 * be deleted (recalled); a batch a sink already accepted, and any signed zip
 * already on someone's laptop, cannot be — the verdict says so.
 */
export function art19Report(db: DB, opts: { recallPending?: boolean; now?: number } = {}): Art19Report {
  const now = opts.now ?? Date.now();
  const bySink = db.prepare(
    `SELECT sink, COUNT(*) AS docs, MAX(created_at) AS last,
            SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending
     FROM export_outbox GROUP BY sink`,
  ).all() as { sink: string; docs: number; last: number | null; pending: number | null }[];
  const sinks: SinkReport[] = bySink.map((s) => {
    if ((s.pending ?? 0) > 0 && opts.recallPending) {
      db.prepare(`DELETE FROM export_outbox WHERE sink = ? AND state = 'pending'`).run(s.sink);
      return {
        sink: s.sink, docs: s.docs - (s.pending ?? 0), last_send: s.last, state: 'partially sent',
        recall: 'recalled', reason: `${s.pending} pending document(s) deleted before delivery`,
      };
    }
    if ((s.pending ?? 0) > 0) {
      return {
        sink: s.sink, docs: s.docs, last_send: s.last, state: 'pending',
        recall: 'nothing_pending', reason: 'pass --recall-pending to delete undelivered documents',
      };
    }
    return {
      sink: s.sink, docs: s.docs, last_send: s.last, state: 'sent',
      recall: 'cannot_recall', reason: 'a batch this sink already accepted cannot be recalled — inform the recipient',
    };
  });
  return {
    generated_at: now,
    sinks,
    network_calls: db.prepare(
      `SELECT caller, destination, purpose, ts FROM network_calls ORDER BY ts DESC LIMIT 50`,
    ).all() as Art19Report['network_calls'],
    limits: [
      'erasure in Vole is not erasure on the machine — the agents\' own transcripts under ~/.claude, ~/.codex, opencode.db and the Devin stores still hold the content; deleting them is the vendor\'s data and breaks `claude --resume`',
      'rows in a signed zip on someone\'s laptop, or a batch a SIEM endpoint already accepted, cannot be recalled',
      'the register entry suppresses re-ingest on this device only — a fleet relay holding exported rows must be told separately',
    ],
  };
}

// ── legal hold ───────────────────────────────────────────────────────────────

export interface LegalHold {
  active: boolean;
  declared_by: string | null;
  expires_at: number | null;
  source: string | null;
}

/** Legal hold declarations from ~/.vole/policy (managed root wins). */
export function loadLegalHold(files: string[] = paths.rulePolicyPaths(), now: number = Date.now()): LegalHold {
  for (let i = files.length - 1; i >= 0; i--) {
    const p = files[i]!;
    if (!existsSync(p)) continue;
    try {
      const hold = (JSON.parse(readFileSync(p, 'utf8')) as { legal_hold?: { active?: boolean; declared_by?: string; expires_at?: number } }).legal_hold;
      if (!hold) continue;
      const expired = typeof hold.expires_at === 'number' && hold.expires_at < now;
      return {
        active: hold.active === true && !expired,
        declared_by: hold.declared_by ?? null,
        expires_at: hold.expires_at ?? null,
        source: p,
      };
    } catch {
      /* malformed layer ignored */
    }
  }
  return { active: false, declared_by: null, expires_at: null, source: null };
}

// ── device decommission: seal, attest, erase ────────────────────────────────

export interface DecommissionReceipt {
  principal_key: string;
  archive_path: string;
  seal: {
    rows_exported: { table: string; rows: number }[];
    freeze_manifest_rows: number;
    archive_sha256: string;
  };
  attest: {
    recomputed_sha256: string;
    matches_seal: boolean;
    store_epoch_id: string | null;
  };
  erase: {
    blocked_by_hold: boolean;
    hold: LegalHold | null;
    rows_erased: { table: string; rows: number }[];
    register_entry: string | null;
  };
  /** The paths that still hold source data after erasure — the receipt says so. */
  sources_still_holding_data: string[];
}

/**
 * Three gates that cannot be skipped or reordered. Seal: export that
 * principal's rows through the deny-by-default field registry, plus the
 * evidence_freeze manifest, then hash what was written. Attest: recompute
 * the hash over the archive and print it beside the store's store_epoch, so
 * the archive can be shown to be the store it came from. Erase: the forget
 * pass, blocked by a legal hold that names its declarer.
 */
export function decommission(
  db: DB,
  principalKey: string,
  outPath: string,
  opts: { setBy?: string; now?: number; keepArchive?: boolean } = {},
): DecommissionReceipt {
  const now = opts.now ?? Date.now();
  // Seal — deny-by-default encode, NULL-omitting, through the shared registry.
  const encodeCtx: EncodeCtx = {
    device_id: 'local', // the archive stays on-device; the id is in the epoch below
    identity_mode: 'pseudonymous',
    opt_in: new Set(),
  };
  const sessions = (
    db.prepare(`SELECT session_id FROM session_identity WHERE principal_key = ?`).all(principalKey) as { session_id: string }[]
  ).map((s) => s.session_id);
  const ph = sessions.map(() => '?').join(',');
  const rowsExported: { table: string; rows: number }[] = [];
  const archive: Record<string, unknown> = {
    principal_key: principalKey,
    sealed_at: now,
    sections: {},
  };
  const exportSection = (name: string, table: string, sql: string, params: unknown[]) => {
    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    archive.sections = { ...(archive.sections as object), [name]: rows.map((r) => encodeFields(table, r, encodeCtx)) };
    rowsExported.push({ table, rows: rows.length });
    return rows.length;
  };
  exportSection('usage_events', 'usage_events',
    `SELECT * FROM usage_events WHERE source = 'live' AND (subject_id = ? OR session_id IN (SELECT session_id FROM session_identity WHERE principal_key = ?))`,
    [principalKey, principalKey]);
  if (sessions.length > 0) {
    exportSection('tool_calls', 'tool_calls', `SELECT * FROM tool_calls WHERE session_id IN (${ph})`, sessions);
    exportSection('anomalies', 'anomalies', `SELECT * FROM anomalies WHERE session_id IN (${ph}) AND source = 'live'`, sessions);
  }
  const freezeRows = db.prepare(
    `SELECT * FROM evidence_freeze WHERE principal_key = ?`,
  ).all(principalKey) as Record<string, unknown>[];
  archive.freeze_manifest = freezeRows;
  const epoch = db.prepare(`SELECT epoch_id, created_at, device_key FROM store_epoch LIMIT 1`).get() as
    | { epoch_id: string; created_at: number; device_key: string | null }
    | undefined;
  archive.store_epoch = epoch ?? null;
  const archiveJson = JSON.stringify(archive, null, 1);
  writeFileSync(outPath, archiveJson);
  const sealSha = `sha256:${createHash('sha256').update(archiveJson).digest('hex')}`;

  // Attest — recompute over what was written, beside the store's epoch.
  const reread = readFileSync(outPath, 'utf8');
  const attestSha = `sha256:${createHash('sha256').update(reread).digest('hex')}`;

  // Erase — gated by a hold that names its declarer.
  const hold = loadLegalHold(undefined, now);
  let erase: DecommissionReceipt['erase'];
  if (hold.active) {
    erase = { blocked_by_hold: true, hold, rows_erased: [], register_entry: null };
  } else {
    const fr = forgetSubject(db, principalKey, { setBy: opts.setBy ?? 'vole decommission', now });
    erase = { blocked_by_hold: false, hold: null, rows_erased: fr.deleted, register_entry: fr.register_entry };
  }
  return {
    principal_key: principalKey,
    archive_path: outPath,
    seal: { rows_exported: rowsExported, freeze_manifest_rows: freezeRows.length, archive_sha256: sealSha },
    attest: { recomputed_sha256: attestSha, matches_seal: attestSha === sealSha, store_epoch_id: epoch?.epoch_id ?? null },
    erase,
    sources_still_holding_data: [
      '~/.claude/projects (Claude Code transcripts — deleting breaks `claude --resume`)',
      '~/.codex/sessions (Codex rollouts)',
      'opencode.db (OpenCode store)',
      'the Devin ACP stores',
    ],
  };
}
