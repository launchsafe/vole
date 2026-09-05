import { spawn } from 'node:child_process';
import { openDb, insertEvents, insertAnomalies, repriceUnpriced } from '../db';
import { collectAll } from '../collectors';
import { detectBySource } from '../detect';
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

    if (verbose) {
      const dupes = r.events.length - inserted;
      console.log(
        `  ${r.tool.padEnd(12)} files=${String(r.filesScanned).padStart(3)}  ` +
          `parsed=${String(r.events.length).padStart(5)}  new=${String(inserted).padStart(5)}  ` +
          `dedup-skipped=${String(dupes).padStart(5)}`,
      );
      for (const note of r.notes) console.log(`      note: ${note}`);
    }
  }

  // Rules need full history to establish a baseline, so they run over everything
  // stored, not just this poll's new rows. Stable anomaly_keys keep re-runs idempotent.
  const all = db
    .prepare('SELECT * FROM usage_events ORDER BY ts')
    .all() as UsageEvent[];
  const anomalies = detectBySource(all, { live: rateLimits }, Date.now());
  const newAnomalies = insertAnomalies(db, anomalies);

  const ms = Date.now() - started;
  console.log(
    `[${new Date().toISOString()}] parsed ${fmt(totalFound)} events, ` +
      `${fmt(totalInserted)} new · ${fmt(anomalies.length)} anomalies detected, ` +
      `${fmt(newAnomalies.length)} new (${ms}ms)`,
  );

  if (notify) {
    const cutoff = Date.now() - NOTIFY_WINDOW_MS;
    for (const a of newAnomalies) {
      if (a.source === 'live' && a.severity !== 'info' && a.window_end >= cutoff) desktopNotify(a);
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
function desktopNotify(a: Anomaly): void {
  const title = `Vole · ${a.severity.toUpperCase()}`;
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
const repriced = repriceUnpriced(db);
if (repriced > 0) console.log(`priced ${fmt(repriced)} stored rows whose model now has a rate`);
runOnce();

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
