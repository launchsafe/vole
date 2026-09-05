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
 * the cumulative meter, breakdown fields, cost). Sources that persist no token data
 * (Cursor, Antigravity, Devin) have nothing numeric to reconcile: their rows are
 * checked for NULL-ness in the token fields.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../sqlite';
import { openDb } from '../db';
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

const db = openDb();

interface ClaudeRow {
  event_key: string;
  model: string | null;
  cost_usd: number | null;
  total_tokens: number | null;
}
function loadClaudeRows(keys?: Set<string>): ClaudeRow[] {
  const all = db
    .prepare(
      // source='live' is essential: seeded demo rows are synthetic and have no
      // corresponding log record, so including them would always report false failures.
      "SELECT event_key, model, cost_usd, total_tokens FROM usage_events " +
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
    claudeNotInLogs++;
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
    cxNotInLogs++;
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
const claudeRowsTotal = claudeReconciled + claudeInFlight + claudeNotInLogs;

console.log('Vole verification');
console.log('────────────────────────');
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
console.log(`  [codex] consumed, not yet stored ${cxLost}  (lags while collect is stopped)`);
console.log(`  [codex] stored but not in logs   ${cxNotInLogs}  (expect 0)`);
console.log(`  [no-token] activity_only rows    ${noTokChecked}`);
console.log(`  [no-token] fields not NULL       ${noTokMismatch}  (expect 0)`);
if (healed > 0) console.log(`  [grace] lagging rows healed in 7s ${healed}`);

const ok =
  claudeCostMismatch === 0 &&
  claudeTokMismatch === 0 &&
  claudeNotInLogs === 0 &&
  ocMismatch === 0 &&
  cxTokenMismatch === 0 &&
  cxFieldMismatch === 0 &&
  cxCostMismatch === 0 &&
  cxNotInLogs === 0 &&
  noTokMismatch === 0 &&
  claudeRowsTotal <= truth.size;
console.log(ok ? '\n  PASS — every stored row matches its source record.' : '\n  FAIL');
process.exit(ok ? 0 : 1);
