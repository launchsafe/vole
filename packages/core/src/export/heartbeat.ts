/**
 * Heartbeat export and the log-source-stopped dead-man's switch (feature
 * 29), plus pack inventory on the wire (feature 42).
 *
 * The first thing an attacker or an annoyed developer does is stop the
 * collector; a SIEM only notices if the source was emitting a heartbeat. One
 * vole.heartbeat record per drain carries up=1, collector version, poll
 * interval, per-tool last-seen and rows-since-last-beat, keyed idempotently
 * on (machine, interval bucket) — a UTC bucket epoch, never now().
 *
 * Pack inventory is the only signal an admin gets that a rollout missed a
 * laptop: one record per content pack and `vole.content.<kind>.version` /
 * `vole.content.<kind>.age_days` resource attributes ride every OTLP batch,
 * so a SIEM groups by version without a join.
 */
import type { DB } from '../db';
import type { Anomaly, Tool } from '../types';

export interface HeartbeatRecord {
  /** vole.heartbeat */
  name: 'vole.heartbeat';
  attributes: Record<string, string | number>;
  ts: number;
}

/** Per-tool last-seen from collector_runs — 'no run record' is NULL, never zero. */
export function toolFreshness(db: DB): { tool: string; last_run_at: number | null; source_state: string | null }[] {
  return db.prepare(`
    SELECT tool, MAX(started_at) AS last_run_at,
           (SELECT source_state FROM collector_runs c2 WHERE c2.tool = c1.tool
             ORDER BY started_at DESC LIMIT 1) AS source_state
    FROM collector_runs c1 GROUP BY tool ORDER BY tool
  `).all() as { tool: string; last_run_at: number | null; source_state: string | null }[];
}

export function heartbeatDoc(
  db: DB,
  deviceId: string,
  opts: { intervalMs?: number; collectorVersion?: string; now?: number } = {},
): { doc_id: string; record: HeartbeatRecord } {
  const now = opts.now ?? Date.now();
  const interval = opts.intervalMs ?? 5_000;
  const bucket = Math.floor(now / interval); // idempotent per machine+bucket
  const fresh = toolFreshness(db);
  const rowsSince = (
    db.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE source = ? AND ts >= ?').get('live', now - interval) as { n: number }
  ).n;
  const attrs: Record<string, string | number> = {
    up: 1,
    'vole.device_id': deviceId,
    'vole.collector.version': opts.collectorVersion ?? '0.2.2',
    'vole.poll_interval_ms': interval,
    'vole.rows_since_last_beat': rowsSince,
  };
  for (const t of fresh) {
    if (t.last_run_at !== null) attrs[`vole.tool.${t.tool}.last_seen`] = t.last_run_at;
    // absent = 'no run record': an honest unknown, never a zero timestamp
  }
  return {
    doc_id: `vole.heartbeat.v1:${deviceId}:${bucket}`,
    record: { name: 'vole.heartbeat', attributes: attrs, ts: now },
  };
}

/**
 * Pack inventory records (feature 42): kind, version, sha256, built_at,
 * age_days, ring, load_state, trust. Ring is whatever the admin's MDM wrote
 * locally — Vole reports the claim, it cannot verify the canary ring was the
 * twenty machines the admin intended (that is the limit, and it is stated).
 */
export interface PackRecord {
  kind: string;
  version: number;
  sha256: string;
  built_at: number | null;
  age_days: number | null;
  ring: string | null;
  load_state: string | null;
  trust: string | null;
}

export function packRecords(db: DB, now: number = Date.now()): PackRecord[] {
  // A pre-migration store lacks active/trust: read what exists, NULL the rest.
  const have = new Set(
    (db.prepare('PRAGMA table_info(content_packs)').all() as { name: string }[]).map((c) => c.name),
  );
  const rows = db.prepare(`
    SELECT kind, version, checksum, loaded_at${have.has('active') ? ', active' : ''}${have.has('trust') ? ', trust' : ''}
    FROM content_packs ORDER BY kind, version
  `).all() as { kind: string; version: number; checksum: string; loaded_at: number; active?: number | null; trust?: string | null }[];
  return rows.map((r) => ({
    kind: r.kind,
    version: r.version,
    sha256: r.checksum,
    built_at: r.loaded_at,
    age_days: Math.floor((now - r.loaded_at) / 86_400_000),
    ring: null, // no ring column exists: NULL, never a guessed ring
    load_state: r.active === undefined ? null : r.active ? 'active' : 'inactive',
    trust: r.trust ?? null,
  }));
}

/** `vole.content.*` resource attributes for every OTLP batch. */
export function packResourceAttributes(packs: PackRecord[]): Record<string, string | number> {
  const attrs: Record<string, string | number> = {};
  for (const p of packs) {
    attrs[`vole.content.${p.kind}.version`] = p.version;
    if (p.age_days !== null) attrs[`vole.content.${p.kind}.age_days`] = p.age_days;
  }
  return attrs;
}

/**
 * The dead-man's switch (rule 'log_source_stopped'): fires when a tool that
 * HAS produced a run record has not been seen for two poll intervals. Tools
 * with no run record at all never fire — 'never installed' is not 'stopped'.
 */
export function detectLogSourceStopped(
  freshness: { tool: string; last_run_at: number | null }[],
  intervalMs: number,
  now: number,
): Anomaly[] {
  const out: Anomaly[] = [];
  for (const t of freshness) {
    if (t.last_run_at === null) continue;
    const silentFor = now - t.last_run_at;
    if (silentFor < 2 * intervalMs) continue;
    const bucket = Math.floor(now / intervalMs);
    out.push({
      anomaly_key: `log_source_stopped:${t.tool}:${bucket}`,
      rule: 'log_source_stopped',
      severity: 'warn',
      tool: t.tool as Tool,
      session_id: null,
      model: null,
      window_start: t.last_run_at,
      window_end: now,
      title: `Log source stopped: ${t.tool}`,
      detail: `No collector run for ${t.tool} in ${Math.round(silentFor / 1000)}s (two intervals is the trip line). Either the collector was stopped or the machine was off — the heartbeat is the witness either way.`,
      observed: Math.round(silentFor / 1000),
      baseline: null,
      threshold: 2 * Math.round(intervalMs / 1000),
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }
  return out;
}
