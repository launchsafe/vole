import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from '../paths';
import type { DB, Scanner } from '../db';
import { openDb } from '../db';
import { aiSurfacesScanner } from './ai-surfaces';

export { aiSurfacesScanner, scanAiSurfaces } from './ai-surfaces';

/**
 * The lane's first resident: collector process health. Reads the pidfile the
 * collector itself writes, verifies the recorded pid, and reports a second live
 * collector when one exists — the exact condition that measured 1.1 GB of
 * duplicated orphaned collectors on a real machine, invisibly.
 *
 * Cadence 30s, not 5s: nothing about process topology changes in five seconds,
 * and this is the cheap proof that the scanner lane gates cost by cadence.
 */
export const collectorHealthScanner: Scanner = {
  name: 'collector-health',
  cadenceMs: 30_000,
  run: () => {
    const file = join(dirname(paths.db()), 'collector.pid');
    if (!existsSync(file)) {
      return { ok: true, notes: 'no pidfile — collector not started under supervision' };
    }
    let pid: number;
    let exe: string;
    try {
      const info = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; exe: string };
      pid = info.pid;
      exe = info.exe;
    } catch {
      return { ok: false, notes: 'pidfile present but unreadable' };
    }
    if (pid === process.pid) {
      return { ok: true, notes: `self (pid ${pid})` };
    }
    // Not us. A live pid here is another collector feeding the same store —
    // tolerated (busy_timeout), but wasteful, and now at least visible.
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      /* dead pid: stale pidfile */
    }
    return alive
      ? { ok: true, notes: `another collector is live (pid ${pid}, exe ${exe}) — tolerated, wasteful if unintended` }
      : { ok: true, notes: `stale pidfile (pid ${pid} is dead)` };
  },
};

import { tier2ExtrasScanner } from './tier2-extras';
import { postureScanner } from './posture-deep';
import { dlpScanner } from '../dlp/scanner';
import { homesScanner } from './homes';
import { routesScanner } from './routes';
import { contextsScanner } from './contexts';
import { vscodeStateScanner } from './vscode-state';
import { deletedSessionsScanner } from './deleted-sessions';
import { osIntelligenceScanner } from './os-intelligence';
import { scanAccessScanner } from './scan-access';
import { coverageScanner } from './coverage';
import { browserGrantsScanner } from './browser-grants';
import { aiHostsScanner } from './ai-hosts';
import { depsScanner } from './deps';
import { editorCensusScanner } from './editor-census';
import { editorStoresScanner } from './editor-stores';
import { shellHistoryScanner } from '../governance/shell-history';
import { runStructuredSinks } from '../dlp/structured-sinks';
import { collectPayloadSightings } from '../payloads';
import { collectContextImports } from '../chains/imports';
import { collectKeyResidency, collectResidencyEvidence, collectAnswerableFrom } from '../chains/residency';
import { collectTermsChain } from '../chains/terms';
import { emitNetLedgers } from '../toolcalls/net-ledgers';
import { measureStoreBudget } from '../privacy/store-budget';

/** The shell-history scanner takes a store handle; the lane's Scanner shape does not. */
export const shellHistoryLaneScanner: Scanner = {
  name: 'shell-history',
  cadenceMs: shellHistoryScanner.cadenceMs,
  run: () => {
    const db = openDb();
    const rs = shellHistoryScanner.run(db);
    const first = rs[0];
    return { ok: first?.ok ?? true, notes: first?.notes };
  },
};

/**
 * The structured-sinks lane (tier 4 deep + chains): every collector that is a
 * structured store rather than a byte stream, plus the cross-vendor chain
 * readers. All idempotent and safe to overlap a poll; 10-minute cadence like
 * the dlp-scan it complements.
 */
export const structuredSinksLaneScanner: Scanner = {
  name: 'structured-sinks',
  cadenceMs: 10 * 60_000,
  run: () => {
    const db = openDb();
    const out = runStructuredSinks(db);
    const roots = (db
      .prepare('SELECT root_path FROM work_roots WHERE COALESCE(exists_now, 1) = 1')
      .all() as { root_path: string }[]).map((r) => r.root_path);
    collectPayloadSightings(db, roots);
    collectContextImports(db);
    collectKeyResidency(db, roots);
    collectAnswerableFrom(db);
    collectResidencyEvidence(db);
    collectTermsChain(db);
    return { ok: out.ok, notes: out.notes.join(' | ') };
  },
};

/** Net ledgers are derived from stored tool-call shapes — no disk reads at all. */
export const netLedgersScanner: Scanner = {
  name: 'net-ledgers',
  cadenceMs: 10 * 60_000,
  run: () => {
    const r = emitNetLedgers(openDb());
    return {
      ok: true,
      notes: `context_edges ${r.context_edges}, vcs_actions ${r.vcs_actions}, package_execs ${r.package_execs}, remote_exec ${r.remote_exec}`,
    };
  },
};

/** store_budget refresh: never in the 5-second loop — it walks dbstat. */
export const storeBudgetScanner: Scanner = {
  name: 'store-budget',
  cadenceMs: 60 * 60_000,
  run: () => {
    const r = measureStoreBudget(openDb());
    return {
      ok: true,
      notes: `${r.rows.length} object(s) measured${r.dbstat ? '' : ' (dbstat unavailable: page facts estimated)'}`,
    };
  },
};

export const SCANNERS: Scanner[] = [
  collectorHealthScanner,
  aiSurfacesScanner,
  tier2ExtrasScanner,
  dlpScanner,
  postureScanner,
  homesScanner,
  routesScanner,
  contextsScanner,
  vscodeStateScanner,
  deletedSessionsScanner,
  osIntelligenceScanner,
  scanAccessScanner,
  coverageScanner,
  browserGrantsScanner,
  aiHostsScanner,
  depsScanner,
  editorCensusScanner,
  editorStoresScanner,
  structuredSinksLaneScanner,
  netLedgersScanner,
  storeBudgetScanner,
  shellHistoryLaneScanner,
];
