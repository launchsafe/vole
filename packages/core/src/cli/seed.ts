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
const storyArg = process.argv.find((a) => a.startsWith('--story='));
const db = openDb();

if (purge) {
  const { events, anomalies } = purgeSeed(db);
  // The enterprise story also touches tables with no source column; its rows
  // are all keyed under a seed- namespace, so the purge is exact.
  const storyTables: [string, string][] = [
    ['principals', "principal_key LIKE 'p:story-%'"],
    ['ai_surfaces', "surface_key = 'cli:grok'"],
    ['secret_sightings', "detector = 'seed-story-detector'"],
    ['tool_calls', "tool_call_key LIKE 'seed-story:%'"],
    ['session_identity', "session_id LIKE 'seed-story-%'"],
  ];
  let storyRows = 0;
  for (const [table, where] of storyTables) {
    storyRows += db.prepare(`DELETE FROM ${table} WHERE ${where}`).run().changes;
  }
  const remaining = db
    .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE source='seed'")
    .get() as { n: number };
  console.log(`Removed ${events} seeded events and ${anomalies} seeded incidents.`);
  if (storyRows > 0) console.log(`Removed ${storyRows} enterprise-story row(s) from ledgers without a source column.`);
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
      duration_ms: null, duration_kind: null,
    ...(over.confidence === 'activity_only'
      ? {
          input_tokens: null, output_tokens: null, cache_write_5m_tokens: null,
          cache_write_1h_tokens: null, cache_read_tokens: null,
          total_tokens: null, cost_usd: null, reasoning_tokens: null,
        }
      : {}),
  } as UsageEvent);
}

// ── the enterprise story (seed --story=enterprise) ─────────────────────────
//
// Twelve pseudonymous employees across three machines, an unsanctioned Grok
// CLI on two hosts, three secret findings at different lifecycle states, a
// bypassPermissions session with a destructive command, and a quota-exhausted
// day: enough to populate every screen. Every row is source='seed' — the
// firewall holds, every export path refuses these rows, and a demo can never
// become evidence.
if (storyArg === '--story=enterprise') {
  const now = Date.now();
  const DAY = 86_400_000;
  const START = now - 30 * DAY;
  const machines = ['seed-mac-1', 'seed-mac-2', 'seed-mac-3'];
  const storyEvents: UsageEvent[] = [];
  // insertEvents stamps the LOCAL user/machine (its ORIGIN spread wins), so the
  // story's employees carry theirs in a parallel list and get them back via a
  // seed-only UPDATE after insert.
  const storyOrigins: { event_key: string; user: string; machine: string }[] = [];
  let storySeq = 0;
  const storyPush = (over: Partial<UsageEvent> & { tool: Tool; ts: number; user: string; machine: string }): void => {
    const input = over.input_tokens ?? 100 + Math.floor(rnd() * 300);
    const output = over.output_tokens ?? 200 + Math.floor(rnd() * 2000);
    const w5 = over.cache_write_5m_tokens ?? Math.floor(rnd() * 20_000);
    const read = over.cache_read_tokens ?? Math.floor(rnd() * 120_000);
    const model = over.model !== undefined ? over.model : pick(MODELS);
    storyEvents.push({
      event_key: `seed-story:${over.tool}:${storySeq++}`,
      tool: over.tool, model,
      session_id: over.session_id ?? `seed-story-${over.user}`,
      project: over.project ?? '/Users/demo/projects/checkout-service',
      git_branch: 'main', ts: over.ts,
      input_tokens: input, output_tokens: output,
      cache_write_5m_tokens: w5, cache_write_1h_tokens: 0, cache_read_tokens: read,
      reasoning_tokens: 0, total_tokens: input + output + w5 + read,
      cost_usd: computeCost(model, { input_tokens: input, output_tokens: output, cache_write_5m_tokens: w5, cache_write_1h_tokens: 0, cache_read_tokens: read }),
      confidence: over.confidence ?? 'exact', is_error: over.is_error ?? 0,
      stop_reason: over.stop_reason ?? 'tool_use', source: 'seed',
      raw_ref: null, tools: null, agent_id: null, context_window: null,
      duration_ms: null, duration_kind: null,
    } as UsageEvent);
    storyOrigins.push({ event_key: storyEvents[storyEvents.length - 1]!.event_key, user: over.user, machine: over.machine });
  };

  for (let e = 1; e <= 12; e++) {
    const user = `seed-emp-${String(e).padStart(2, '0')}`;
    const machine = machines[e % 3]!;
    // Pseudonymous principals for the People view (HMAC-shaped keys, never names).
    db.prepare(
      `INSERT INTO principals (principal_key, display, first_seen, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT(principal_key) DO UPDATE SET last_seen = excluded.last_seen`,
    ).run(`p:story-${String(e).padStart(2, '0')}`, `user-${String(e).padStart(2, '0')}`, START, now);
    for (let d = 0; d < 30; d++) {
      const weekday = new Date(START + d * DAY).getUTCDay();
      if (!(weekday >= 1 && weekday <= 5)) continue;
      const calls = 8 + Math.floor(rnd() * 30);
      for (let i = 0; i < calls; i++) {
        storyPush({
          tool: 'claude_code', ts: START + d * DAY + (9 + Math.floor(rnd() * 9)) * 3600_000,
          user, machine, session_id: `seed-story-${user}`,
        });
      }
    }
  }
  // An unsanctioned Grok CLI on two hosts.
  for (const [user, machine] of [['seed-emp-04', 'seed-mac-1'], ['seed-emp-09', 'seed-mac-3']] as const) {
    for (let d = 0; d < 30; d += 2) {
      storyPush({
        tool: 'grok', ts: START + d * DAY + 15 * 3600_000, model: 'grok-4',
        user, machine, session_id: `seed-story-grok-${user}`,
      });
    }
  }
  // A quota-exhausted day (Codex at 97%).
  storyPush({ tool: 'codex', ts: now - 2 * DAY + 11 * 3600_000, model: 'gpt-5.1-codex-max', user: 'seed-emp-07', machine: 'seed-mac-2', session_id: 'seed-story-quota' });
  const inserted = insertEvents(db, storyEvents);
  const upd = db.prepare(`UPDATE usage_events SET user = ?, machine = ? WHERE event_key = ? AND source = 'seed'`);
  for (const o of storyOrigins) upd.run(o.user, o.machine, o.event_key);

  // The unsanctioned surface row (the policy join renders the chip).
  db.prepare(
    `INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, version, extra, sanctioned, first_seen, last_seen)
     VALUES ('cli:grok', 'cli', 'Grok CLI', '~/.grok', 'seed story: unsanctioned on two hosts', NULL, NULL, 0, ?, ?)
     ON CONFLICT(surface_key) DO UPDATE SET last_seen = excluded.last_seen`,
  ).run(START, now);

  // Three secret findings at different lifecycle states (candidate / rotated / reappeared-live).
  const secretStates: { key: string; status: string; path: string; provider: string | null }[] = [
    { key: 'seed-fp-alpha', status: 'candidate', path: '~/.zshrc', provider: 'anthropic' },
    { key: 'seed-fp-beta', status: 'rotated', path: '~/.claude/settings.local.json', provider: 'openai' },
    { key: 'seed-fp-gamma', status: 'reappeared', path: 'demo/.env', provider: 'anthropic' },
  ];
  const ss = db.prepare(
    `INSERT INTO secret_sightings (fingerprint, detector, sink_key, path, byte_offset, byte_length, direction, status, provider, occurrences, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, 'at_rest', ?, ?, 1, ?, ?)
     ON CONFLICT(fingerprint, sink_key) DO UPDATE SET last_seen = excluded.last_seen, status = excluded.status`,
  );
  for (const s of secretStates) {
    ss.run(s.key, 'seed-story-detector', `seed:${s.path}`, s.path, 0, 24, s.status, s.provider, START, now);
  }

  // A bypassPermissions session with a destructive command (the behaviour ledger).
  db.prepare(
    `INSERT INTO tool_calls (tool_call_key, tool, name, shape, args_digest, session_id, agent_id, ts, status, status_source, duration_ms, duration_kind, authority, raw_ref, permission_mode, authorization_basis, first_seen, last_seen)
     VALUES ('seed-story:tc:bypass-1', 'claude_code', 'Bash', 'rm -rf <dir>', 'seed', 'seed-story-bypass', NULL, ?, 'ok', 'measured', 900, 'measured', 'allowed', NULL, 'bypassPermissions', 'bypass_no_gate', ?, ?)
     ON CONFLICT(tool_call_key) DO UPDATE SET last_seen = excluded.last_seen`,
  ).run(now - DAY, now - DAY, now);

  // The quota-exhausted incident, through the real anomaly writer.
  insertAnomalies(db, [
    {
      anomaly_key: 'seed:rate_limit_pressure:seed-story-quota', rule: 'rate_limit_pressure',
      severity: 'warn', tool: 'codex', session_id: 'seed-story-quota', model: 'gpt-5.1-codex-max',
      window_start: now - 2 * DAY, window_end: now - 2 * DAY + 3600_000,
      title: 'Rate limit pressure (97%)', detail: 'seed story: a quota-exhausted day',
      observed: 97, baseline: null, threshold: 90, confidence: 'exact', source: 'seed', detected_at: now,
    },
  ]);

  console.log(`Seeded the enterprise story: ${inserted} events (source='seed'), 12 employees across 3 machines.`);
  console.log('  - unsanctioned Grok CLI on two hosts (Shadow AI + unsanctioned chip)');
  console.log('  - three secret findings at different lifecycle states (Data Exposure)');
  console.log('  - a bypassPermissions session with a destructive command (Behaviour)');
  console.log('  - a quota-exhausted day (Incidents)');
  console.log('Every export path refuses seed rows, so a demo can never become evidence.');
  console.log('Tour (six stops):');
  const stops = [
    ['Overview', 'what left this machine: spend, tokens and the agents behind them'],
    ['Shadow AI', 'twelve employees, three machines, one unsanctioned Grok CLI on two hosts'],
    ['Data Exposure', 'three secret findings at different lifecycle states, with the coverage denominator'],
    ['Live Sessions', 'a bypassPermissions session running a destructive command, flagged in acting-now'],
    ['Incidents', 'the quota-exhausted day beside the rule thresholds that fired it'],
    ['Evidence bundle', 'the export preview with the not-covered list — and seed rows refused'],
  ];
  for (const [name, caption] of stops) console.log(`  ${name.padEnd(18)} ${caption}`);
  console.log('Purge at any time with: pnpm seed:purge');
  process.exit(0);
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
const insertedAnomalies = insertAnomalies(db, seedAnomalies).inserted.length;

console.log(`Seeded ${inserted} demo events (source='seed') across 30 days.`);
console.log(`Detected ${insertedAnomalies} demo incidents using the real rules.`);
console.log("Remove at any time with: pnpm seed:purge");
