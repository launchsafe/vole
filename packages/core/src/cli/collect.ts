import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  openDb, insertEvents, insertAnomalies, repriceUnpriced, recordCollectorRun,
  recordScan, boundNote, drainInbox, pruneRetiredCollectorRuns,
} from '../db';
import { collectAll, COLLECTOR_REGISTRY } from '../collectors';
import { detectBySource, RULE_IDS } from '../detect';
import { paths } from '../paths';
import type { Anomaly, RateLimitObservation, Tool, UsageEvent } from '../types';

const args = process.argv.slice(2);
const once = args.includes('--once');
const verbose = args.includes('--verbose');
const notify = !args.includes('--no-notify');
const intervalArg = args.find((a) => a.startsWith('--interval='));
// A bad value must not silently become a spin loop: Number('abc') is NaN, and a
// NaN delay is clamped to 1ms by the timer, so `--interval=5s` would poll a
// thousand times a second instead of every five.
const intervalSec = intervalArg ? Number(intervalArg.split('=')[1]) : 5;
if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
  console.error(`--interval must be a positive number of seconds, got "${intervalArg?.split('=')[1]}"`);
  process.exit(2);
}
const intervalMs = intervalSec * 1000;

/** Only incidents this fresh get a desktop notification; a first scan over months of history must not. */
const NOTIFY_WINDOW_MS = 15 * 60_000;

/**
 * The trailing-window bound for the pure rules:
 * detection used to SELECT the whole usage_events table every gated pass.
 * 120 days covers every rule's baseline window; the insert gate means a pass
 * that stored nothing new skips the scan entirely.
 * ponytail: fixed 120d window; make it rule-specific if a rule ever needs deeper history.
 */
const DETECT_WINDOW_MS = 120 * 24 * 3600_000;

const db = openDb();

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function usd(n: number | null): string {
  return n === null ? '—' : `$${n.toFixed(2)}`;
}

function runOnce(): void {
  const started = Date.now();
  // Writes from the app arrive as spool files; drain them first so the
  // ledger reflects user intent before this pass's rows land.
  const applied = drainInbox(db);
  if (applied > 0 && verbose) console.log(`  [inbox] applied ${applied} action(s)`);
  const results = collectAll(db);

  let totalFound = 0;
  let totalInserted = 0;
  const rateLimits: RateLimitObservation[] = [];

  for (const r of results) {
    if (r.rateLimits) rateLimits.push(...r.rateLimits);
    const inserted = insertEvents(db, r.events);
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

    // Rows from collectors this build no longer ships can never be reached by the
    // per-tool trim in recordCollectorRun, so sweep them with the live registry.
    pruneRetiredCollectorRuns(db, COLLECTOR_REGISTRY.map((c) => c.tool));

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

  // Rules need full history to establish a baseline, so they run over the
  // trailing window, not just this poll's new rows. Stable anomaly_keys keep
  // re-runs idempotent. The pass is insert-gated: rules are pure functions of
  // stored rows (plus live rate-limit observations), so a poll that stored
  // nothing new cannot produce a new anomaly — and the full-table scan that
  // detection costs is skipped entirely. ONE exception: a rule EPOCH. When
  // the rule registry itself changes (a new rule ships), it must see the
  // historical rows once, or it would silently wait for the next insert.
  const rulesEpoch = RULE_IDS.join(',');
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
  if (totalInserted > 0 || rateLimits.length > 0 || epochChanged) {
    const now = Date.now();
    const all = db
      .prepare('SELECT * FROM usage_events WHERE ts > ? ORDER BY ts')
      .all(now - DETECT_WINDOW_MS) as UsageEvent[];
    anomalies = detectBySource(all, { live: rateLimits }, now);
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
  // Live rows only. The stored-usage table above says "(live data only)" and this
  // list did not filter at all, so a seeded demo store printed synthetic incidents
  // in the same shape as real ones with nothing marking them apart.
  const rows = db
    .prepare(
      `SELECT rule, severity, tool, title, detail, confidence, window_start
       FROM anomalies WHERE source = 'live' ORDER BY window_start DESC LIMIT 8`,
    )
    .all() as IncidentRow[];

  const counts = db
    .prepare("SELECT rule, COUNT(*) AS n FROM anomalies WHERE source = 'live' GROUP BY rule ORDER BY n DESC")
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
