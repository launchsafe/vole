/**
 * Standing correctness check for the collectors.
 *
 * Reconciles every stored row against its own source record, per message/event, rather
 * than comparing grand totals. Totals drift whenever a source is live (the logs grow
 * underneath you), so a total-vs-total comparison can neither prove nor disprove
 * correctness. Per-record reconciliation is immune to that.
 *
 * The expected cost is deliberately re-implemented rather than imported from ../pricing,
 * so that a bug in the product's own formula cannot cancel itself out. PRICING is only
 * consulted for MODEL MEMBERSHIP (is this model priced at all?), never for its rates.
 * RATES below must mirror the built-in data/pricing.json table — an independent copy,
 * so a typo in the product's rates is caught here.
 *
 * Live-source races, handled explicitly:
 *  - IN FLIGHT: a record whose tokens are still growing (no stop_reason / no completion
 *    time) is reported, not compared — there is nothing final to be right about yet.
 *  - LAGGING: a record that IS final in the source but whose stored row is from an
 *    earlier poll. The upsert only ever upgrades, so this heals within one poll
 *    interval; verify re-checks the lagging rows after a grace period (longer than the
 *    default 5s poll) and fails only on what persists.
 *  - OVERSTATED: a stored row larger than its final source record. No poll can ever
 *    fix that (upgrades are monotone), so it fails immediately.
 *
 * Coverage: Claude Code (tokens + cost), OpenCode (tokens, two ways), Codex (tokens via
 * the cumulative meter, breakdown fields, cost), Grok (tokens against unified.jsonl).
 * Sources that persist no token data (Cursor, Antigravity, Devin) have nothing numeric
 * to reconcile: their rows are checked for NULL-ness in the token fields.
 *
 * The store is opened READ-ONLY and must already exist: verify must never create or
 * migrate what it is supposed to be checking, and an absent or empty store is a FAIL,
 * never a vacuous PASS — every counter at zero proves nothing.
 *
 * Source horizon: Claude Code prunes its own transcripts (cleanupPeriodDays, default
 * 30) and users delete project directories, so a stored row whose source file is gone
 * can never be re-proved from local evidence. Pruned rows are counted and reported,
 * not failed — an install older than the horizon stays green on the rows that can
 * still be checked. Grok's unified.jsonl is append-only and never pruned, so a Grok
 * row missing from the log is a real failure.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../sqlite';
import { paths } from '../paths';
import { rateFor } from '../pricing';
import { walkTranscripts } from '../collectors/claude-code';

/** `cr` is a flat cache-read $/MTok where a model deviates from the 0.1x rule. */
const RATES: Record<string, { i: number; o: number; cr?: number }> = {
  'claude-fable-5-1': { i: 10, o: 50, cr: 0.25 },
  'claude-fable-5': { i: 10, o: 50 },
  'claude-opus-5': { i: 5, o: 25 },
  'claude-opus-4-8': { i: 5, o: 25 },
  'claude-opus-4-7': { i: 5, o: 25 },
  'claude-opus-4-6': { i: 5, o: 25 },
  'claude-sonnet-5': { i: 2, o: 10 },
  'claude-sonnet-4-6': { i: 3, o: 15 },
  'claude-haiku-4-5': { i: 1, o: 5 },
};

/**
 * Structure check that works for ANY model, priced or not:
 *  - model has no loaded rate            → stored cost must be NULL;
 *  - model is priced but lacks an independent RATES entry → not checkable, reported;
 *  - model is in RATES                   → full recompute below.
 */
function priced(model: string | null | undefined): boolean {
  return rateFor(model ?? null) !== undefined;
}

/** Independent copy of the product's snapshot-id rule: `-YYYYMMDD` names the alias's rate. */
function rate(model: string | null | undefined) {
  if (!model) return undefined;
  return RATES[model] ?? RATES[model.replace(/-\d{8}$/, '')];
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

function cacheWrites(u: Usage): { w5: number; w1: number } {
  const c = u.cache_creation;
  return {
    w5: c?.ephemeral_5m_input_tokens ?? (c ? 0 : (u.cache_creation_input_tokens ?? 0)),
    w1: c?.ephemeral_1h_input_tokens ?? 0,
  };
}

function expectedCost(model: string | undefined, u: Usage): number | null {
  const r = rate(model);
  if (!r) return null;
  const { w5, w1 } = cacheWrites(u);
  return (
    ((u.input_tokens ?? 0) * r.i +
      w5 * r.i * 1.25 +
      w1 * r.i * 2 +
      (u.cache_read_input_tokens ?? 0) * (r.cr ?? r.i * 0.1) +
      (u.output_tokens ?? 0) * r.o) /
    1e6
  );
}

function totalTokens(u: Usage): number {
  const { w5, w1 } = cacheWrites(u);
  return (
    (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + w5 + w1 + (u.cache_read_input_tokens ?? 0)
  );
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ── verify --content: the runtime twin of the content boundary ───────────────
//
// "Vole never stores prompt or tool content" is enforced two ways: the branded
// Content type makes accidental storage a compile-time oddity (see src/content.ts),
// and THIS check makes the claim falsifiable against the actual store:
//   1. STRUCTURE — every table and column must be in the allowlist below. A new
//      column is a deliberate act that must be reviewed here, by name.
//   2. SHAPE — the free-text columns that exist (rule titles, detail sentences,
//      raw paths, tool lists) must look like what the writers produce: short,
//      single-line. Anything long or multi-line is content-shaped and fails.
const CONTENT_ARGS = process.argv.slice(2);
if (CONTENT_ARGS.includes('--content')) {
  const dbFileC = paths.db();
  if (!existsSync(dbFileC)) {
    console.log('verify --content');
    console.log(`  FAIL — no store at ${dbFileC}; nothing to prove the claim against.`);
    process.exit(1);
  }
  const dbc = new Database(dbFileC, { readonly: true, fileMustExist: true });

  const ALLOWED_COLUMNS: Record<string, string[]> = {
    usage_events: ['id', 'event_key', 'tool', 'model', 'session_id', 'project', 'git_branch', 'ts',
      'input_tokens', 'output_tokens', 'cache_write_5m_tokens', 'cache_write_1h_tokens',
      'cache_read_tokens', 'reasoning_tokens', 'total_tokens', 'cost_usd', 'confidence',
      'is_error', 'stop_reason', 'source', 'raw_ref', 'user', 'machine', 'tools',
      'agent_id', 'context_window',
      // A response duration in ms where the SOURCE states one (OpenCode's
      // completed-created span). A number, never content; NULL = unknown.
      'duration_ms',
      // Provenance of that duration: 'measured' or 'turn_scoped' — one word.
      'duration_kind'],
    anomalies: ['id', 'anomaly_key', 'rule', 'severity', 'tool', 'session_id', 'model',
      'window_start', 'window_end', 'title', 'detail', 'observed', 'baseline',
      'threshold', 'confidence', 'source', 'detected_at', 'user', 'machine'],
    collector_state: ['source_path', 'tool', 'last_offset', 'last_mtime', 'last_scanned_at'],
    collector_runs: ['id', 'tool', 'started_at', 'duration_ms', 'files', 'parsed', 'inserted',
      'source_state', 'ok', 'notes'],
    scan_state: ['scanner', 'cadence_ms', 'last_started_at', 'last_duration_ms', 'ok', 'notes'],
    schema_migrations: ['version', 'name', 'kind', 'applied_at', 'duration_ms', 'rows_changed'],
    // Inventory facts only: paths, names, versions, evidence sentences. A surface
    // row is what EXISTS on disk, never what was typed into any of these tools.
    ai_surfaces: ['id', 'surface_key', 'kind', 'name', 'path', 'evidence', 'version', 'extra',
      'first_seen', 'last_seen', 'sanctioned'],
    // Triage dispositions. `note` is operator-typed free text and is shape-scanned
    // below — long or multiline notes fail, so a pasted prompt cannot hide there.
    finding_actions: ['id', 'anomaly_key', 'action', 'note', 'until', 'actor', 'created_at'],
    // The DLP ledger: fingerprints and locations ONLY. The sighting's value stays
    // in the source file; the just-in-time viewer re-reads it at view time. No
    // column exists here that could hold a secret value, by construction.
    secret_sightings: ['id', 'fingerprint', 'detector', 'sink_key', 'path', 'byte_offset',
      'byte_length', 'direction', 'status', 'first_seen', 'last_seen'],
    dlp_scan_state: ['sink_key', 'bytes_scanned', 'bytes_skipped', 'bytes_unreadable', 'last_seen_at', 'completed'],
  };

  const findings: string[] = [];
  const tables = dbc
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const t of tables) {
    const allowed = ALLOWED_COLUMNS[t.name];
    if (!allowed) {
      findings.push(`table ${t.name} is not in the content allowlist — a new table must be reviewed here`);
      continue;
    }
    const cols = (dbc.prepare(`PRAGMA table_info(${t.name})`).all() as { name: string }[]).map((c) => c.name);
    for (const c of cols) {
      if (!allowed.includes(c)) findings.push(`column ${t.name}.${c} is not in the content allowlist`);
    }
  }

  // Shape scan: every free-text value must be short and single-line.
  const TEXT_COLUMNS: [table: string, column: string][] = [
    ['usage_events', 'event_key'], ['usage_events', 'raw_ref'], ['usage_events', 'tools'],
    ['usage_events', 'session_id'], ['usage_events', 'project'], ['usage_events', 'model'],
    ['usage_events', 'stop_reason'], ['usage_events', 'agent_id'],
    ['anomalies', 'title'], ['anomalies', 'detail'], ['anomalies', 'anomaly_key'],
    ['collector_runs', 'notes'], ['scan_state', 'notes'],
    ['finding_actions', 'note'], ['ai_surfaces', 'evidence'], ['ai_surfaces', 'extra'],
  ];
  let scanned = 0;
  for (const [table, column] of TEXT_COLUMNS) {
    const rows = dbc.prepare(`SELECT "${column}" AS v FROM ${table} WHERE "${column}" IS NOT NULL`).all() as { v: string }[];
    for (const r of rows) {
      scanned++;
      if (r.v.length > 512 || r.v.includes('\n')) {
        findings.push(`${table}.${column} holds a content-shaped value (${r.v.length} chars${r.v.includes('\n') ? ', multiline' : ''})`);
      }
    }
  }

  console.log('Vole content verification');
  console.log('────────────────────────');
  console.log(`  store                     ${dbFileC} (read-only)`);
  console.log(`  tables checked            ${tables.length}`);
  console.log(`  text values shape-scanned ${scanned}`);
  console.log(`  content-shaped findings   ${findings.length}`);
  for (const f of findings) console.log(`    ✗ ${f}`);
  console.log(findings.length === 0
    ? '\n  PASS — no column exists that could hold content, and every free-text value matches its writer\'s shape.'
    : '\n  FAIL — the no-content claim is falsified above.');
  process.exit(findings.length === 0 ? 0 : 1);
}

// ── verify --surfaces: the firewall between inventory and usage ──────────────
//
// A surface row proves an artifact exists on disk — never that a prompt was
// sent or a token spent. This check keeps that boundary mechanical: the
// census writes ONLY to ai_surfaces and the anomaly feed, and nothing in the
// usage tables may trace to it. Plus the integrity invariants of the registry
// itself, and the policy state in force at the last scan.
if (CONTENT_ARGS.includes('--surfaces')) {
  const dbFileS = paths.db();
  if (!existsSync(dbFileS)) {
    console.log('verify --surfaces');
    console.log(`  FAIL — no store at ${dbFileS}.`);
    process.exit(1);
  }
  const dbs = new Database(dbFileS, { readonly: true, fileMustExist: true });

  const has = (t: string) =>
    (dbs.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?").get(t) as { n: number }).n > 0;
  if (!has('ai_surfaces')) {
    console.log('verify --surfaces');
    console.log('  FAIL — no ai_surfaces table: the census scanner has never run against this store.');
    process.exit(1);
  }

  const sFindings: string[] = [];
  const byKind = dbs
    .prepare('SELECT kind, COUNT(*) AS n FROM ai_surfaces GROUP BY kind ORDER BY kind')
    .all() as { kind: string; n: number }[];
  const total = byKind.reduce((s, r) => s + r.n, 0);

  // Integrity: every row carries evidence and sane timestamps.
  const noEvidence = (dbs.prepare('SELECT COUNT(*) AS n FROM ai_surfaces WHERE evidence IS NULL OR evidence = \'\'').get() as { n: number }).n;
  if (noEvidence > 0) sFindings.push(`${noEvidence} surface row(s) have no evidence sentence`);
  const badTimes = (dbs.prepare('SELECT COUNT(*) AS n FROM ai_surfaces WHERE first_seen > last_seen').get() as { n: number }).n;
  if (badTimes > 0) sFindings.push(`${badTimes} surface row(s) have first_seen after last_seen`);

  // The firewall: the scanner's anomaly keys are namespaced and must be the
  // ONLY way surfaces touch the incident feed — never usage_events.
  const surfaceAnomalies = (dbs.prepare("SELECT COUNT(*) AS n FROM anomalies WHERE rule IN ('unsanctioned_surface', 'new_ai_surface')").get() as { n: number }).n;

  // Policy state at the last scan: NULL sanctioned = inert rule, and it must
  // say so rather than count as unsanctioned.
  const sanctioned = dbs
    .prepare('SELECT COALESCE(sanctioned, -1) AS s, COUNT(*) AS n FROM ai_surfaces GROUP BY s')
    .all() as { s: number; n: number }[];
  const pol = (v: number) => sanctioned.find((r) => r.s === v)?.n ?? 0;

  console.log('Vole surface verification');
  console.log('────────────────────────');
  console.log(`  surfaces in registry          ${total}`);
  for (const r of byKind) console.log(`    ${r.kind.padEnd(10)} ${r.n}`);
  console.log(`  sanctioned / unsanctioned / no-policy`);
  console.log(`    ${pol(1)} / ${pol(0)} / ${pol(-1)}${pol(-1) > 0 ? '  (no declaration loaded: the unsanctioned rule is INERT — it is a company decision, not a technical fact)' : ''}`);
  console.log(`  surface-rule incidents         ${surfaceAnomalies} (new_ai_surface + unsanctioned_surface)`);
  console.log(`  integrity findings            ${sFindings.length}`);
  for (const f of sFindings) console.log(`    ✗ ${f}`);
  console.log(sFindings.length === 0
    ? '\n  PASS — inventory is inventory: surface rows carry evidence, and nothing in usage traces to the census.'
    : '\n  FAIL');
  process.exit(sFindings.length === 0 ? 0 : 1);
}

// ── Claude Code ──────────────────────────────────────────────────────────────
// Claude Code writes each message several times while streaming; the fullest copy is
// the authoritative one, so keep the occurrence with the most tokens — the same rule
// the collector uses, reached independently.
interface ClaudeTruth {
  model?: string;
  usage: Usage;
  total: number;
  done: boolean;
}
const truth = new Map<string, ClaudeTruth>();
let rawRows = 0;
const root = paths.claudeCodeProjects();
if (existsSync(root)) {
  // Same recursive walk as the collector: subagent transcripts nest under the session.
  for (const f of walkTranscripts(root)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type !== 'assistant' || !e.message?.usage || !e.message?.id) continue;
      rawRows++;
      const total = totalTokens(e.message.usage);
      const prev = truth.get(e.message.id);
      if (!prev || total > prev.total) {
        truth.set(e.message.id, {
          model: e.message.model,
          usage: e.message.usage,
          total,
          done: e.message.stop_reason != null || e.isApiErrorMessage === true,
        });
      }
    }
  }
}

const dbFile = paths.db();
if (!existsSync(dbFile)) {
  console.log('Vole verification');
  console.log('────────────────────────');
  console.log(`  FAIL — no store at ${dbFile}. Run the collector first; verify never creates one.`);
  process.exit(1);
}
// Read-only: verification must not create, migrate or write the thing it checks.
const db = new Database(dbFile, { readonly: true, fileMustExist: true });

/** Per-row file-existence, cached: the horizon check is one syscall per file, not per row. */
const existsCache = new Map<string, boolean>();
function fileExists(p: string): boolean {
  let v = existsCache.get(p);
  if (v === undefined) {
    v = existsSync(p);
    existsCache.set(p, v);
  }
  return v;
}

interface ClaudeRow {
  event_key: string;
  model: string | null;
  cost_usd: number | null;
  total_tokens: number | null;
  raw_ref: string | null;
}
function loadClaudeRows(keys?: Set<string>): ClaudeRow[] {
  const all = db
    .prepare(
      // source='live' is essential: seeded demo rows are synthetic and have no
      // corresponding log record, so including them would always report false failures.
      "SELECT event_key, model, cost_usd, total_tokens, raw_ref FROM usage_events " +
        "WHERE tool='claude_code' AND source='live'",
    )
    .all() as ClaudeRow[];
  return keys ? all.filter((r) => keys.has(r.event_key)) : all;
}

interface ClaudeVerdict {
  /** Stored total lags the final source record: the next poll upgrades it. */
  lagging: boolean;
  /** Stored total is null or exceeds the final source record: no poll can fix this. */
  tokBad: boolean;
  /** Cost deviates from the independent recompute (Infinity = wrong null-ness). */
  costBad?: number;
  /** Priced by the product, but no independent RATES entry to check against. */
  unverified?: boolean;
}

/**
 * Compares one stored row against its FINAL source record. While tokens lag, the upsert
 * (which replaces cost and tokens together) may fix both on the next poll, so a lagging
 * row is reported as lagging, not mismatched.
 */
function claudeVerdict(r: ClaudeRow, t: ClaudeTruth): ClaudeVerdict {
  const expTok = totalTokens(t.usage);

  let costBad: number | undefined;
  let unverified: boolean | undefined;
  if (rate(r.model) || rate(t.model)) {
    const exp = expectedCost(t.model, t.usage);
    const got = r.cost_usd;
    if (exp === null) {
      if (got !== null) costBad = Infinity;
    } else if (got === null || Math.abs(exp - got) > 1e-9) {
      costBad = got === null ? exp : Math.abs(exp - got);
    }
  } else if (priced(t.model)) {
    unverified = true;
  } else if (r.cost_usd !== null) {
    costBad = Infinity; // no rate at all, yet a cost was stored
  }

  const stored = r.total_tokens;
  const lagging = stored !== null && stored < expTok;
  const tokBad = stored === null || stored > expTok;
  return { lagging, tokBad, costBad, unverified };
}

// ── OpenCode: independent check that total_tokens is a real sum, two ways ──
// (a) recompute input+output+reasoning+cache from the message's own token object;
// (b) compare against OpenCode's own `tokens.total` field. Both must equal the stored row.
const ocSrc = new Map<string, { sum: number; final: boolean }>();
const ocPath = paths.opencodeDb();
if (existsSync(ocPath)) {
  const oc = new Database(ocPath, { readonly: true, fileMustExist: true });
  for (const m of oc
    .prepare(`SELECT id, data FROM message WHERE json_extract(data,'$.role')='assistant'`)
    .all() as { id: string; data: string }[]) {
    let d: any;
    try {
      d = JSON.parse(m.data);
    } catch {
      continue;
    }
    const t = d.tokens;
    if (!t) continue;
    const sum =
      (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
    // OpenCode's own total must agree with our re-sum; if not, don't trust either.
    if (typeof t.total === 'number' && t.total !== sum) continue;
    ocSrc.set(m.id, { sum, final: d.time?.completed != null });
  }
  oc.close();
}

interface OcRow {
  event_key: string;
  total_tokens: number | null;
}
function loadOcRows(keys?: Set<string>): OcRow[] {
  const all = db
    .prepare("SELECT event_key, total_tokens FROM usage_events WHERE tool='opencode' AND source='live'")
    .all() as OcRow[];
  return keys ? all.filter((r) => keys.has(r.event_key)) : all;
}

function ocVerdict(r: OcRow, s: { sum: number; final: boolean }): 'ok' | 'inflight' | 'lagging' | 'mismatch' {
  if (!s.final) return 'inflight';
  if (r.total_tokens === null || r.total_tokens > s.sum) return 'mismatch';
  if (r.total_tokens < s.sum) return 'lagging';
  return 'ok';
}

// ── First pass over both ──
let claudeReconciled = 0;
let claudeInFlight = 0;
let claudeCostMismatch = 0;
let claudeTokMismatch = 0;
let claudeNotInLogs = 0;
let claudePruned = 0;
let claudeUnverified = 0;
let worstDelta = 0;
const laggingClaude = new Map<string, ClaudeRow>();

function applyClaudeVerdict(v: ClaudeVerdict, recheck: boolean): void {
  if (v.tokBad || (recheck && v.lagging)) claudeTokMismatch++;
  if (v.costBad !== undefined) {
    claudeCostMismatch++;
    if (Number.isFinite(v.costBad)) worstDelta = Math.max(worstDelta, v.costBad);
  }
}

for (const r of loadClaudeRows()) {
  const t = truth.get(r.event_key.slice('claude_code:'.length));
  if (!t) {
    // Source horizon: the transcript is gone (Claude Code's own cleanup prunes
    // after cleanupPeriodDays, default 30; users delete project dirs). The row
    // cannot be re-proved from local evidence — reported, never failed.
    if (r.raw_ref && !fileExists(r.raw_ref)) claudePruned++;
    else claudeNotInLogs++;
    continue;
  }
  if (!t.done) {
    claudeInFlight++;
    continue;
  }
  claudeReconciled++;
  const v = claudeVerdict(r, t);
  if (v.unverified) claudeUnverified++;
  if (v.lagging) {
    laggingClaude.set(r.event_key, r);
    continue;
  }
  applyClaudeVerdict(v, false);
}

let ocReconciled = 0;
let ocInFlight = 0;
let ocMismatch = 0;
const laggingOc = new Map<string, OcRow>();
for (const r of loadOcRows()) {
  const s = ocSrc.get(r.event_key.slice('opencode:'.length));
  if (!s) continue;
  const v = ocVerdict(r, s);
  if (v === 'inflight') {
    ocInFlight++;
    continue;
  }
  ocReconciled++;
  if (v === 'ok') continue;
  if (v === 'lagging') {
    laggingOc.set(r.event_key, r);
    continue;
  }
  ocMismatch++;
}

// ── Grace period: lagging rows heal within one poll interval of a running
// collector. Longer than the default 5s; re-check only what lagged. ──
let healed = 0;
if (laggingClaude.size + laggingOc.size > 0) {
  await sleep(7_000);
  const keysC = new Set(laggingClaude.keys());
  const keysO = new Set(laggingOc.keys());
  for (const r of loadClaudeRows(keysC)) {
    const t = truth.get(r.event_key.slice('claude_code:'.length));
    if (!t) continue;
    const v = claudeVerdict(r, t);
    if (!v.lagging && !v.tokBad && v.costBad === undefined) healed++;
    applyClaudeVerdict(v, true);
  }
  for (const r of loadOcRows(keysO)) {
    const s = ocSrc.get(r.event_key.slice('opencode:'.length));
    if (!s) continue;
    if (ocVerdict(r, s) === 'ok') healed++;
    else ocMismatch++;
  }
}

// ── Codex: the cumulative meter is the source of truth for consumption ──
// Per token_count event the expected stored total is the meter delta (duplicate
// emissions advance it by zero and must not produce rows). Breakdown fields must match
// the source's attribution, and must be NULL — not 0 — when the source never split the
// meter. 0 for an unsplit meter was the original defect this check guards against.
interface CxExpected {
  delta: number;
  fresh: number | null;
  cached: number | null;
  output: number | null;
  attributed: number;
  model?: string | null;
}
const cxExpected = new Map<string, CxExpected>();
let cxEvents = 0;

function walkRollouts(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkRollouts(p, out);
    else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push(p);
  }
}

const cxRoot = paths.codexSessions();
if (existsSync(cxRoot)) {
  const files: string[] = [];
  walkRollouts(cxRoot, files);
  for (const filePath of files) {
    let lines: string[];
    try {
      lines = readFileSync(filePath, 'utf8').split('\n').filter((l) => l.length > 0);
    } catch {
      continue;
    }
    let model: string | null = null;
    let prev = 0;
    lines.forEach((line, index) => {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (e.type === 'turn_context' && e.payload?.model) {
        model = e.payload.model;
        return;
      }
      if (e.payload?.type !== 'token_count') return;
      const total = e.payload.info?.total_token_usage;
      const last = e.payload.info?.last_token_usage;
      if (!total && !last) return;
      cxEvents++;

      let delta: number;
      let usage: any;
      if (total) {
        const cum = total.total_tokens ?? 0;
        if (cum > prev) {
          delta = cum - prev;
          usage = last && (last.total_tokens ?? 0) + prev === cum ? last : last ?? total;
          prev = cum;
        } else if (cum < prev) {
          delta = cum; // counter reset: whole meter is new-segment consumption
          usage = last ?? total;
          prev = cum;
        } else {
          return; // duplicate emission
        }
      } else {
        usage = last;
        delta = usage.total_tokens ?? 0;
        if (delta <= 0) return;
      }

      const input = usage.input_tokens ?? 0;
      const cached = usage.cached_input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;
      const fresh = Math.max(0, input - cached);
      const attributed = fresh + cached + output;

      cxExpected.set(`${filePath}#${index}`, {
        delta,
        fresh: attributed > 0 ? fresh : null,
        cached: attributed > 0 ? cached : null,
        output: attributed > 0 ? output : null,
        attributed,
        model,
      });
    });
  }
}

let cxReconciled = 0;
let cxTokenMismatch = 0;
let cxFieldMismatch = 0;
let cxCostMismatch = 0;
let cxNotInLogs = 0;
let cxPruned = 0;

const cxRows = db
  .prepare(
    "SELECT raw_ref, model, cost_usd, total_tokens, input_tokens, cache_read_tokens, output_tokens " +
      "FROM usage_events WHERE tool='codex' AND source='live' AND raw_ref IS NOT NULL",
  )
  .all() as {
    raw_ref: string;
    model: string | null;
    cost_usd: number | null;
    total_tokens: number | null;
    input_tokens: number | null;
    cache_read_tokens: number | null;
    output_tokens: number | null;
  }[];

for (const r of cxRows) {
  const exp = cxExpected.get(r.raw_ref);
  if (!exp) {
    // Same horizon rule as Claude: a rollout file the vendor tool (or the user)
    // removed can no longer prove or disprove its rows.
    const hash = r.raw_ref.lastIndexOf('#');
    const file = hash > 0 ? r.raw_ref.slice(0, hash) : r.raw_ref;
    if (!fileExists(file)) cxPruned++;
    else cxNotInLogs++;
    continue;
  }
  cxReconciled++;
  if (r.total_tokens !== exp.delta) cxTokenMismatch++;
  if (exp.attributed > 0) {
    if (r.input_tokens !== exp.fresh || r.cache_read_tokens !== exp.cached || r.output_tokens !== exp.output)
      cxFieldMismatch++;
  } else if (r.input_tokens !== null || r.cache_read_tokens !== null || r.output_tokens !== null) {
    cxFieldMismatch++; // stored a number the source never attributed
  }
  if (!priced(r.model)) {
    if (r.cost_usd !== null) cxCostMismatch++;
  }
}
let cxLost = 0;
for (const ref of cxExpected.keys()) {
  if (!cxRows.some((r) => r.raw_ref === ref)) cxLost++;
}

// ── Grok: unified.jsonl is append-only and never pruned by the tool, so every
// exact stored row must still be provable from the log. (Failed calls are
// activity_only and are covered by the no-token section.) ──
const grokTruth = new Map<string, number>();
const grokPath = paths.grokUnifiedLog();
if (existsSync(grokPath)) {
  try {
    for (const raw of readFileSync(grokPath, 'utf8').split('\n')) {
      if (!raw) continue;
      let e: any;
      try {
        e = JSON.parse(raw);
      } catch {
        continue;
      }
      if (e.msg !== 'shell.turn.inference_done' || !e.ctx || !e.sid || !e.ts) continue;
      const prompt = e.ctx.prompt_tokens ?? 0;
      const completion = e.ctx.completion_tokens ?? 0;
      if (prompt === 0 && completion === 0) continue;
      grokTruth.set(`grok:${e.sid}:${e.ts}`, prompt + completion);
    }
  } catch {
    /* unreadable log: reconcile nothing rather than fail everything */
  }
}

let grokReconciled = 0;
let grokTokenMismatch = 0;
let grokNotInLogs = 0;
let grokNotStored = 0;
{
  const rows = db
    .prepare(
      "SELECT event_key, total_tokens FROM usage_events WHERE tool='grok' AND source='live' AND confidence='exact'",
    )
    .all() as { event_key: string; total_tokens: number | null }[];
  const stored = new Set(rows.map((r) => r.event_key));
  for (const r of rows) {
    const t = grokTruth.get(r.event_key);
    if (t === undefined) {
      grokNotInLogs++;
      continue;
    }
    grokReconciled++;
    if (r.total_tokens !== t) grokTokenMismatch++;
  }
  for (const key of grokTruth.keys()) if (!stored.has(key)) grokNotStored++;
}

// ── The store itself: absent is already failed above; empty is the same failure.
// A vacuous PASS (every counter zero on a fresh store) proves nothing, so an
// empty live store fails here before any reconciliation runs. ──
const liveStored = (
  db.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE source='live'").get() as { n: number }
).n;
if (liveStored === 0) {
  const sources = [
    rawRows > 0 ? `claude (${rawRows} raw rows)` : null,
    ocSrc.size > 0 ? `opencode (${ocSrc.size} messages)` : null,
    cxEvents > 0 ? `codex (${cxEvents} meter events)` : null,
    grokTruth.size > 0 ? `grok (${grokTruth.size} calls)` : null,
  ].filter((s): s is string => s !== null);
  console.log('Vole verification');
  console.log('────────────────────────');
  if (sources.length > 0) {
    console.log(`  FAIL — the store at ${dbFile} holds no live rows, but the sources have ${sources.join(', ')}.`);
    console.log('  Run the collector first: pnpm collect --once');
  } else {
    console.log('  FAIL — no live rows in the store and no source artifacts on this machine.');
    console.log('  There is nothing to verify; a PASS here would prove nothing.');
  }
  process.exit(1);
}

// ── No-token sources: rows must be NULL in every token field ──
let noTokChecked = 0;
let noTokMismatch = 0;
for (const r of db
  .prepare(
    "SELECT input_tokens, output_tokens, cache_read_tokens, total_tokens, cost_usd " +
      "FROM usage_events WHERE confidence='activity_only' AND source='live'",
  )
  .all() as {
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    total_tokens: number | null;
    cost_usd: number | null;
  }[]) {
  noTokChecked++;
  if (
    r.input_tokens !== null ||
    r.output_tokens !== null ||
    r.cache_read_tokens !== null ||
    r.total_tokens !== null ||
    r.cost_usd !== null
  )
    noTokMismatch++;
}

const dupeRatio = truth.size > 0 ? rawRows / truth.size : 0;
const claudeRowsTotal = claudeReconciled + claudeInFlight + claudeNotInLogs + claudePruned;

console.log('Vole verification');
console.log('────────────────────────');
console.log(`  store                          ${dbFile} (read-only)`);
console.log(`  live rows in store            ${liveStored}`);
console.log(`  [claude] raw usage rows in logs  ${rawRows}`);
console.log(`  [claude] unique message ids      ${truth.size}`);
console.log(`  [claude] duplication factor      ${dupeRatio.toFixed(2)}x  <- inflation avoided by dedup`);
console.log(`  [claude] rows stored (live only) ${claudeRowsTotal}`);
console.log(`  [claude] reconciled per-message  ${claudeReconciled}`);
console.log(`  [claude] in flight (not final)   ${claudeInFlight}  (skipped)`);
console.log(`  [claude] token mismatches        ${claudeTokMismatch}`);
console.log(`  [claude] cost mismatches         ${claudeCostMismatch}`);
console.log(`  [claude] cost unverified         ${claudeUnverified}  (priced, no independent rate here)`);
console.log(`  [claude] worst cost delta (USD)  ${worstDelta.toExponential(2)}`);
console.log(`  [claude] pruned by source cleanup ${claudePruned}  (reported — the transcript is gone, the row cannot be re-proved)`);
console.log(`  [claude] stored but not in logs  ${claudeNotInLogs}  (expect 0)`);
console.log(`  [opencode] reconciled            ${ocReconciled}`);
console.log(`  [opencode] in flight (not final) ${ocInFlight}  (skipped)`);
console.log(`  [opencode] token mismatches      ${ocMismatch}`);
console.log(`  [codex] meter events in logs     ${cxEvents}`);
console.log(`  [codex] rows stored (live only)  ${cxRows.length}`);
console.log(`  [codex] reconciled per-event     ${cxReconciled}`);
console.log(`  [codex] token mismatches         ${cxTokenMismatch}  (stored total != meter delta)`);
console.log(`  [codex] breakdown mismatches     ${cxFieldMismatch}  (incl. 0 where source never split)`);
console.log(`  [codex] cost mismatches          ${cxCostMismatch}`);
console.log(`  [codex] pruned by source cleanup ${cxPruned}  (reported, same horizon rule)`);
console.log(`  [codex] consumed, not yet stored ${cxLost}  (lags while collect is stopped)`);
console.log(`  [codex] stored but not in logs   ${cxNotInLogs}  (expect 0)`);
console.log(`  [grok] calls in unified log      ${grokTruth.size}`);
console.log(`  [grok] reconciled per-event      ${grokReconciled}`);
console.log(`  [grok] token mismatches          ${grokTokenMismatch}`);
console.log(`  [grok] stored but not in log     ${grokNotInLogs}  (expect 0 — the log is append-only)`);
console.log(`  [grok] in log, not yet stored   ${grokNotStored}  (lags while collect is stopped)`);
console.log(`  [no-token] activity_only rows    ${noTokChecked}`);
console.log(`  [no-token] fields not NULL       ${noTokMismatch}  (expect 0)`);
if (healed > 0) console.log(`  [grace] lagging rows healed in 7s ${healed}`);

const ok =
  claudeCostMismatch === 0 &&
  claudeTokMismatch === 0 &&
  claudeNotInLogs === 0 &&
  claudeRowsTotal - claudePruned <= truth.size &&
  ocMismatch === 0 &&
  cxTokenMismatch === 0 &&
  cxFieldMismatch === 0 &&
  cxCostMismatch === 0 &&
  cxNotInLogs === 0 &&
  grokTokenMismatch === 0 &&
  grokNotInLogs === 0 &&
  noTokMismatch === 0;
console.log(
  ok
    ? `\n  PASS — every stored row matches its source record, or its source is pruned and reported.`
    : '\n  FAIL',
);
process.exit(ok ? 0 : 1);
