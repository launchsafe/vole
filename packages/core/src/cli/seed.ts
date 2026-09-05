/**
 * Demo data generator.
 *
 * Hard rule: this writes ONLY `source='seed'` rows, and the collectors write ONLY
 * `source='live'`. Nothing here can contaminate real collected data, and
 * `--purge` removes every trace with a single DELETE.
 *
 * Real logs on this machine are sparse (a handful of active days) and never trigger the
 * error-storm or rate-limit rules, so a demo on live data alone shows an empty incident
 * feed. The seed deliberately exercises all four rules.
 */
import { openDb, insertEvents, insertAnomalies, purgeSeed } from '../db';
import { detectBySource } from '../detect';
import { computeCost } from '../pricing';
import type { Anomaly, RateLimitObservation, Tool, UsageEvent } from '../types';

const purge = process.argv.includes('--purge');
const db = openDb();

if (purge) {
  const { events, anomalies } = purgeSeed(db);
  const remaining = db
    .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE source='seed'")
    .get() as { n: number };
  console.log(`Removed ${events} seeded events and ${anomalies} seeded incidents.`);
  console.log(`Seed rows remaining: ${remaining.n} (expect 0). Live data untouched.`);
  process.exit(0);
}

/** Deterministic PRNG so re-seeding produces identical keys and stays idempotent. */
let state = 1337;
function rnd(): number {
  state = (state * 1664525 + 1013904223) % 4294967296;
  return state / 4294967296;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)] as T;
}

const DAY = 86_400_000;
const NOW = Date.now();
const START = NOW - 30 * DAY;

const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8'];
const events: UsageEvent[] = [];
let seq = 0;

function push(over: Partial<UsageEvent> & { tool: Tool; ts: number }): void {
  const input = over.input_tokens ?? Math.floor(rnd() * 400);
  const output = over.output_tokens ?? Math.floor(200 + rnd() * 2400);
  const w5 = over.cache_write_5m_tokens ?? Math.floor(rnd() * 30_000);
  const w1 = over.cache_write_1h_tokens ?? 0;
  const read = over.cache_read_tokens ?? Math.floor(rnd() * 180_000);
  const model = over.model !== undefined ? over.model : pick(MODELS);
  const tokens = {
    input_tokens: input, output_tokens: output,
    cache_write_5m_tokens: w5, cache_write_1h_tokens: w1, cache_read_tokens: read,
  };

  events.push({
    event_key: `seed:${over.tool}:${seq++}`,
    tool: over.tool,
    model,
    session_id: over.session_id ?? `seed-${over.tool}-${Math.floor(rnd() * 6)}`,
    project: over.project ?? '/Users/demo/projects/checkout-service',
    git_branch: 'main',
    ts: over.ts,
    ...tokens,
    reasoning_tokens: 0,
    total_tokens: input + output + w5 + w1 + read,
    cost_usd: computeCost(model, tokens),
    confidence: over.confidence ?? 'exact',
    is_error: over.is_error ?? 0,
    stop_reason: over.stop_reason ?? 'tool_use',
    source: 'seed',
    raw_ref: null,
    tools: null,
    agent_id: null,
    context_window: null,
    ...(over.confidence === 'activity_only'
      ? {
          input_tokens: null, output_tokens: null, cache_write_5m_tokens: null,
          cache_write_1h_tokens: null, cache_read_tokens: null,
          total_tokens: null, cost_usd: null, reasoning_tokens: null,
        }
      : {}),
  } as UsageEvent);
}

// ── Baseline: 30 days of ordinary weekday-weighted activity ──────────────────
for (let d = 0; d < 30; d++) {
  const dayStart = START + d * DAY;
  const weekday = new Date(dayStart).getUTCDay();
  const busy = weekday >= 1 && weekday <= 5;
  const calls = busy ? 25 + Math.floor(rnd() * 45) : 4 + Math.floor(rnd() * 12);

  for (let i = 0; i < calls; i++) {
    // Cluster into working hours so the daily shape looks human.
    const hour = 9 + Math.floor(rnd() * 10);
    const ts = dayStart + hour * 3600_000 + Math.floor(rnd() * 3600_000);
    push({ tool: 'claude_code', ts });
  }
  for (let i = 0; i < Math.floor(calls * 0.35); i++) {
    const ts = dayStart + (10 + Math.floor(rnd() * 8)) * 3600_000 + Math.floor(rnd() * 3600_000);
    push({ tool: 'codex', ts, model: 'gpt-5.1-codex-max' });
  }
  if (busy && rnd() > 0.5) {
    push({
      tool: 'cursor', ts: dayStart + 14 * 3600_000, model: 'composer-2-fast',
      confidence: 'activity_only',
    });
  }
  if (rnd() > 0.8) {
    // Antigravity records no token data locally — activity only (push() nulls tokens).
    push({ tool: 'antigravity', ts: dayStart + 16 * 3600_000, model: null, confidence: 'activity_only' });
  }
}

// ── Rule 1: token burn spike (3 days ago) ────────────────────────────────────
{
  const t = NOW - 3 * DAY + 11 * 3600_000;
  for (let i = 0; i < 40; i++) {
    push({
      tool: 'claude_code', ts: t + i * 12_000, model: 'claude-opus-5',
      session_id: 'seed-refactor-sweep',
      output_tokens: 3000 + Math.floor(rnd() * 2000),
      cache_read_tokens: 220_000 + Math.floor(rnd() * 80_000),
      cache_write_5m_tokens: 40_000,
    });
  }
}

// ── Rule 2: runaway loop (2 days ago) — many calls, flat output, heavy re-reads ─
{
  const t = NOW - 2 * DAY + 15 * 3600_000;
  for (let i = 0; i < 12; i++) {
    push({ tool: 'claude_code', ts: t - 25 * 60_000 + i * 90_000,
           session_id: 'seed-stuck-agent', output_tokens: 900 });
  }
  for (let i = 0; i < 48; i++) {
    push({
      tool: 'claude_code', ts: t + i * 5_500, model: 'claude-opus-5',
      session_id: 'seed-stuck-agent',
      output_tokens: 60 + Math.floor(rnd() * 60),   // barely producing anything
      cache_read_tokens: 90_000,                     // re-reading the same context
      cache_write_5m_tokens: 0, input_tokens: 2,
    });
  }
}

// ── Rule 3: retry storm (yesterday) ──────────────────────────────────────────
{
  const t = NOW - 1 * DAY + 10 * 3600_000;
  for (let i = 0; i < 8; i++) {
    push({ tool: 'claude_code', ts: t + i * 40_000, session_id: 'seed-flaky-tool' });
  }
  for (let i = 0; i < 14; i++) {
    push({
      tool: 'claude_code', ts: t + i * 45_000, session_id: 'seed-flaky-tool',
      is_error: 1, output_tokens: 40, stop_reason: 'error',
    });
  }
}

// ── Rule 4: rate-limit pressure (Codex reports its own quota) ────────────────
const seedRateLimits: RateLimitObservation[] = [
  { tool: 'codex', session_id: 'seed-codex-heavy', ts: NOW - 4 * 3600_000,
    used_percent: 87, window_minutes: 300 },
  { tool: 'codex', session_id: 'seed-codex-heavy', ts: NOW - 90 * 60_000,
    used_percent: 96, window_minutes: 300 },
];

const inserted = insertEvents(db, events);

// Run the real detectors over the real seeded rows, then stamp the results as seed —
// the incidents are genuinely derived, not hand-written.
const all = db.prepare('SELECT * FROM usage_events ORDER BY ts').all() as UsageEvent[];
// Detection is partitioned by source, so seeded rows get their own baselines and are
// tagged 'seed' by construction — no key-substring guessing.
const detected = detectBySource(all, { seed: seedRateLimits }, NOW);
const seedAnomalies: Anomaly[] = detected.filter((a) => a.source === 'seed');
const insertedAnomalies = insertAnomalies(db, seedAnomalies).length;

console.log(`Seeded ${inserted} demo events (source='seed') across 30 days.`);
console.log(`Detected ${insertedAnomalies} demo incidents using the real rules.`);
console.log("Remove at any time with: pnpm seed:purge");
