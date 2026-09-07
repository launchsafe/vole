import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  openDb, insertEvents, insertAnomalies, repriceUnpriced, recordCollectorRun,
  scanDue, recordScan, drainInbox,
} from '../db';
import { collectAll } from '../collectors';
import { detectBySource, RULE_IDS } from '../detect';
import { detectLedgerRules } from '../detect/behaviour';
import { SCANNERS } from '../scanners';
import { insertToolCalls } from '../toolcalls/bind';
import { paths } from '../paths';
import type { Anomaly, RateLimitObservation, Tool, UsageEvent } from '../types';

const args = process.argv.slice(2);
const once = args.includes('--once');
const verbose = args.includes('--verbose');
const notify = !args.includes('--no-notify');
const intervalArg = args.find((a) => a.startsWith('--interval='));
const intervalMs = intervalArg ? Number(intervalArg.split('=')[1]) * 1000 : 5000;

/** Only incidents this fresh get a desktop notification; a first scan over months of history must not. */
const NOTIFY_WINDOW_MS = 15 * 60_000;

const db = openDb();

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function usd(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(2)}`;
}

function runOnce(): void {
  const started = Date.now();
  // Triage writes from the app arrive as spool files; drain them first so the
  // disposition ledger reflects user intent before this pass's rows land.
  const applied = drainInbox(db);
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
    if (r.toolCalls?.length) ledgerInserted += insertToolCalls(db, r.toolCalls);
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

  // Rules need full history to establish a baseline, so they run over everything
  // stored, not just this poll's new rows. Stable anomaly_keys keep re-runs idempotent.
  // The pass is insert-gated: rules are pure functions of stored rows (plus live
  // rate-limit observations), so a poll that stored nothing new cannot produce a
  // new anomaly — and the full-table scan that detection costs is skipped entirely.
  // ONE exception: a rule EPOCH. When the rule registry itself changes (a new
  // rule ships), it must see the historical rows once, or it would silently wait
  // for the next insert — the rerouted-model rule would have missed 2,540
  // existing rows on the machine it was written for.
  const rulesEpoch = RULE_IDS.join(',');
  const lastEpoch = db
    .prepare("SELECT notes FROM scan_state WHERE scanner = 'detection-rules'")
    .get() as { notes: string | null } | undefined;
  const epochChanged = lastEpoch?.notes !== rulesEpoch;
  let anomalies: Anomaly[] = [];
  let newAnomalies: Anomaly[] = [];
  let escalatedAnomalies: Anomaly[] = [];
  if (totalInserted > 0 || rateLimits.length > 0 || epochChanged || ledgerInserted > 0) {
    const all = db
      .prepare('SELECT * FROM usage_events ORDER BY ts')
      .all() as UsageEvent[];
    anomalies = detectBySource(all, { live: rateLimits }, Date.now());
    // The ledger rules read the store directly — they run in the same pass.
    anomalies.push(...detectLedgerRules(db, Date.now()));
    const written = insertAnomalies(db, anomalies);
    newAnomalies = written.inserted;
    escalatedAnomalies = written.escalated;
    if (epochChanged) {
      recordScan(db, 'detection-rules', 0, Date.now(), 0, true, rulesEpoch);
    }
  }

  const ms = Date.now() - started;
  console.log(
    `[${new Date().toISOString()}] parsed ${fmt(totalFound)} events, ` +
      `${fmt(totalInserted)} new · ${fmt(anomalies.length)} anomalies detected, ` +
      `${fmt(newAnomalies.length)} new${escalatedAnomalies.length ? `, ${fmt(escalatedAnomalies.length)} escalated` : ''} (${ms}ms)`,
  );

  // The scanner lane: gated by each scanner's own cadence, never the poll's.
  // A check is one indexed read; a body runs at most once per cadence_ms.
  for (const s of SCANNERS) {
    if (!scanDue(db, s.name, s.cadenceMs)) continue;
    const t0 = Date.now();
    let ok = false;
    let notes: string | null = null;
    try {
      const r = s.run();
      ok = r.ok;
      notes = r.notes ?? null;
    } catch (err) {
      ok = false;
      notes = `scanner failed: ${(err as Error).message}`;
    }
    recordScan(db, s.name, s.cadenceMs, t0, Date.now() - t0, ok, notes);
    if (verbose && notes) console.log(`  [scan] ${s.name}: ${notes}`);
  }

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
