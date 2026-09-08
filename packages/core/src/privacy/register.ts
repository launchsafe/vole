/**
 * Tier 8: the Art. 30 record, the Art. 15(1)(c) recipients answer, the
 * completed DSAR (Art. 15(1)(h): the logic, not just the rows), and the
 * works-council DPIA pack pre-filled with measured facts.
 *
 * Two exports off the same machinery, both refusing to drop the unknowns: a
 * mandatory header line counts the surfaces whose recipient could not be
 * resolved and the egress rows with no in-force terms entry. An Art. 30
 * record is the controller's document — Vole emits the measured facts it
 * holds, never the legal conclusions it cannot reach.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { DB } from '../db';
import { paths } from '../paths';
import { REGISTRY } from '../export/fields';
import { loadRetentionPolicy } from './retention';

// ── the processing register (Art. 30) ───────────────────────────────────────

export interface RegisterRow {
  surface_key: string;
  /** Where the data landed, from recipient_state — NULL when unresolved. */
  recipient_state: string | null;
  /** The plan token / contract tier that selects the terms (terms_basis). */
  terms_basis: string | null;
  /** Contract scope, from the processing_terms pack. */
  contract_scope: string | null;
  /** Third-country transfer: yes/no/unknown from residency_evidence + recipient_state. */
  third_country: 'yes' | 'no' | 'unknown';
  safeguard_cited: string | null;
  /** Categories of data evidenced — from sighting rows, never from prose. */
  data_classes_evidenced: string[];
  retention_default: number | null;
  evidence_count: number;
  first_seen: number | null;
  last_seen: number | null;
}

export interface ProcessingRegister {
  rows: RegisterRow[];
  /** The mandatory header: what could NOT be resolved, counted, never dropped. */
  unresolved_recipients: number;
  egress_rows_without_in_force_terms: number;
  note: string;
}

/**
 * The register: every surface with a terms basis, recipient state or terms
 * pack entry, joined to the data classes actually evidenced in sighting rows
 * (secret_sightings carries the provider column; dlp_egress does not exist
 * yet — when it lands, its data-class column becomes the evidence source).
 */
export function processingRegister(db: DB): ProcessingRegister {
  const surfaces = db.prepare(
    `SELECT surface_key, MIN(first_seen) AS f, MAX(last_seen) AS l FROM (
       SELECT surface_key, first_seen, last_seen FROM terms_basis
       UNION ALL SELECT surface_key, first_seen, last_seen FROM recipient_state
       UNION ALL SELECT surface_key, first_seen, last_seen FROM processing_terms
       UNION ALL SELECT surface_key, first_seen, last_seen FROM residency_evidence)
     GROUP BY surface_key`,
  ).all() as { surface_key: string; f: number; l: number }[];
  const basis = new Map(
    (db.prepare(`SELECT surface_key, basis FROM terms_basis`).all() as { surface_key: string; basis: string }[])
      .map((r) => [r.surface_key, r.basis]),
  );
  const recipients = new Map(
    (db.prepare(`SELECT surface_key, state FROM recipient_state`).all() as { surface_key: string; state: string }[])
      .map((r) => [r.surface_key, r.state]),
  );
  const scope = new Map(
    (db.prepare(`SELECT surface_key, value FROM processing_terms WHERE kind = 'contract_scope'`).all() as { surface_key: string; value: string | null }[])
      .map((r) => [r.surface_key, r.value]),
  );
  const safeguards = new Map(
    (db.prepare(`SELECT surface_key, value FROM processing_terms WHERE kind = 'safeguard'`).all() as { surface_key: string; value: string | null }[])
      .map((r) => [r.surface_key, r.value]),
  );
  const classes = new Map<string, string[]>();
  for (const r of db.prepare(`SELECT DISTINCT provider AS p FROM secret_sightings WHERE provider IS NOT NULL`).all() as { p: string }[]) {
    // ponytail: device-level classes until dlp_egress lands per-surface classes
    const list = classes.get('*') ?? [];
    list.push(r.p);
    classes.set('*', list);
  }
  const retention = loadRetentionPolicy();
  const rows: RegisterRow[] = surfaces.map((s) => {
    const rcpt = recipients.get(s.surface_key) ?? null;
    const evidenceCount = (db.prepare(
      `SELECT (SELECT COUNT(*) FROM terms_basis WHERE surface_key = ?) +
              (SELECT COUNT(*) FROM recipient_state WHERE surface_key = ?) +
              (SELECT COUNT(*) FROM processing_terms WHERE surface_key = ?) AS n`,
    ).get(s.surface_key, s.surface_key, s.surface_key) as { n: number }).n;
    return {
      surface_key: s.surface_key,
      recipient_state: rcpt,
      terms_basis: basis.get(s.surface_key) ?? null,
      contract_scope: scope.get(s.surface_key) ?? null,
      third_country: 'unknown', // residency needs inference_geo, not yet collected: unknown, never guessed
      safeguard_cited: safeguards.get(s.surface_key) ?? null,
      data_classes_evidenced: classes.get('*') ?? [],
      retention_default: retention.classes.find((c) => c.class === 'behavioural')?.days ?? null,
      evidence_count: evidenceCount,
      first_seen: s.f,
      last_seen: s.l,
    };
  });
  const unresolved = rows.filter((r) => r.recipient_state === null).length;
  return {
    rows,
    unresolved_recipients: unresolved,
    egress_rows_without_in_force_terms: 0, // counted from dlp_egress when that ledger exists; 0 today = none counted, not none existing
    note:
      'An Art. 30 record is the controller\'s document. These are the measured facts this ' +
      'endpoint holds; the register refuses to drop the unknowns rather than inventing them.',
  };
}

// ── Art. 15(1)(c): the recipients answer ───────────────────────────────────

export interface RecipientsAnswer {
  principal_key: string;
  /** Surfaces the subject actually used, mapped to register rows. */
  used_surfaces: RegisterRow[];
  unresolved: number;
  answer: string;
}

/** The per-person recipients answer: the same rows the DSAR export contains. */
export function recipientsAnswer(db: DB, principalKey: string): RecipientsAnswer {
  const reg = processingRegister(db);
  const tools = new Set(
    (db.prepare(
      `SELECT DISTINCT tool FROM usage_events WHERE source = 'live' AND
         (subject_id = ? OR session_id IN (SELECT session_id FROM session_identity WHERE principal_key = ?))`,
    ).all(principalKey, principalKey) as { tool: string }[]).map((r) => r.tool),
  );
  const used = reg.rows.filter((r) => {
    // A surface matches a used tool by its key's leading token (e.g. 'cli:grok').
    const slug = r.surface_key.split(':')[1] ?? r.surface_key;
    return [...tools].some((t) => t.includes(slug) || slug.includes(t));
  });
  const unresolved = used.length === 0 ? reg.unresolved_recipients : used.filter((r) => r.recipient_state === null).length;
  const answer =
    used.length === 0
      ? 'No surface with a resolved recipient was used by this subject on this device; ' +
        `${reg.unresolved_recipients} surface(s) fleet-wide have no resolved recipient — the unknown is counted, not dropped.`
      : `Data reached the following recipient states through the surfaces this subject used: ` +
        used.map((r) => `${r.surface_key} → ${r.recipient_state ?? 'unresolved'}`).join('; ') +
        `. ${unresolved} of them could not be resolved to a named recipient.`;
  return { principal_key: principalKey, used_surfaces: used, unresolved, answer };
}

// ── the DSAR export (Art. 15(1)(h): the logic, not just the rows) ───────────

export interface DsarLogicRule {
  rule: string;
  /** The three figures the same 'Why this fired' disclosure shows. */
  observed: number | null;
  baseline: number | null;
  threshold: number | null;
  /** True when detection predates threshold stamping — today's values are cited, labelled. */
  thresholds_not_recorded_at_detection_time: boolean;
  n: number;
}

export interface DsarDoc {
  subject: string;
  data_held: {
    sessions: number;
    usage_rows: number;
    incident_rules: { rule: string; n: number }[];
  };
  /** Art. 15(1)(h): meaningful information about the logic involved. */
  logic: {
    statement: string;
    rules: DsarLogicRule[];
  };
  /** Art. 15(1)(c). */
  recipients: RecipientsAnswer;
  /** Art. 15(1)(a)-(d) remainder: retention, per class, with prune receipts. */
  retention: {
    classes: { class: string; days: number | null; floor_days: number | null }[];
    deleted: { data_class: string; rows: number; ran_at: number }[];
    statement: string;
  };
}

/**
 * The completed self-DSAR: the rows AND the reasons. Rule thresholds are read
 * from the stored anomalies (never re-derived): incidents detected before
 * rule-version stamping can only cite today's thresholds and are labelled
 * 'thresholds not recorded at detection time'. A pruned window's only
 * honest answer is 'deleted on <date>, N rows, class X' — worded as one.
 */
export function buildDsar(db: DB, opts: { principalKey?: string; now?: number } = {}): DsarDoc {
  const now = opts.now ?? Date.now();
  const subject = opts.principalKey;
  // usage_events carries subject_id; anomalies does not — each gets its own scope.
  const usageScope = subject
    ? `source = 'live' AND (subject_id = ? OR session_id IN (SELECT session_id FROM session_identity WHERE principal_key = ?))`
    : `source = 'live' AND session_id IS NOT NULL`;
  const anomalyScope = subject
    ? `source = 'live' AND session_id IN (SELECT session_id FROM session_identity WHERE principal_key = ?)`
    : `source = 'live' AND session_id IS NOT NULL`;
  const params = subject ? [subject, subject] : [];
  const aParams = subject ? [subject] : [];
  const sessions = (db.prepare(
    `SELECT COUNT(DISTINCT session_id) AS n FROM usage_events WHERE ${usageScope}`,
  ).get(...params) as { n: number }).n;
  const usageRows = (db.prepare(
    `SELECT COUNT(*) AS n FROM usage_events WHERE ${usageScope}`,
  ).get(...params) as { n: number }).n;
  const incidentRules = db.prepare(
    `SELECT rule, COUNT(*) AS n FROM anomalies WHERE ${anomalyScope} GROUP BY rule ORDER BY n DESC`,
  ).all(...aParams) as { rule: string; n: number }[];
  const logicRaw = db.prepare(
    `SELECT rule, observed, baseline, threshold, COUNT(*) AS n FROM anomalies WHERE ${anomalyScope} GROUP BY rule, observed, baseline, threshold`,
  ).all(...aParams) as { rule: string; observed: number; baseline: number | null; threshold: number | null; n: number }[];
  const logicRules: DsarLogicRule[] = logicRaw.map((r) => ({
    rule: r.rule,
    observed: r.observed,
    baseline: r.baseline,
    threshold: r.threshold,
    thresholds_not_recorded_at_detection_time: r.threshold === null,
    n: r.n,
  }));
  const retention = loadRetentionPolicy();
  const deleted = db.prepare(
    `SELECT data_class, deleted_rows, ran_at FROM store_prunes ORDER BY ran_at DESC LIMIT 50`,
  ).all() as { data_class: string; deleted_rows: number; ran_at: number }[];
  return {
    subject: subject ?? 'pseudonymous principal (HMAC — the store holds no name or email)',
    data_held: { sessions, usage_rows: usageRows, incident_rules: incidentRules },
    logic: {
      statement:
        'Figures derive from tool-written local logs: token counts read verbatim, costs computed at list price, ' +
        'incidents from deterministic rules over those figures. A rule fires when the observed count crosses its ' +
        'threshold against the subject\'s own leave-one-out median baseline — the three figures per rule are below. ' +
        'No prompt or tool content is stored (verify --content checks this claim against the schema).',
      rules: logicRules,
    },
    recipients: recipientsAnswer(db, subject ?? ''),
    retention: {
      classes: retention.classes.map((c) => ({ class: c.class, days: c.days, floor_days: c.floor_days })),
      deleted,
      statement:
        'The store persists until deleted; the underlying logs are pruned by the vendors (~30 days for Claude). ' +
        'Windows already pruned read "deleted on <date>, N rows, class X" — the receipts above are that record.',
    },
  };
}

// ── the works-council pack: a DPIA pre-filled with measured facts ────────────

export interface ColumnFill {
  column: string;
  non_null: number;
  total: number;
  rate: number | null;
}

export interface DpiaFactTable {
  table: string;
  rows: number;
  columns: ColumnFill[];
}

export interface WorksCouncilPack {
  generated_at: number;
  /** 'one endpoint, <date range>' — fleet-wide numbers do not exist until sync is on. */
  scope: string;
  date_range: { first_event: number | null; last_event: number | null } | null;
  fact_tables: DpiaFactTable[];
  /** How many exported fields are personal data (identity/digest transforms). */
  personal_data_fields: number;
  exported_fields_total: number;
  /** The k achieved for the aggregate, from the kanon pass. */
  kanon: { k: number; primary: number; complementary: number } | null;
  content_reading_scanners: { name: string; reads_content: boolean }[];
  collector_footprint: { cpu_user_ms: number | null; cpu_sys_ms: number | null; wall_ms: number | null; runs: number };
  co_determination_note: string;
}

/** The DPIA fact tables: rows per table, non-NULL rates per column — measured, not asserted. */
export function worksCouncilPack(
  db: DB,
  opts: { kanon?: { k: number; primary: number; complementary: number }; now?: number } = {},
): WorksCouncilPack {
  const now = opts.now ?? Date.now();
  const tables = ['usage_events', 'tool_calls', 'anomalies', 'secret_sightings', 'principals', 'session_identity'];
  const factTables: DpiaFactTable[] = tables.map((t) => {
    const rows = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    const fills: ColumnFill[] = cols.map((c) => {
      const r = db.prepare(
        `SELECT COUNT(*) AS non_null FROM ${t} WHERE "${c}" IS NOT NULL`,
      ).get() as { non_null: number };
      return { column: c, non_null: r.non_null, total: rows, rate: rows > 0 ? r.non_null / rows : null };
    });
    return { table: t, rows, columns: fills };
  });
  // Personal-data fields in the export registry: identity and digest transforms.
  const personal = countPersonalDataFields(REGISTRY);
  const range = db.prepare(`SELECT MIN(ts) AS a, MAX(ts) AS b FROM usage_events WHERE source = 'live'`).get() as
    | { a: number | null; b: number | null }
    | undefined;
  const runs = db.prepare(
    `SELECT COUNT(*) AS n, SUM(cpu_user_ms) AS cu, SUM(cpu_sys_ms) AS cs, SUM(wall_ms) AS w FROM collector_runs`,
  ).get() as { n: number; cu: number | null; cs: number | null; w: number | null };
  return {
    generated_at: now,
    scope: 'one endpoint — fleet-wide numbers do not exist until sync is on',
    date_range: range ?? null,
    fact_tables: factTables,
    personal_data_fields: personal.personal,
    exported_fields_total: personal.total,
    kanon: opts.kanon ?? null,
    content_reading_scanners: [
      { name: 'dlp', reads_content: true }, // the one scanner that reads file bytes; it stores fingerprints, never content
    ],
    collector_footprint: { cpu_user_ms: runs.cu, cpu_sys_ms: runs.cs, wall_ms: runs.w, runs: runs.n },
    co_determination_note:
      'Templates, not legal advice; the measured figures describe one machine. It cites the co-determination ' +
      'trigger: the tool observes AI-tool use per employee, which in DE/Betriebsrat terms is a technical device ' +
      'that can monitor behaviour — proportionality is argued with these numbers, and the inalienable exclusion ' +
      'floor plus the content boundary are the limits already enforced by the code.',
  };
}

/** Counts identity/digest (personal-data) fields in the export registry. */
export function countPersonalDataFields(
  registry: { transform: string; export: string }[],
): { personal: number; total: number } {
  const exported = registry.filter((f) => f.export !== 'never');
  return {
    personal: exported.filter((f) => f.transform === 'identity' || f.transform === 'digest').length,
    total: exported.length,
  };
}

/** Loads the policy's kanon block, when present (the DPIA cites the achieved k). */
export function kanonBlock(
  files: string[] = paths.rulePolicyPaths(),
): { k?: unknown } | null {
  for (let i = files.length - 1; i >= 0; i--) {
    const p = files[i]!;
    if (!existsSync(p)) continue;
    try {
      return (JSON.parse(readFileSync(p, 'utf8')) as { kanon?: { k?: unknown } }).kanon ?? null;
    } catch {
      /* malformed layer ignored */
    }
  }
  return null;
}
