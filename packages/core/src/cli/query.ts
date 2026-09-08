/**
 * `vole query --table=<name> --json` (features 12, 44): Vole's read models
 * published as tables someone else's agent can schedule. The column set is
 * versioned as a PUBLIC schema, independent of types.ts (which churns per
 * collector); every row keeps NULL and confidence semantics — an unpriced
 * call exports cost as JSON null, never 0, with the unpriced share beside
 * the aggregate.
 *
 * The Fleet/osquery ATC table pack is generated here too: osquery's
 * Automatic Table Construction reads ~/.vole/vole.db directly, so an existing
 * endpoint-governance deployment runs Vole's tables on the schedule it
 * already runs — no new daemon, no new port, no export path.
 *
 *   tsx src/cli/query.ts --table=vole_agents [--json] [--list]
 */
import { openDbReadOnly, type DB } from '../db';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PublicTable {
  name: string;
  schema_version: number;
  columns: { name: string; description: string }[];
  /** NULLs preserved; the unpriced counter ships beside any aggregate. */
  rows: (db: DB) => Record<string, unknown>[];
}

/**
 * The public schema. Read-only and last-poll: a scheduled osquery run
 * returns whatever the last collector pass stored, stamped with its time.
 * ponytail: public columns cannot track internal type churn — a new internal
 * field does not appear here until this schema version is bumped.
 */
export const PUBLIC_TABLES: Record<string, PublicTable> = {
  vole_agents: {
    name: 'vole_agents', schema_version: 1,
    columns: [
      { name: 'tool', description: 'the agent (claude_code, codex, …)' },
      { name: 'events', description: 'parsed usage rows, live partition only' },
      { name: 'sessions', description: 'distinct session ids' },
      { name: 'tokens', description: 'sum of total_tokens; NULL when no row carried tokens' },
      { name: 'cost_usd', description: 'sum of cost_usd; NULL rows excluded and counted in unpriced_events' },
      { name: 'unpriced_events', description: 'rows with cost_usd NULL — the denominator the aggregate omits' },
      { name: 'first_seen', description: 'earliest event ts (epoch ms)' },
      { name: 'last_seen', description: 'latest event ts (epoch ms)' },
    ],
    rows: (db) => db.prepare(`
      SELECT tool, COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions,
             SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost_usd,
             SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced_events,
             MIN(ts) AS first_seen, MAX(ts) AS last_seen
      FROM usage_events WHERE source = 'live' GROUP BY tool ORDER BY tool
    `).all(),
  },
  vole_surfaces: {
    name: 'vole_surfaces', schema_version: 1,
    columns: [
      { name: 'kind', description: 'surface type (app, gateway, site…)' },
      { name: 'name', description: 'surface name' },
      { name: 'sanctioned', description: 'policy verdict (NULL = no policy declared)' },
      { name: 'first_seen', description: 'when it appeared (epoch ms)' },
    ],
    rows: (db) => db.prepare(
      `SELECT kind, name, sanctioned, first_seen FROM ai_surfaces ORDER BY kind, name`,
    ).all(),
  },
  vole_incidents: {
    name: 'vole_incidents', schema_version: 1,
    columns: [
      { name: 'anomaly_key', description: 'stable cross-machine identifier' },
      { name: 'case_key', description: 'the case beneath the time bucket (NULL pre-tier7 rows)' },
      { name: 'rule', description: 'which rule fired' },
      { name: 'severity', description: 'info | warn | critical' },
      { name: 'observed', description: 'the figure that fired' },
      { name: 'baseline', description: 'what normal was (NULL = not computed)' },
      { name: 'threshold', description: 'what it had to beat (NULL = not thresholded)' },
      { name: 'state', description: 'triage state (NULL = no action taken)' },
      { name: 'window_start', description: 'epoch ms' },
      { name: 'window_end', description: 'epoch ms' },
      { name: 'detected_at', description: 'when Vole saw it (epoch ms)' },
    ],
    rows: (db) => db.prepare(`
      SELECT anomaly_key, case_key, rule, severity, observed, baseline, threshold, state,
             window_start, window_end, detected_at
      FROM anomalies WHERE source = 'live' ORDER BY detected_at DESC
    `).all(),
  },
  vole_posture: {
    name: 'vole_posture', schema_version: 1,
    columns: [
      { name: 'session_id', description: 'the session observed in a permission mode' },
      { name: 'tool', description: 'the agent' },
      { name: 'permission_mode', description: 'bypassPermissions | default | plan | …' },
      { name: 'calls', description: 'tool calls under this mode' },
      { name: 'first_seen', description: 'epoch ms' },
      { name: 'last_seen', description: 'epoch ms' },
    ],
    rows: (db) => {
      // A pre-migration store has no permission_mode: empty table, not an error.
      const has = (db.prepare('PRAGMA table_info(tool_calls)').all() as { name: string }[])
        .some((c) => c.name === 'permission_mode');
      if (!has) return [];
      return db.prepare(`
        SELECT session_id, tool, permission_mode, COUNT(*) AS calls, MIN(ts) AS first_seen, MAX(ts) AS last_seen
        FROM tool_calls WHERE session_id IS NOT NULL AND permission_mode IS NOT NULL
        GROUP BY session_id, tool, permission_mode ORDER BY last_seen DESC
      `).all();
    },
  },
  vole_coverage: {
    name: 'vole_coverage', schema_version: 1,
    columns: [
      { name: 'tool', description: 'the collector' },
      { name: 'last_run_at', description: 'NULL = no run record, never zero' },
      { name: 'source_state', description: 'ok | no_source | error' },
      { name: 'files', description: 'files in the last run' },
      { name: 'inserted', description: 'rows the last run inserted' },
    ],
    rows: (db) => db.prepare(`
      SELECT tool, MAX(started_at) AS last_run_at,
             (SELECT source_state FROM collector_runs c2 WHERE c2.tool = c1.tool ORDER BY started_at DESC LIMIT 1) AS source_state,
             (SELECT files FROM collector_runs c3 WHERE c3.tool = c1.tool ORDER BY started_at DESC LIMIT 1) AS files,
             (SELECT inserted FROM collector_runs c4 WHERE c4.tool = c1.tool ORDER BY started_at DESC LIMIT 1) AS inserted
      FROM collector_runs c1 GROUP BY tool ORDER BY tool
    `).all(),
  },
};

/** The ATC config: osquery reads the store directly, read-only. */
export function atcConfig(dbPath = join(homedir(), '.vole', 'vole.db')): string {
  const tables = [
    { name: 'vole_usage_events', table: 'usage_events', where: "source = 'live'", cols: 'event_key, tool, model, session_id, project, ts, input_tokens, output_tokens, total_tokens, cost_usd, confidence, is_error' },
    { name: 'vole_anomalies', table: 'anomalies', where: "source = 'live'", cols: 'anomaly_key, rule, severity, tool, session_id, observed, baseline, threshold, detected_at' },
    { name: 'vole_sources', table: 'collector_state', where: '1', cols: 'source_path, tool, last_offset, last_mtime, last_scanned_at' },
  ];
  return tables.map((t) => `{
  "table": "${t.name}",
  "description": "Vole ${t.table} (read-only ATC over the local Vole store, live partition only)",
  "sqlite_path": "${dbPath}",
  "query": "SELECT ${t.cols} FROM ${t.table} WHERE ${t.where}",
  "columns": [${t.cols.split(', ').map((c) => `"${c.trim()}"`).join(', ')}]
}`).join('\n');
}

/** Fleet's documented query-pack format: saved queries over the ATC tables. */
export function fleetQueryPack(): string {
  return `queries:
  vole_agents_seen:
    query: "SELECT tool, events, sessions, tokens, unpriced_events, last_seen FROM vole_agents WHERE last_seen > (SELECT strftime('%s','now') - 86400);"
    description: Agents seen per host in the last 24h
    interval: 3600
  vole_bypass_sessions:
    query: "SELECT session_id, tool, permission_mode, calls, last_seen FROM vole_posture WHERE permission_mode = 'bypassPermissions';"
    description: Sessions in bypass mode
    interval: 300
  vole_incidents_24h:
    query: "SELECT anomaly_key, rule, severity, observed, threshold, detected_at FROM vole_incidents WHERE detected_at > (SELECT strftime('%s','now') * 1000 - 86400000);"
    description: Incidents in the last 24h
    interval: 900
  vole_tokens_by_model:
    query: "SELECT model, SUM(CAST(total_tokens AS REAL)) AS tokens FROM vole_usage_events GROUP BY model ORDER BY tokens DESC;"
    description: Tokens by model
    interval: 3600
  vole_unpriced_share:
    query: "SELECT CAST(SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS unpriced_share FROM vole_usage_events;"
    description: Unpriced call share (NULL cost rows over all rows)
    interval: 3600
`;
}

if (process.argv[1]?.endsWith('query.ts')) {
  const args = new Map(process.argv.slice(2).map((a) => {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/s);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }));
  if (args.has('list') || !args.has('table')) {
    console.log(JSON.stringify(
      Object.values(PUBLIC_TABLES).map((t) => ({
        table: t.name, schema_version: t.schema_version, columns: t.columns,
      })), null, 1),
    );
  } else {
    const name = String(args.get('table'));
    const t = PUBLIC_TABLES[name];
    if (!t) throw new Error(`Unknown table ${name}; known: ${Object.keys(PUBLIC_TABLES).join(', ')}`);
    const db = openDbReadOnly();
    console.log(JSON.stringify({
      table: t.name, schema_version: t.schema_version,
      columns: t.columns.map((c) => c.name), rows: t.rows(db),
    }, null, 1));
  }
}
