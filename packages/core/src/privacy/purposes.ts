/**
 * Tier 8: the purpose-bound query layer. A closed purpose union, the columns
 * each purpose may select, whether it may group by subject, and a `where()`
 * builder that carries the purpose as a required argument. The coordinated
 * integration step migrates queries.ts' hand-spliced seedClause sites onto
 * `where()`; until then this module is the contract those sites must adopt.
 *
 * On a single-user machine the reader is the subject, so purpose binding is
 * bookkeeping; it becomes a real control only where the reader is not the
 * subject (a fleet relay, a shared machine). The union is closed on purpose:
 * a new purpose is a policy change, reviewed here, not a string.
 */

/** The closed union. security_incident | cost_allocation | capacity | self_view | dsar. */
export type Purpose = 'security_incident' | 'cost_allocation' | 'capacity' | 'self_view' | 'dsar';

export const PURPOSES: readonly Purpose[] = [
  'security_incident', 'cost_allocation', 'capacity', 'self_view', 'dsar',
] as const;

/** Columns that identify a subject. Selecting or filtering on one requires a
 *  purpose whose spec allows it; grouping by one requires the group flag. */
export const SUBJECT_COLUMNS: readonly string[] = [
  'user', 'machine', 'subject_id', 'principal_key', 'device_key',
];

/** The non-subject read surface every purpose may project over usage_events. */
const BASE_COLUMNS: readonly string[] = [
  'event_key', 'ts', 'tool', 'model', 'project', 'git_branch',
  'input_tokens', 'output_tokens', 'cache_write_5m_tokens', 'cache_write_1h_tokens',
  'cache_read_tokens', 'reasoning_tokens', 'total_tokens', 'cost_usd',
  'confidence', 'is_error', 'stop_reason', 'tools', 'agent_id',
  'context_window', 'duration_ms', 'duration_kind', 'source',
];

export interface PurposeSpec {
  purpose: Purpose;
  /** Columns this purpose may select. Anything else is a policy violation. */
  columns: readonly string[];
  /** May a query under this purpose GROUP BY a subject column? */
  group_by_subject: boolean;
  /** The one-line justification the Privacy Center's Purposes table shows. */
  note: string;
}

const spec = (
  purpose: Purpose,
  subjects: boolean,
  group: boolean,
  note: string,
): PurposeSpec => ({
  purpose,
  columns: subjects ? [...BASE_COLUMNS, ...SUBJECT_COLUMNS] : BASE_COLUMNS,
  group_by_subject: group,
  note,
});

/** The purpose table: each purpose, the columns it may read, its grouping right. */
export const PURPOSE_SPECS: Record<Purpose, PurposeSpec> = {
  security_incident: spec('security_incident', true, true,
    'incident triage and the explainability figures (observed/baseline/threshold)'),
  cost_allocation: spec('cost_allocation', false, false,
    'spend roll-ups by tool/model/project — never by person'),
  capacity: spec('capacity', false, false,
    'planning aggregates over tokens and durations — never by person'),
  self_view: spec('self_view', true, true,
    'a subject reading their own rows (People view self-card, your-own-rows inspector)'),
  dsar: spec('dsar', true, true,
    'the Art. 15 export: the subject is the addressee by definition'),
};

export function purposeSpec(purpose: Purpose): PurposeSpec {
  const s = PURPOSE_SPECS[purpose];
  if (!s) throw new Error(`unknown purpose '${purpose}' — the union is closed`);
  return s;
}

/**
 * The guard the purposes test walks every read model through: throws when a
 * query under `purpose` projects or filters on a column it may not, or groups
 * by subject without the right. Offline this is a test failure; in a fleet
 * relay it is the access control.
 */
export function assertColumnsAllowed(purpose: Purpose, columns: Iterable<string>): void {
  const allowed = new Set(purposeSpec(purpose).columns);
  const offenders = [...new Set(columns)].filter((c) => !allowed.has(c));
  if (offenders.length > 0) {
    throw new Error(
      `purpose '${purpose}' may not select or filter on: ${offenders.join(', ')}`,
    );
  }
}

export function mayGroupBySubject(purpose: Purpose): boolean {
  return purposeSpec(purpose).group_by_subject;
}

/** Asserts the grouping clause too — GROUP BY user/machine needs the flag. */
export function assertGroupByAllowed(purpose: Purpose, groupColumns: Iterable<string>): void {
  const subjects = [...new Set(groupColumns)].filter((c) => SUBJECT_COLUMNS.includes(c));
  if (subjects.length > 0 && !mayGroupBySubject(purpose)) {
    throw new Error(`purpose '${purpose}' may not group by subject (${subjects.join(', ')})`);
  }
}

// ── the where() builder ─────────────────────────────────────────────────────

export interface WhereOptions {
  from?: number;
  to?: number;
  /** Include source='seed' rows. Default false: production reads never see demo data. */
  includeSeed?: boolean;
  user?: string;
  machine?: string;
  tool?: string;
  project?: string;
}

export interface WhereClause {
  /** SQL predicate, always truthy, safe to AND onto anything. */
  clause: string;
  /** Named parameters for the predicate. */
  params: Record<string, string | number>;
}

/**
 * The shared predicate builder. The purpose is REQUIRED: a caller that cannot
 * name why it is reading has no predicate. Subject filters (user/machine) are
 * themselves subject columns, so they demand a subject-allowed purpose — the
 * builder enforces what assertColumnsAllowed would, at the call site.
 */
export function where(purpose: Purpose, o: WhereOptions = {}): WhereClause {
  const parts: string[] = [];
  const params: Record<string, string | number> = {};
  if (o.includeSeed) {
    // Deliberate: only a caller that says why may see fiction at all.
    parts.push(`source IN ('live', 'seed')`);
  } else {
    parts.push(`source = 'live'`);
  }
  if (o.from !== undefined) {
    parts.push('ts >= :where_from');
    params.where_from = o.from;
  }
  if (o.to !== undefined) {
    parts.push('ts < :where_to');
    params.where_to = o.to;
  }
  if (o.tool !== undefined) {
    parts.push('tool = :where_tool');
    params.where_tool = o.tool;
  }
  if (o.project !== undefined) {
    parts.push('project = :where_project');
    params.where_project = o.project;
  }
  const subjectFilters: string[] = [];
  if (o.user !== undefined) subjectFilters.push('user');
  if (o.machine !== undefined) subjectFilters.push('machine');
  if (subjectFilters.length > 0) {
    assertColumnsAllowed(purpose, subjectFilters);
    if (o.user !== undefined) {
      parts.push('user = :where_user');
      params.where_user = o.user;
    }
    if (o.machine !== undefined) {
      parts.push('machine = :where_machine');
      params.where_machine = o.machine;
    }
  }
  return { clause: parts.join(' AND '), params };
}
