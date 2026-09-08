import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import {
  openDb, insertEvents, insertAnomalies, repriceUnpriced, recordCollectorRun,
  scanDue, recordScan, boundNote, drainInbox,
} from '../db';
import { collectAll } from '../collectors';
import type { CodexCollectorResult } from '../collectors/codex';
import { detectBySource, RULE_IDS } from '../detect';
import { detectLedgerRules, buildAutonomyIntervals, buildSessionIdentity, LEDGER_RULE_IDS } from '../detect/behaviour';
import { detectCodexClaimRules } from '../detect/rules/claims';
import { SCANNERS } from '../scanners';
import { insertToolCalls } from '../toolcalls/bind';
import {
  fileWritesForCall, insertFileWrites,
} from '../toolcalls/file-writes';
import {
  secretStoreReads, grantDeposits, insertSecretStoreReads, insertGrantDeposits,
} from '../toolcalls/stores';
import { packageExecs, insertPackageExecs } from '../toolcalls/package-exec';
import { actionTargetsForCommand, insertActionTargets } from '../toolcalls/targets';
import { parseFetchIngress, insertFetchIngress } from '../toolcalls/ingress';
import { upsertAnomalyContext } from '../toolcalls/context';
import { resolvePrincipal, recordPrincipal } from '../identity/chain';
import { recordVendorIdentities, seatInventory, recordSessionIdentityClasses } from '../identity/accounts';
import { detectIdentityRules } from '../identity/rules';
import { loadIdentityPolicy } from '../identity/policy';
import { deviceKey, principalKey, recordIdentity, sweepGrants } from '../identity';
import { paths } from '../paths';
import { runBackfill } from '../backfill';
import { registerPacks } from '../packs';
import { activePack } from '../packs/registry';
import { splitModes, suppressReported, recordSuppressed } from '../packs/suppression';
import { insertAnomaliesWithRev } from '../packs/rescore';
import { stampCostBasis, loadBudgets, evaluateBudget } from '../pricing';
import { stampPricingRev } from '../packs/pricing-pack';
import { captureScope } from '../governance/scope-history';
import { resolveScannerSwitch } from '../governance/scanner-manifest';
import { runClockStamp } from '../clock';
import { ensureStoreEpoch } from './support';
import {
  ingestActions, actionsCursor, setActionsCursor, applyCaseIdentity,
  backfillActionCaseKeys, denormaliseState, caseKeyOf, detailKeyOf,
} from '../triage/case';
import { applyIntentSweep } from '../triage/control-intents';
import { classifyOrphans, recordOrphans, readClaudeHistory } from '../triage/custody';
import { noiseBudgetRows, isoWeek } from '../triage/noise';
import { activityAfterDeparture, syncLifecycleFromPolicy } from '../privacy/departure';
import { readFileSync } from 'node:fs';
import {
  syncVendorLedgerFromDisk, upsertBridgeVendorIdentities, syncQuotaObservations,
} from '../vendors/ledger';
import { enqueueOutbox } from '../export/outbox';
import { encodeShapeRow } from '../export/shapes';
import { SINKS } from '../export/sinks';
import type { EncodeCtx } from '../export/fields';
import { detectLogSourceStopped } from '../export/heartbeat';
import type { Anomaly, RateLimitObservation, Tool, UsageEvent } from '../types';

const args = process.argv.slice(2);
const once = args.includes('--once');
const verbose = args.includes('--verbose');
const notify = !args.includes('--no-notify');
const webAi = args.includes('--web-ai');
const otelListen = args.includes('--otel-listen');
const intervalArg = args.find((a) => a.startsWith('--interval='));
const intervalMs = intervalArg ? Number(intervalArg.split('=')[1]) * 1000 : 5000;

/** Only incidents this fresh get a desktop notification; a first scan over months of history must not. */
const NOTIFY_WINDOW_MS = 15 * 60_000;

/**
 * The trailing-window bound for the pure rules (tier 7's coordinated step):
 * detection used to SELECT the whole usage_events table every gated pass.
 * 120 days covers every rule's baseline window; the insert gate means a pass
 * that stored nothing new skips the scan entirely.
 * ponytail: fixed 120d window; make it rule-specific if a rule ever needs deeper history.
 */
const DETECT_WINDOW_MS = 120 * 24 * 3600_000;

const db = openDb();

// The web-AI census is opt-in and default-off by design (browser History reads).
if (webAi) process.env.VOLE_SCAN_WEB_AI = '1';

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function usd(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(2)}`;
}

/** One wiring step that must never take collection down. */
function step(name: string, fn: () => string | void): void {
  try {
    const note = fn();
    if (verbose && note) console.log(`  [${name}] ${note}`);
  } catch (err) {
    if (verbose) console.log(`  [${name}] failed: ${(err as Error).message}`);
  }
}

const encodeCtx: EncodeCtx = { device_id: deviceKey(), identity_mode: 'pseudonymous', opt_in: new Set() };

function runOnce(): void {
  const started = Date.now();
  const clock = runClockStamp();
  // Triage writes from the app arrive as spool files; drain them first so the
  // disposition ledger reflects user intent before this pass's rows land.
  const applied = drainInbox(db);
  // The scope ledger: one capture per process start (idempotent by hash — a
  // restart that changed nothing writes nothing).
  step('scope', () => {
    captureScope(db);
    return 'captured';
  });
  // The pack plane: register, stamp, requeue, apply suppressions — once per pass.
  step('packs', () => {
    const r = registerPacks(db);
    return `${r.packs.length} pack(s) in force`;
  });
  // Identity (Tier 3): the principal chain resolves once per pass, cheap and idempotent.
  step('identity', () => {
    const resolved = resolvePrincipal();
    const key = recordPrincipal(db, resolved);
    recordIdentity(db, resolved.username);
    recordVendorIdentities(db);
    // The session_identity binding ladder (tier 3 #17/#19/#21): account_class
    // from classifyAccount, session-proved where the session's own file
    // attests it, ambient where only the current-account snapshot does.
    recordSessionIdentityClasses(db, principalKey(resolved.username), deviceKey());
    const policy = loadIdentityPolicy();
    seatInventory(db, policy?.seats_purchased);
    syncLifecycleFromPolicy(db);
    return key;
  });
  let grantsSwept = 0;
  step('grants', () => {
    grantsSwept = sweepGrants(db);
    return grantsSwept > 0 ? `${grantsSwept} declaration(s) swept` : undefined;
  });
  if (applied > 0 && verbose) console.log(`  [inbox] applied ${applied} triage action(s)`);
  const results = collectAll(db);

  let totalFound = 0;
  let totalInserted = 0;
  let ledgerInserted = 0;
  const rateLimits: RateLimitObservation[] = [];

  for (const r of results) {
    if (r.rateLimits) rateLimits.push(...r.rateLimits);
    const inserted = insertEvents(db, r.events);
    // Tier 5: the tool-call ledger — inserted before the offset commit so a
    // failed write never skips calls (the bind is idempotent, re-reads heal).
    if (r.toolCalls?.length) {
      ledgerInserted += insertToolCalls(db, r.toolCalls);
      // The bind-time derivations: every ledger that needs the raw command
      // (never stored) is derived here, in the same pass that read it.
      deriveCommandLedgers(r.toolCalls);
    }
    r.commit?.(); // offsets advance only once the rows are stored
    totalFound += r.events.length;
    totalInserted += inserted;

    // The heartbeat: one row per collector per pass, even when it found nothing —
    // "we looked and there was nothing" is a fact a coverage screen must be able
    // to state, and distinct from "we never looked".
    const passEnd = Date.now();
    recordCollectorRun(db, {
      tool: r.tool,
      started_at: passEnd - (r.durationMs ?? 0),
      duration_ms: r.durationMs ?? 0,
      files: r.filesScanned,
      parsed: r.events.length,
      inserted,
      source_state: r.sourceState ?? 'ok',
      ok: r.sourceState === 'error' ? 0 : 1,
      notes: r.notes.length ? r.notes.join(' | ') : null,
      clock: {
        wall_ms: clock.wall_ms,
        boot_epoch: clock.boot_epoch,
        rss_peak_bytes: clock.rss_peak_bytes,
        cpu_user_ms: clock.cpu_user_ms,
        cpu_sys_ms: clock.cpu_sys_ms,
      },
    });

    if (verbose && r.toolCalls?.length) {
      console.log(`  ${r.tool.padEnd(12)} ledger: ${String(r.toolCalls.length).padStart(5)} tool call(s)`);
    }
    if (verbose) {
      const dupes = r.events.length - inserted;
      console.log(
        `  ${r.tool.padEnd(12)} files=${String(r.filesScanned).padStart(3)}  ` +
          `parsed=${String(r.events.length).padStart(5)}  new=${String(inserted).padStart(5)}  ` +
          `dedup-skipped=${String(dupes).padStart(5)}  ${String(r.durationMs ?? 0).padStart(5)}ms` +
          (r.sourceState === 'no_source' ? '  (no source on this machine)' : '') +
          (r.sourceState === 'error' ? '  ERROR' : ''),
      );
      for (const note of r.notes) console.log(`      note: ${note}`);
    }
  }

  // The cost stamps: cost_basis via the tool classifier, pricing_rev via the
  // pack in force — both NULL-only widenings, so historical rows keep their honesty.
  step('pricing', () => {
    const basis = stampCostBasis(db);
    const rev = stampPricingRev(db).pricing_rev;
    db.prepare('UPDATE usage_events SET pricing_rev = ? WHERE pricing_rev IS NULL').run(rev);
    return `${basis} row(s) gained a basis, pricing_rev ${rev}`;
  });
  // The Codex backfill: bounded, resumable, once per pass.
  step('backfill', () => {
    const steps = runBackfill(db);
    const filled = steps.reduce((n, s) => n + s.rowsChanged, 0);
    return filled > 0 ? `${filled} row(s) filled` : undefined;
  });
  // The vendor plane stays fresh without the network command (all reads local).
  step('vendors', () => {
    const a = syncVendorLedgerFromDisk(db);
    const b = upsertBridgeVendorIdentities(db);
    syncQuotaObservations(db);
    return `ledger ${a.rows} row(s), ${b} bridge identit(ies)`;
  });

  // The scanner lane: gated by each scanner's own cadence, never the poll's.
  // A check is one indexed read; a body runs at most once per cadence_ms.
  // Every scanner is switch-gated: the manifest promise is only a control
  // because this loop honours resolveScannerSwitch. It runs BEFORE the
  // detection pass: the net-ledgers scan fills vcs_actions/context_edges from
  // stored tool calls, and the ledger rules read those tables in this same
  // pass — after the scan they would fire one pass late.
  for (const s of SCANNERS) {
    if (!scanDue(db, s.name, s.cadenceMs)) continue;
    const t0 = Date.now();
    let ok = false;
    let notes: string | null = null;
    const sw = resolveScannerSwitch(s.name);
    if (!sw.enabled) {
      notes = `off (${sw.basis}${sw.locked ? ', pinned by managed policy' : ''})`;
    } else {
      try {
        const r = s.run();
        ok = r.ok;
        notes = r.notes ?? null;
      } catch (err) {
        ok = false;
        notes = `scanner failed: ${(err as Error).message}`;
      }
    }
    recordScan(db, s.name, s.cadenceMs, t0, Date.now() - t0, ok, notes);
    if (verbose && notes) console.log(`  [scan] ${s.name}: ${notes}`);
  }

  // Rules need full history to establish a baseline, so they run over the
  // trailing window, not just this poll's new rows. Stable anomaly_keys keep
  // re-runs idempotent. The pass is insert-gated: rules are pure functions of
  // stored rows (plus live rate-limit observations), so a poll that stored
  // nothing new cannot produce a new anomaly — and the full-table scan that
  // detection costs is skipped entirely. ONE exception: a rule EPOCH. When
  // the rule registry itself changes (a new rule ships), it must see the
  // historical rows once, or it would silently wait for the next insert.
  const rulesEpoch = RULE_IDS.join(',') + ';' + LEDGER_RULE_IDS.join(',');
  const lastEpoch = db
    .prepare("SELECT notes FROM scan_state WHERE scanner = 'detection-rules'")
    .get() as { notes: string | null } | undefined;
  // The stored note is the bounded form (recordScan truncates the rule-id list
  // to honour the content boundary), so the compare runs through the same
  // transform — the digest in boundNote still distinguishes every rule-set change.
  const epochChanged = lastEpoch?.notes !== boundNote(rulesEpoch);
  let anomalies: Anomaly[] = [];
  let newAnomalies: Anomaly[] = [];
  let escalatedAnomalies: Anomaly[] = [];
  if (totalInserted > 0 || rateLimits.length > 0 || epochChanged || ledgerInserted > 0) {
    const now = Date.now();
    const all = db
      .prepare('SELECT * FROM usage_events WHERE ts > ? ORDER BY ts')
      .all(now - DETECT_WINDOW_MS) as UsageEvent[];
    anomalies = detectBySource(all, { live: rateLimits }, now);
    // The ledger rules read the store directly — they run in the same pass.
    anomalies.push(...detectLedgerRules(db, now));
    // Identity rules (tier 3): the rule epoch forces one historical pass.
    anomalies.push(...detectIdentityRules(db, now).anomalies);
    // Departure discipline (tier 8): activity after a declared departure.
    anomalies.push(...activityAfterDeparture(db, now));
    // Codex confinement-claim violations: the current pass's parsed claims.
    const codex = results.find((r): r is CodexCollectorResult => r.tool === 'codex') as CodexCollectorResult | undefined;
    if (codex?.codexClaims?.length) anomalies.push(...detectCodexClaimRules(db, codex.codexClaims, now));
    // The dead-man's switch: a source that stopped producing rows.
    anomalies.push(...detectLogSourceStopped(
      db.prepare('SELECT tool, MAX(started_at) AS last_run_at FROM collector_runs GROUP BY tool').all() as { tool: string; last_run_at: number | null }[],
      intervalMs * 10,
      now,
    ));
    // Budgets (tier 8): verdict anomalies from the declared budget set.
    anomalies.push(...budgetAnomalies(now));
    // The suppression register (tier 6): mute_scan skips evaluation, mute_report
    // counts what it hid.
    const { evaluate, skip } = splitModes(db, now);
    anomalies = anomalies.filter((a) => !skip.has(a.rule));
    anomalies = suppressReported(db, anomalies, now) as Anomaly[];
    for (const rule of skip) recordSuppressed(db, rule, null, null, now);
    // Insert at the DLP pack revision in force, so every incident names its rule set.
    let written: { inserted: Anomaly[]; escalated: Anomaly[] };
    try {
      written = insertAnomaliesWithRev(db, anomalies, activePack(db, 'dlp_detectors').version);
    } catch {
      written = insertAnomalies(db, anomalies);
    }
    // The outbox: new rows are enqueued for every sink in the same pass that
    // produced them. Local rows only — nothing leaves without --send.
    enqueueNewRows(written.inserted, totalInserted > 0 ? all.slice(-totalInserted) : []);
    // The autonomy timeline + session identity: structures rebuilt per pass.
    buildAutonomyIntervals(db);
    buildSessionIdentity(db, principalKey(userInfo().username), deviceKey());
    // The anomaly context ledger (tier 5): observed/baseline/threshold reach every reader.
    upsertAnomalyContext(db);
    newAnomalies = written.inserted;
    escalatedAnomalies = written.escalated;
    if (epochChanged) {
      recordScan(db, 'detection-rules', 0, Date.now(), 0, true, rulesEpoch);
    }
  }

  // ── the triage plane (tier 7): case identity, backfill, state, orphans ──
  step('triage', () => {
    const from = actionsCursor(db);
    const ing = ingestActions(db, from);
    setActionsCursor(db, ing.offset);
    applyCaseIdentity(db);
    backfillActionCaseKeys(db);
    denormaliseState(db);
    applyIntentSweep(db);
    recordOrphans(db, classifyOrphans(db, readClaudeHistory()));
    ensureStoreEpoch(db, process.env.npm_package_version ?? '0');
    return ing.ingested > 0 ? `${ing.ingested} action(s) ingested` : undefined;
  });

  // The noise budget (tier 7): one info row per rule-week that blew it.
  step('noise', () => {
    const { exceeded } = noiseBudgetRows(db);
    if (!exceeded.length) return undefined;
    insertAnomalies(db, exceeded.map((e) => ({
      anomaly_key: `noise_budget_exceeded:${e.anomaly_key}`,
      rule: 'noise_budget_exceeded' as const,
      severity: 'info' as const,
      tool: 'vole' as const,
      session_id: null,
      model: null,
      window_start: Date.parse(`${e.iso_week}-4T00:00:00Z`) || Date.now(),
      window_end: Date.now(),
      title: `Noise budget exceeded: ${e.rule} (${e.findings} findings, budget ${e.budget})`,
      detail:
        `Rule ${e.rule} produced ${e.findings} findings in week ${e.iso_week} against a budget of ${e.budget}. ` +
        `The meta-rule names the rules that blew the budget — it is never itself counted.`,
      observed: e.findings,
      baseline: null,
      threshold: e.budget,
      confidence: 'exact' as const,
      source: 'live' as const,
      detected_at: Date.now(),
    })));
    return `${exceeded.length} rule-week(s) over budget`;
  });

  const ms = Date.now() - started;
  console.log(
    `[${new Date().toISOString()}] parsed ${fmt(totalFound)} events, ` +
      `${fmt(totalInserted)} new · ${fmt(anomalies.length)} anomalies detected, ` +
      `${fmt(newAnomalies.length)} new${escalatedAnomalies.length ? `, ${fmt(escalatedAnomalies.length)} escalated` : ''} (${ms}ms)`,
  );

  if (notify) {
    const cutoff = Date.now() - NOTIFY_WINDOW_MS;
    // Inserted always notifies; an escalation (a severity that ROSE on a window
    // the user was already told about) is the only update that re-notifies —
    // a merely growing window must not page anyone twice.
    for (const a of newAnomalies) {
      if (a.source === 'live' && a.severity !== 'info' && a.window_end >= cutoff) desktopNotify(a);
    }
    for (const a of escalatedAnomalies) {
      if (a.source === 'live' && a.severity !== 'info' && a.window_end >= cutoff) desktopNotify(a, true);
    }
  }

  if (verbose) {
    printSummary();
    printIncidents();
  }
}

/** The bind-time command ledgers: derived from the raw command, never stored. */
function deriveCommandLedgers(calls: import('../toolcalls/bind').ToolCallRow[]): void {
  let writes = 0, reads = 0, grantsN = 0, pkgs = 0, targets = 0, ingress = 0;
  for (const tc of calls) {
    // The args channel (structured Edit/Write/apply_patch, or the command
    // string): the raw arguments object, never stored. Empty means nothing
    // to derive — 'no write recorded', not zero.
    const args = tc.args ?? tc.command;
    const ctx = {
      tool_call_key: tc.tool_call_key,
      session_id: tc.session_id ?? null,
      ts: tc.ts,
      cwd: tc.cwd ?? null,
    };
    if (args !== undefined && args !== null && args !== '') {
      writes += insertFileWrites(db, fileWritesForCall(tc.name, args, ctx));
    }
    if (!tc.command) continue;
    reads += insertSecretStoreReads(db, secretStoreReads(tc.command, tc.tool_call_key, tc.ts ?? null));
    grantsN += insertGrantDeposits(db, grantDeposits(tc.command, tc.tool_call_key, tc.ts ?? null));
    pkgs += insertPackageExecs(db, packageExecs(tc.command, tc.tool_call_key, tc.ts ?? null));
    targets += insertActionTargets(db, actionTargetsForCommand(tc.command, {
      call_key: tc.tool_call_key,
    }));
    const ing = parseFetchIngress(tc.tool_call_key, tc.command, tc.ts ?? null);
    if (ing) { insertFetchIngress(db, [ing]); ingress++; }
  }
  if (verbose && (writes + reads + grantsN + pkgs + targets + ingress) > 0) {
    console.log(
      `  [ledgers] writes ${writes}, store-reads ${reads}, grants ${grantsN}, packages ${pkgs}, targets ${targets}, ingress ${ingress}`,
    );
  }
}

/** Budget verdicts (tier 8): one anomaly per declared budget, every pass. */
function budgetAnomalies(now: number): Anomaly[] {
  const read = (p: string): string | null => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };
  const decls = loadBudgets(read, paths.budgetPaths());
  if (!decls.length) return [];
  const rows = db
    .prepare(`SELECT tool, model, project, user, cost_usd, cost_basis, total_tokens, confidence
              FROM usage_events WHERE source = 'live' AND ts > ?`)
    .all(now - 30 * 24 * 3600_000) as {
      tool: string; model: string | null; project: string | null; user: string | null;
      cost_usd: number | null; cost_basis: string | null; total_tokens: number | null; confidence: string;
    }[];
  const out: Anomaly[] = [];
  for (const decl of decls) {
    const r = evaluateBudget(decl, rows, now - 30 * 24 * 3600_000);
    if (r.verdict === 'ok') continue;
    out.push({
      anomaly_key: `budget_${r.verdict}:${decl.scope.project ?? decl.scope.tool ?? 'all'}:${isoWeek(now)}`,
      rule: r.verdict === 'exceeded' ? 'budget_exceeded' : 'budget_indeterminate',
      severity: r.verdict === 'exceeded' ? 'warn' : 'info',
      tool: 'vole',
      session_id: null,
      model: null,
      window_start: now - 30 * 24 * 3600_000,
      window_end: now,
      title: `Budget ${r.verdict}: ${decl.scope.project ?? decl.scope.tool ?? 'all work'}`,
      detail:
        r.verdict === 'exceeded'
          ? `Spent $${(r.spent_usd ?? 0).toFixed(2)} of the declared $${decl.limit_usd} limit on basis ${decl.cost_basis}.`
          : `The verdict cannot be computed: ${r.unpriced_calls} unpriced call(s) sit in scope — an em dash, never a guessed number.`,
      observed: r.spent_usd ?? r.spent_tokens ?? 0,
      baseline: null,
      threshold: decl.limit_usd ?? decl.limit_tokens ?? null,
      confidence: 'exact',
      source: 'live',
      detected_at: now,
    });
  }
  return out;
}

/** Enqueue the pass's new rows into every sink's outbox (local rows only). */
function enqueueNewRows(newAnomalies: Anomaly[], recentEvents: UsageEvent[]): void {
  try {
    for (const sink of Object.keys(SINKS)) {
      const docs = [
        ...newAnomalies.map((a) => ({
          doc_id: `vole.incident.v1|${a.anomaly_key}|${a.tool}`,
          payload: JSON.stringify(encodeShapeRow('vole.incident.v1', a as unknown as Record<string, unknown>, encodeCtx).wire),
        })),
        ...recentEvents.map((e) => ({
          doc_id: `vole.event.v1|${e.event_key}|${e.tool}`,
          payload: JSON.stringify(encodeShapeRow('vole.event.v1', e as unknown as Record<string, unknown>, encodeCtx).wire),
        })),
      ];
      if (docs.length) enqueueOutbox(db, sink, docs);
    }
  } catch {
    /* the outbox must never take the collector down; --drain reports the state */
  }
}

interface SummaryRow {
  tool: Tool;
  model: string | null;
  confidence: string;
  calls: number;
  tokens: number | null;
  cost: number | null;
}

function printSummary(): void {
  const rows = db
    .prepare(
      `SELECT tool, model, confidence,
              COUNT(*)          AS calls,
              SUM(total_tokens) AS tokens,
              SUM(cost_usd)     AS cost
       FROM usage_events
       WHERE source = 'live'
       GROUP BY tool, model, confidence
       ORDER BY tool, calls DESC`,
    )
    .all() as SummaryRow[];

  console.log('\n  ── stored usage (live data only) ──');
  console.log(
    `  ${'tool'.padEnd(12)} ${'model'.padEnd(22)} ${'confidence'.padEnd(14)} ` +
      `${'calls'.padStart(6)} ${'tokens'.padStart(14)} ${'equiv. cost'.padStart(12)}`,
  );

  for (const r of rows) {
    console.log(
      `  ${r.tool.padEnd(12)} ${(r.model ?? '—').padEnd(22)} ${r.confidence.padEnd(14)} ` +
        `${String(r.calls).padStart(6)} ${(r.tokens === null ? '—' : fmt(r.tokens)).padStart(14)} ` +
        `${usd(r.cost).padStart(12)}`,
    );
  }

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS calls, SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost
       FROM usage_events WHERE source = 'live'`,
    )
    .get() as { calls: number; tokens: number | null; cost: number | null };

  console.log(
    `  ${'TOTAL'.padEnd(50)} ${String(totals.calls).padStart(6)} ` +
      `${fmt(totals.tokens ?? 0).padStart(14)} ${usd(totals.cost).padStart(12)}`,
  );
  console.log('  equivalent API value at list price — not billed on a subscription plan\n');
}

/**
 * Native desktop notification, best effort: `notify-send` on Linux, silently nothing
 * elsewhere. On macOS the Vole app posts these itself (it polls the same database) —
 * `osascript display notification` has no icon parameter and always shows Script
 * Editor's, never Vole's.
 */
function desktopNotify(a: Anomaly, escalated = false): void {
  const title = `Vole · ${a.severity.toUpperCase()}${escalated ? ' (escalated)' : ''}`;
  const body = a.title;
  const argv = process.platform === 'linux' ? ['notify-send', '-a', 'Vole', title, body] : null;
  if (!argv) return;
  try {
    spawn(argv[0]!, argv.slice(1), { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* no notifier available */
  }
}

console.log(`Vole collector → ${paths.db()}`);

// Supervision pidfile (#12): the app's spawner reads this to avoid starting a
// second embedded collector over a live one. Advisory only — a SIGKILLed process
// leaves a stale file, which is why the reader verifies the recorded executable
// path against the pid, never the file's mere existence. Written before the first
// pass so a crash mid-start still leaves the fact of the attempt.
try {
  writeFileSync(
    join(dirname(paths.db()), 'collector.pid'),
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), exe: process.execPath, argv: process.argv[1] ?? null }),
  );
} catch {
  /* unwritable store dir — the app spawner falls back to spawning */
}

const repriced = repriceUnpriced(db);
if (repriced > 0) console.log(`priced ${fmt(repriced)} stored rows whose model now has a rate`);

// The OTLP loopback receiver (tier 8): opt-in, local-only, and its reconciliation
// (parser fidelity) runs each pass while it is up.
let loopback: import('../export/loopback').LoopbackHandle | null = null;
if (otelListen) {
  import('../export/loopback').then(({ startLoopback, reconcileTelemetry }) => {
    startLoopback(db).then((h) => {
      loopback = h;
      console.log(`OTLP loopback listening on ${h.port}`);
    }).catch((err) => console.error(`loopback failed: ${(err as Error).message}`));
    setInterval(() => {
      try {
        const anomalies = reconcileTelemetry(db);
        if (anomalies.length) insertAnomalies(db, anomalies);
      } catch {
        /* one bad reconciliation must not stop polling */
      }
    }, 60_000);
  });
}

// The first pass must be guarded exactly like the polling passes: an unreadable
// store or a locked file on startup otherwise exits the process before polling
// ever begins, and the monitor is silently down.
try {
  runOnce();
} catch (err) {
  console.error(`[${new Date().toISOString()}] first pass failed: ${(err as Error).message}`);
}

if (!once) {
  console.log(`polling every ${intervalMs / 1000}s (ctrl-c to stop)${notify ? '' : ' · notifications off'}`);
  setInterval(() => {
    // One bad pass (locked file, disk hiccup) must not take the monitor down.
    try {
      runOnce();
    } catch (err) {
      console.error(`[${new Date().toISOString()}] pass failed: ${(err as Error).message}`);
    }
  }, intervalMs);
}

interface IncidentRow {
  rule: string;
  severity: string;
  tool: string;
  title: string;
  detail: string;
  confidence: string;
  window_start: number;
}

function printIncidents(): void {
  const rows = db
    .prepare(
      `SELECT rule, severity, tool, title, detail, confidence, window_start
       FROM anomalies ORDER BY window_start DESC LIMIT 8`,
    )
    .all() as IncidentRow[];

  const counts = db
    .prepare('SELECT rule, COUNT(*) AS n FROM anomalies GROUP BY rule ORDER BY n DESC')
    .all() as { rule: string; n: number }[];

  console.log('  ── incidents ──');
  if (counts.length === 0) {
    console.log('  none detected\n');
    return;
  }
  console.log(`  by rule: ${counts.map((c) => `${c.rule}=${c.n}`).join('  ')}`);
  console.log('  most recent:');
  for (const r of rows) {
    const when = new Date(r.window_start).toISOString().replace('T', ' ').slice(0, 16);
    console.log(`   [${r.severity.toUpperCase().padEnd(8)}] ${when}  ${r.title}`);
    console.log(`              ${r.detail}`);
  }
  console.log();
}
