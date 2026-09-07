import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from '../paths';
import type { Scanner } from '../db';
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
import { dlpScanner } from '../dlp/scanner';

export const SCANNERS: Scanner[] = [collectorHealthScanner, aiSurfacesScanner, tier2ExtrasScanner, dlpScanner];
