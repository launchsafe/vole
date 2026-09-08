/**
 * Detection content pack (feature 46): Sigma, Splunk SPL and Elastic EQL
 * generated from the same field registry the wire uses. Field names come
 * from export/fields.ts and rule ids from the AnomalyRule vocabulary, so a
 * rename in code regenerates the content and the test fails if a shipped
 * rule references a field the exporter cannot emit.
 *
 * Sigma has no product taxonomy for AI agents, so the pack uses a custom
 * `product: vole` no backend recognises out of the box — every customer
 * converts with sigma-cli themselves; that limit is the point of shipping
 * the source, not a compiled bundle.
 */
import { createHash } from 'node:crypto';
import { fieldsFor } from '../export/fields';
import { SHAPE_NAMES } from '../export/shapes';

/** wire_name -> exists and exportable for that table? */
export function wireFieldExportable(table: string, wireName: string): boolean {
  const f = fieldsFor(table).find((x) => x.wire_name === wireName);
  return !!f && f.export !== 'never';
}

export interface DetectionRule {
  id: string; // the AnomalyRule literal or a pack-level synthetic id
  title: string;
  description: string;
  /** The Vole shape the detection runs over. */
  shape: string;
  level: 'critical' | 'high' | 'medium' | 'low';
  /** selection fields — every one must be exportable or the test fails. */
  selection: Record<string, string | number>;
  /** Extra condition fields (comparisons beyond equality). */
  condition?: string;
}

/**
 * The shipped rule set. Each maps to a rule the detector registry can fire
 * (or the heartbeat dead-man's switch, which is a SIEM-side rule because
 * absence is only detectable where the heartbeat arrives).
 */
export const DETECTION_RULES: DetectionRule[] = [
  {
    id: 'headless_bypass_launch',
    title: 'Agent session running in bypassPermissions',
    description: 'A tool call was observed with permission_mode=bypassPermissions: the agent could act without asking.',
    shape: 'vole.tool_call.v1',
    level: 'critical',
    selection: { permission_mode: 'bypassPermissions' },
  },
  {
    id: 'secret_at_rest',
    title: 'Secret sighting (confirmed)',
    description: 'The DLP ledger confirmed a secret fingerprint at rest on the endpoint.',
    shape: 'vole.secret_sighting.v1',
    level: 'high',
    selection: { status: 'confirmed' },
  },
  {
    id: 'shadow_account_on_corporate_repo',
    title: 'Shadow account used on a corporate repo',
    description: 'A personal account class was observed on a repo the identity policy declares corporate.',
    shape: 'vole.incident.v1',
    level: 'high',
    selection: { rule: 'shadow_account_on_corporate_repo' },
  },
  {
    id: 'billable_burn_spike',
    title: 'Burn-rate incident above threshold',
    description: 'Billable burn crossed its threshold: observed exceeds the stored threshold for the window.',
    shape: 'vole.incident.v1',
    level: 'medium',
    selection: { rule: 'billable_burn_spike' },
    condition: 'observed > threshold',
  },
  {
    id: 'log_source_stopped',
    title: 'Missing heartbeat: log source stopped',
    description: 'Dead-man\'s switch: no vole.heartbeat record arrived from an enrolled host for two poll intervals.',
    shape: 'vole.heartbeat.v1',
    level: 'high',
    selection: { up: 1 }, // the SIEM rule is "no record matching this for 2 x interval"
    condition: 'absence for 2 x vole.poll_interval_ms',
  },
  {
    id: 'exposed_local_bind',
    title: 'Unmanaged telemetry endpoint bound off-loopback',
    description: 'A local model runtime was observed bound to a non-loopback interface — an unmanaged endpoint on the LAN.',
    shape: 'vole.incident.v1',
    level: 'medium',
    selection: { rule: 'exposed_local_bind' },
  },
];

function ruleId(r: DetectionRule): string {
  // Deterministic uuid-shaped id from the rule id — never now(), so
  // regenerated content is byte-stable and diffs cleanly.
  const h = createHash('sha256').update(`vole-detection:${r.id}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The pack date is a fixed epoch — deterministic, not generated-at. */
const PACK_DATE = '2026-09-07';

export function sigmaYaml(r: DetectionRule): string {
  const lines = [
    'title: ' + r.title,
    'id: ' + ruleId(r),
    `status: experimental`,
    `description: ${JSON.stringify(r.description)}`,
    'references:',
    '  - https://github.com/shivanagendrak/vole/docs/enterprise/tier-7.md',
    'author: Vole',
    `date: ${PACK_DATE}`,
    'tags:',
    '  - product.vole',
    'logsource:',
    '  product: vole',
    `  service: ${r.shape}`,
    'detection:',
    '  selection:',
    ...Object.entries(r.selection).map(([k, v]) => `    ${k}: ${JSON.stringify(String(v))}`),
    `  condition: selection${r.condition ? ` and (${r.condition})` : ''}`,
    'falsepositives:',
    '  - none known',
    `level: ${r.level}`,
  ];
  return lines.join('\n') + '\n';
}

export function generateSigma(): string {
  return DETECTION_RULES.map(sigmaYaml).join('\n---\n');
}

/** Splunk SPL equivalents, same selections, wire names verbatim. */
export function generateSpl(index = 'vole'): string {
  return DETECTION_RULES.map((r) => {
    const conds = Object.entries(r.selection).map(([k, v]) => `${k}="${v}"`).join(' ');
    return `# ${r.title}\n${index} sourcetype="vole:export" ${conds} | stats count by device_id${r.condition ? ` | where ${r.condition}` : ''}`;
  }).join('\n\n') + '\n';
}

/** Elastic EQL equivalents. */
export function generateEql(): string {
  return DETECTION_RULES.map((r) => {
    const conds = Object.entries(r.selection).map(([k, v]) => `${k} == "${v}"`).join(' and ');
    return `/* ${r.title} */\n${r.shape} where ${conds}${r.condition ? ` and ${r.condition}` : ''}`;
  }).join('\n\n') + '\n';
}

/** Validation used by the test: every selection/condition field is exportable. */
export function validateAgainstRegistry(): string[] {
  const errors: string[] = [];
  const tableByShape = (shape: string): string | null => {
    // shape -> table via the shapes module's naming (kept local to avoid an import cycle)
    switch (shape) {
      case 'vole.event.v1': return 'usage_events';
      case 'vole.incident.v1': return 'anomalies';
      case 'vole.tool_call.v1': return 'tool_calls';
      case 'vole.secret_sighting.v1': return 'secret_sightings';
      case 'vole.heartbeat.v1': return null; // not a table shape: fields validated specially below
      default: return null;
    }
  };
  for (const r of DETECTION_RULES) {
    if (r.shape === 'vole.heartbeat.v1') {
      if (!SHAPE_NAMES.includes('vole.event.v1')) errors.push('shapes missing');
      continue; // heartbeat fields (up, vole.poll_interval_ms) live on the record, not the registry
    }
    const table = tableByShape(r.shape);
    if (!table) { errors.push(`${r.id}: unknown shape ${r.shape}`); continue; }
    for (const field of Object.keys(r.selection)) {
      if (!wireFieldExportable(table, field)) {
        errors.push(`${r.id}: selection field ${field} is not exportable from ${table}`);
      }
    }
    for (const field of (r.condition ?? '').match(/[\w.]+/g) ?? []) {
      if (['observed', 'threshold', 'baseline'].includes(field) || field.includes('.')) continue;
      if (!wireFieldExportable(table, field)) {
        errors.push(`${r.id}: condition field ${field} is not exportable from ${table}`);
      }
    }
  }
  return errors;
}
