/**
 * Tier 6 §14: rule provenance and control-framework mapping, joined to
 * anomalies.rule at read time so one Vole incident lands in a SIEM already
 * carrying the control id the auditor asks about. Data:
 * packages/core/src/data/rules-controls.json (versioned in the repo).
 */
import controlsJson from '../data/rules-controls.json';
import type { DB } from '../db';

interface ControlsFile {
  mapping_version: number;
  frameworks: Record<string, string>;
  rules: Record<string, { provenance: RuleProvenance; controls: RuleControl[] }>;
}

const C = controlsJson as ControlsFile;

export interface RuleProvenance {
  incident_name: string;
  incident_date: string;
  url: string;
  detectability: string;
}

export interface RuleControl {
  framework: string;
  control_id: string;
  control_title: string;
}

export const MAPPING_VERSION: number = C.mapping_version;

/** The static provenance record shipped with a rule — 'why this rule exists'. */
export function provenanceFor(rule: string): RuleProvenance | null {
  return C.rules[rule]?.provenance ?? null;
}

/** The control-framework mappings for a rule, 'evidence toward', never 'compliant with'. */
export function controlsForRule(rule: string): RuleControl[] {
  return C.rules[rule]?.controls ?? [];
}

export function frameworkUrl(framework: string): string | null {
  return C.frameworks[framework] ?? null;
}

export interface IncidentFrameworkRow {
  rule: string;
  n: number;
  controls: RuleControl[];
  provenance: RuleProvenance | null;
}

/** Framework chips for the incident feed: stored anomalies joined to the mapping at read time. */
export function incidentFrameworkChips(db: DB): IncidentFrameworkRow[] {
  const rows = db
    .prepare('SELECT rule, COUNT(*) AS n FROM anomalies GROUP BY rule ORDER BY n DESC')
    .all() as { rule: string; n: number }[];
  return rows
    .map((r) => ({ rule: r.rule, n: r.n, controls: controlsForRule(r.rule), provenance: provenanceFor(r.rule) }))
    .filter((r) => r.controls.length > 0 || r.provenance !== null);
}
