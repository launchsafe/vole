/**
 * Tier 7 clocks: boot-anchored wall time and the collector's measured
 * footprint. Two problems live here.
 *
 * 1. CLOCK SANITY — `Date.now()` is user-settable; a laptop woken from a
 *    flight can be hours off. But `boot_epoch = floor(now_s) - os.uptime()`
 *    is anchored to the boot moment: within one boot the derived boot epoch
 *    is CONSTANT, so a wall-clock change moves it. A boot_epoch shift while
 *    uptime keeps increasing is the exact shift in seconds; wall_ms going
 *    backwards between consecutive runs is a rollback. (Verified against
 *    sysctl kern.boottime on macOS — no subprocess, no network, SEA-safe.)
 *
 * 2. THE FOOTPRINT BUDGET — collector_runs carries rss_peak_bytes /
 *    cpu_user_ms / cpu_sys_ms / exit_status, but nothing measured them. The
 *    budget names its metric: resident set size in bytes from
 *    process.memoryUsage().rss, CPU from process.cpuUsage() deltas. The
 *    collect.ts write of these values is the coordinated integration step;
 *    this module is the measurement.
 *
 * Limit (spec): a reboot resets uptime, so a clock change made while the
 * machine was powered off is invisible; shifts smaller than the poll
 * interval are lost.
 */
import { uptime } from 'node:os';

/** The boot-anchored epoch in whole seconds: floor(now/1000) - uptime(). */
export function bootEpoch(nowMs: number = Date.now(), uptimeS: number = uptime()): number {
  return Math.floor(nowMs / 1000) - Math.floor(uptimeS);
}

export interface RunClockStamp {
  /** Wall clock at stamp time, epoch-ms. */
  wall_ms: number;
  /** Boot-anchored epoch, whole seconds; NULL when the OS refuses uptime(). */
  boot_epoch: number | null;
  /** Resident set size, bytes — process.memoryUsage().rss. */
  rss_peak_bytes: number;
  /** User CPU consumed by this process, ms (cpuUsage delta). */
  cpu_user_ms: number;
  /** System CPU consumed by this process, ms (cpuUsage delta). */
  cpu_sys_ms: number;
}

/**
 * The footprint the collector stamps on each run. "Peak" is honest within a
 * run only if sampled at run end — which is where collect.ts takes it — and
 * the budget says so (see footprintMetricName). A baseline cpuUsage of zero
 * is captured at module load so a collector importing this module measures
 * everything after import. An unreadable uptime (sandboxed uv_uptime) yields
 * boot_epoch NULL — unknown, never a guessed zero.
 */
const CPU_BASE = process.cpuUsage();

export function runClockStamp(nowMs: number = Date.now()): RunClockStamp {
  const cpu = process.cpuUsage(CPU_BASE);
  let boot_epoch: number | null;
  try {
    boot_epoch = bootEpoch(nowMs);
  } catch {
    boot_epoch = null;
  }
  return {
    wall_ms: nowMs,
    boot_epoch,
    rss_peak_bytes: process.memoryUsage().rss,
    cpu_user_ms: Math.round(cpu.user / 1000),
    cpu_sys_ms: Math.round(cpu.system / 1000),
  };
}

/** The budget's own sentence: WHICH metric, measured where, never a bare number. */
export function footprintMetricName(): string {
  return 'rss_peak_bytes = process.memoryUsage().rss at run end; cpu_user_ms/cpu_sys_ms = process.cpuUsage() deltas since process start';
}

// ── Clock suspicion, derived — never reordered, never stored as fact ─────────

export interface CollectorRunClock {
  id: number | null;
  started_at: number;
  wall_ms: number | null;
  boot_epoch: number | null;
}

export interface ClockSuspect {
  run_id: number | null;
  /** The run whose stamps disagreed with its predecessor's. */
  started_at: number;
  kind: 'boot_epoch_shift' | 'wall_rollback';
  /** Magnitude in seconds; for a rollback, how far back it went. */
  shift_s: number;
}

/**
 * Derives clock suspicion from consecutive collector_runs stamps, in arrival
 * order (started_at) — reordering nothing. Pure: the caller reads the rows.
 *
 *  - boot_epoch moving BETWEEN runs while uptime must have kept increasing
 *    means the wall clock moved under a running boot: the shift, in seconds.
 *  - wall_ms going backwards is a rollback, full stop.
 *
 * NULL stamps are skipped, never guessed: a run without a boot_epoch is
 * pre-migration history, not a zero shift.
 */
export function clockSuspects(runs: CollectorRunClock[]): ClockSuspect[] {
  const out: ClockSuspect[] = [];
  const stamped = runs
    .slice()
    .sort((a, b) => a.started_at - b.started_at)
    .filter((r) => r.boot_epoch !== null || r.wall_ms !== null);
  for (let i = 1; i < stamped.length; i++) {
    const prev = stamped[i - 1]!;
    const cur = stamped[i]!;
    if (prev.boot_epoch !== null && cur.boot_epoch !== null && prev.wall_ms !== null && cur.wall_ms !== null) {
      // The same boot keeps increasing uptime; uptime at a run is
      // wall_ms/1000 - boot_epoch. A reboot RESETS uptime, so a boot_epoch
      // change with uptime still climbing can only be the wall clock moving.
      const upPrev = prev.wall_ms / 1000 - prev.boot_epoch;
      const upCur = cur.wall_ms / 1000 - cur.boot_epoch;
      if (cur.boot_epoch !== prev.boot_epoch && upCur > upPrev) {
        out.push({
          run_id: cur.id,
          started_at: cur.started_at,
          kind: 'boot_epoch_shift',
          shift_s: cur.boot_epoch - prev.boot_epoch,
        });
      }
    }
    if (prev.wall_ms !== null && cur.wall_ms !== null && cur.wall_ms < prev.wall_ms) {
      out.push({
        run_id: cur.id,
        started_at: cur.started_at,
        kind: 'wall_rollback',
        shift_s: (cur.wall_ms - prev.wall_ms) / 1000,
      });
    }
  }
  return out;
}
