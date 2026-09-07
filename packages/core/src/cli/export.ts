/**
 * The export path (Tier 7 core): a deny-by-default field registry and a JSON
 * encoder that omits NULLs. Every export states which fields left the machine
 * — and only fields on the list can.
 *
 *   pnpm --filter @vole/core export --json > vole-export.json
 *
 * The registry is data, not code: adding a field requires adding it here, by
 * name, with its justification — the same review discipline as the content
 * allowlist in verify.
 */
import { openDbReadOnly } from '../db';

interface FieldSpec {
  table: string;
  column: string;
  justification: string;
}

/** The allowlist. A field NOT on this list is never exported. */
const REGISTRY: FieldSpec[] = [
  { table: 'usage_events', column: 'ts', justification: 'when the call happened' },
  { table: 'usage_events', column: 'tool', justification: 'which agent' },
  { table: 'usage_events', column: 'model', justification: 'which model answered' },
  { table: 'usage_events', column: 'session_id', justification: 'session grouping' },
  { table: 'usage_events', column: 'input_tokens', justification: 'usage figure' },
  { table: 'usage_events', column: 'output_tokens', justification: 'usage figure' },
  { table: 'usage_events', column: 'cache_read_tokens', justification: 'usage figure' },
  { table: 'usage_events', column: 'total_tokens', justification: 'usage figure' },
  { table: 'usage_events', column: 'cost_usd', justification: 'cost figure' },
  { table: 'usage_events', column: 'confidence', justification: 'data quality' },
  { table: 'usage_events', column: 'is_error', justification: 'error state' },
  { table: 'usage_events', column: 'duration_ms', justification: 'response span' },
  { table: 'anomalies', column: 'rule', justification: 'which rule fired' },
  { table: 'anomalies', column: 'severity', justification: 'incident severity' },
  { table: 'anomalies', column: 'tool', justification: 'which agent' },
  { table: 'anomalies', column: 'window_start', justification: 'when' },
  { table: 'anomalies', column: 'window_end', justification: 'when' },
  { table: 'anomalies', column: 'title', justification: 'incident title' },
  { table: 'anomalies', column: 'observed', justification: 'the figure that fired' },
  { table: 'anomalies', column: 'confidence', justification: 'data quality' },
  { table: 'tool_calls', column: 'tool', justification: 'which agent' },
  { table: 'tool_calls', column: 'name', justification: 'tool name' },
  { table: 'tool_calls', column: 'shape', justification: 'command shape (structure, never content)' },
  { table: 'tool_calls', column: 'ts', justification: 'when' },
  { table: 'tool_calls', column: 'status', justification: 'outcome' },
  { table: 'tool_calls', column: 'authority', justification: 'authority state' },
  { table: 'tool_calls', column: 'duration_ms', justification: 'call span' },
  { table: 'ai_surfaces', column: 'kind', justification: 'surface type' },
  { table: 'ai_surfaces', column: 'name', justification: 'surface name' },
  { table: 'ai_surfaces', column: 'first_seen', justification: 'when it appeared' },
  { table: 'ai_surfaces', column: 'sanctioned', justification: 'policy verdict' },
];

const DELIBERATELY_EXCLUDED = [
  'usage_events.raw_ref', 'usage_events.user', 'usage_events.machine', 'usage_events.tools',
  'anomalies.detail', 'anomalies.session_id', 'anomalies.raw_ref',
  'tool_calls.args_digest', 'tool_calls.raw_ref', 'tool_calls.session_id', 'tool_calls.agent_id',
  'ai_surfaces.path', 'ai_surfaces.evidence', 'ai_surfaces.extra',
  'secret_sightings.*', 'grants.entry', 'principals.principal_key',
];

export function exportJson(): string {
  const db = openDbReadOnly();
  const byTable = new Map<string, string[]>();
  for (const f of REGISTRY) {
    const arr = byTable.get(f.table) ?? [];
    arr.push(f.column);
    byTable.set(f.table, arr);
  }

  const encode = (table: string, rows: Record<string, unknown>[]) =>
    rows.map((r) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (v !== null && v !== undefined) out[k] = v; // NULL-omitting: absence is honest
      }
      return out;
    });

  const usage = encode('usage_events', db
    .prepare(`SELECT ${byTable.get('usage_events')!.join(', ')} FROM usage_events WHERE source = 'live' ORDER BY ts DESC LIMIT 1000`)
    .all() as Record<string, unknown>[]);
  const incidents = encode('anomalies', db
    .prepare(`SELECT ${byTable.get('anomalies')!.join(', ')} FROM anomalies WHERE source = 'live' ORDER BY detected_at DESC LIMIT 500`)
    .all() as Record<string, unknown>[]);
  const calls = encode('tool_calls', db
    .prepare(`SELECT ${byTable.get('tool_calls')!.join(', ')} FROM tool_calls ORDER BY ts DESC LIMIT 500`)
    .all() as Record<string, unknown>[]);
  const surfaces = encode('ai_surfaces', db
    .prepare(`SELECT ${byTable.get('ai_surfaces')!.join(', ')} FROM ai_surfaces ORDER BY kind, name`)
    .all() as Record<string, unknown>[]);

  const out = {
    _registry: {
      exported_fields: REGISTRY.length,
      deliberately_excluded: DELIBERATELY_EXCLUDED.length,
      note: 'deny-by-default: only listed fields are exported; NULLs are omitted, not zeroed',
    },
    generated_at: new Date().toISOString(),
    usage_events: usage,
    anomalies: incidents,
    tool_calls: calls,
    ai_surfaces: surfaces,
  };
  return JSON.stringify(out, null, 1);
}

if (process.argv[1]?.endsWith('export.ts')) {
  console.log(exportJson());
}
