/**
 * Tier 6 §74: the comparability gate. An indicator can fail to match because
 * it was never here, or because this store cannot express it — and calling
 * the second case "not seen" is the lie this gate refuses. Verdicts:
 *   comparable    — the ledger can express the indicator (rows, non-NULL column)
 *   not_seen      — expressible, and no row matches the indicator's target
 *   not_comparable — this store cannot answer, with the literal reason and
 *                   what would make it answerable.
 */
import type { DB } from '../db';

export type GateVerdict = 'comparable' | 'not_seen' | 'not_comparable';

export interface IndicatorSpec {
  kind: string;
  ledger: string;
  column: string;
  normaliser_id: string;
  strength: 'identity' | 'shape';
  /** The value the hunt is looking for. Absent = the gate only checks expressibility. */
  value?: string;
}

export interface GateResult {
  spec: IndicatorSpec;
  verdict: GateVerdict;
  reason: string;
  rows: number;
  expressible_rows: number;
  matches: number | null;
}

/**
 * The ledger/column allowlist — the gate never interpolates arbitrary SQL.
 * ponytail: the indicator_matchers table does not exist in the seam; when a
 * foundation migration adds it these builtin specs should become rows.
 */
const LEDGERS: Record<string, Set<string>> = {
  package_execs: new Set(['package_name', 'registry', 'call_key']),
  posture_mcp_servers: new Set(['mcp_identity', 'server_name', 'command', 'url']),
  tool_calls: new Set(['shape', 'name', 'tool', 'pattern_id']),
  context_edges: new Set(['destination', 'transport', 'verb']),
  ai_extensions: new Set(['ext_id', 'name']),
};

export const BUILTIN_INDICATORS: IndicatorSpec[] = [
  { kind: 'package', ledger: 'package_execs', column: 'package_name', normaliser_id: 'semver_range', strength: 'identity' },
  { kind: 'mcp_endpoint', ledger: 'posture_mcp_servers', column: 'mcp_identity', normaliser_id: 'endpoint_identity', strength: 'identity' },
  { kind: 'command_shape', ledger: 'tool_calls', column: 'shape', normaliser_id: 'skeleton_v1', strength: 'shape' },
  { kind: 'egress_host', ledger: 'context_edges', column: 'destination', normaliser_id: 'host_lower', strength: 'identity' },
];

/** Runs one indicator through the gate. Read-only. */
export function comparabilityGate(db: DB, indicators: IndicatorSpec[]): GateResult[] {
  return indicators.map((spec) => {
    const cols = LEDGERS[spec.ledger];
    if (!cols || !cols.has(spec.column)) {
      return {
        spec, verdict: 'not_comparable' as GateVerdict,
        reason: `unknown ledger/column ${spec.ledger}.${spec.column} — this build cannot query it`,
        rows: 0, expressible_rows: 0, matches: null,
      };
    }
    let rows = 0;
    let nonNull = 0;
    try {
      // Column is from the LEDGERS allowlist above, never caller-arbitrary.
      const r = db.prepare(`SELECT COUNT(*) AS n, COUNT(${spec.column}) AS nn FROM ${spec.ledger}`).get() as { n: number; nn: number };
      rows = r.n;
      nonNull = r.nn;
    } catch {
      return {
        spec, verdict: 'not_comparable' as GateVerdict,
        reason: `ledger ${spec.ledger} is not present in this store`,
        rows: 0, expressible_rows: 0, matches: null,
      };
    }
    if (rows === 0) {
      return {
        spec, verdict: 'not_comparable' as GateVerdict,
        reason: `ledger ${spec.ledger} is empty — nothing on this machine can express ${spec.kind}; what would make it answerable: collect the ${spec.ledger} evidence this indicator reads`,
        rows, expressible_rows: nonNull, matches: null,
      };
    }
    if (nonNull === 0) {
      return {
        spec, verdict: 'not_comparable' as GateVerdict,
        reason: `column ${spec.ledger}.${spec.column} is NULL on every retained row — normaliser ${spec.normaliser_id} was never applied; what would make it answerable: bump the pattern pack and re-hash retained files under it`,
        rows, expressible_rows: nonNull, matches: null,
      };
    }
    if (spec.value === undefined) {
      return {
        spec, verdict: 'comparable' as GateVerdict,
        reason: `expressible: ${nonNull} of ${rows} rows carry ${spec.column}`,
        rows, expressible_rows: nonNull, matches: null,
      };
    }
    const m = db
      .prepare(`SELECT COUNT(*) AS n FROM ${spec.ledger} WHERE ${spec.column} = ?`)
      .get(spec.value) as { n: number };
    return m.n > 0
      ? { spec, verdict: 'comparable' as GateVerdict, reason: `${m.n} row(s) match`, rows, expressible_rows: nonNull, matches: m.n }
      : { spec, verdict: 'not_seen' as GateVerdict, reason: 'expressible, no matching row', rows, expressible_rows: nonNull, matches: 0 };
  });
}
