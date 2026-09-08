/**
 * Builds the deterministic fixture store the read-model parity check runs against.
 *
 *   pnpm tsx scripts/parity-fixture.mjs /tmp/parity/vole.db
 *   VOLE_DB=/tmp/parity/vole.db pnpm tsx src/cli/readmodel-dump.ts > ts.json
 *   VOLE_DB=/tmp/parity/vole.db swift run Vole --dump=readmodel > swift.json
 *   diff ts.json swift.json
 *
 * Every value is fixed (no Date.now, no randomness): a diff is a read-model
 * difference, never a timing artifact. Rows cover the cases the readers have
 * historically disagreed about — mixed exact/activity_only groups, NULL tokens,
 * incidents with figures, unpriced models.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, resetDbCache, insertEvents, insertAnomalies } from '../src/db';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/parity-fixture.mjs <db-path>');
  process.exit(1);
}

mkdirSync(dirname(file), { recursive: true });
rmSync(file, { force: true });
// openDb (not a raw Database + SCHEMA): the fixture must carry everything a real
// store has, including the migration ledger and the shared views both readers
// select from — otherwise the parity check proves less than it claims.
const db = openDb(file);

const T = 1_700_000_000_000; // fixed epoch — 2023-11-14T22:13:20Z

function ev(over) {
  return {
    event_key: `k${Math.random()}`, tool: 'claude_code', model: 'claude-opus-5',
    session_id: 's1', project: '/w', git_branch: null, ts: T,
    input_tokens: 100, output_tokens: 50, cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0,
    total_tokens: 150, cost_usd: 0.0015, confidence: 'exact', is_error: 0,
    stop_reason: 'end_turn', source: 'live', raw_ref: '/f', tools: null,
    agent_id: null, context_window: null, ...over,
  };
}

insertEvents(db, [
  // exact rows, two models, one unpriced
  ev({ event_key: 'p1', ts: T }),
  ev({ event_key: 'p2', ts: T + 1000, model: 'claude-sonnet-5', session_id: 's2', cost_usd: 0.0006 }),
  ev({ event_key: 'p3', ts: T + 2000, model: 'qwen3.8-27b-fp8', cost_usd: null }),
  // a tool with mixed rows: exact tokens alongside activity-only
  ev({ event_key: 'g1', tool: 'grok', model: 'grok-4', ts: T + 3000, total_tokens: 40_000, cost_usd: null }),
  ev({ event_key: 'g2', tool: 'grok', model: 'grok-4', ts: T + 4000, confidence: 'activity_only',
       input_tokens: null, output_tokens: null, cache_read_tokens: null, total_tokens: null, cost_usd: null }),
  // an activity-only-only tool: tokens NULL for the whole group
  ev({ event_key: 'c1', tool: 'cursor', model: null, ts: T + 5000, confidence: 'activity_only',
       input_tokens: null, output_tokens: null, cache_read_tokens: null, total_tokens: null, cost_usd: null }),
  // error + truncation counters
  ev({ event_key: 'e1', ts: T + 6000, is_error: 1 }),
  ev({ event_key: 'e2', ts: T + 7000, stop_reason: 'max_tokens' }),
  // seed rows must be included by includeSeed=true
  ev({ event_key: 's9', ts: T + 8000, source: 'seed' }),
]);

insertAnomalies(db, [
  {
    anomaly_key: 'billable_burn_spike:claude_code:claude-opus-5:s1:1700000000000',
    rule: 'billable_burn_spike', severity: 'critical', tool: 'claude_code', session_id: 's1',
    model: 'claude-opus-5', window_start: T, window_end: T + 600_000,
    title: 'Billable burn spike on claude_code (claude-opus-5)',
    detail: '$1.25 in 10 min ($0.13/min) across 4 calls — 6.2x this session\'s typical window ($0.20). Raw 900,000 tokens including cache reads. Session s1xxxxxx.',
    observed: 1.25, baseline: 0.2, threshold: 0.6, confidence: 'exact', source: 'live', detected_at: T + 600_000,
  },
  {
    anomaly_key: 'repeat_call_loop:grok:grok-4:main:1700000300000',
    rule: 'repeat_call_loop', severity: 'warn', tool: 'grok', session_id: 's9',
    model: 'grok-4', window_start: T + 300_000, window_end: T + 600_000,
    title: 'Runaway loop in grok session s9xxxxxx',
    detail: '50 calls in 5 min while average output stayed at 40 tokens.',
    observed: 50, baseline: null, threshold: 45, confidence: 'exact', source: 'live', detected_at: T + 600_000,
  },
]);


// ── the deep-completion ledgers: rows the new read models round-trip ─────────
// Fixed values only; every key deterministic. NULLs where a figure is unknown.
db.exec(`
  INSERT INTO tool_calls (tool_call_key, tool, name, shape, args_digest, session_id, ts, status,
    status_source, permission_mode, authorization_basis, authority, origin_kind, first_seen, last_seen)
  VALUES
    ('tc1', 'claude_code', 'Bash', 'rm -rf build', 'd1', 's1', ${T + 1000}, 'success', 'result_flag', 'bypassPermissions', 'bypass_no_gate', 'posture_waived', null, ${T + 1000}, ${T + 1000}),
    ('tc2', 'claude_code', 'Read', null, 'd2', 's1', ${T + 2000}, 'denied', 'denial_phrase', 'default', 'human_denied', 'denied', null, ${T + 2000}, ${T + 2000}),
    ('tc3', 'claude_code', 'Write', null, 'd3', 's2', ${T + 3000}, 'success', 'result_flag', 'default', 'mode_auto', null, 'human', ${T + 3000}, ${T + 3000});

  INSERT INTO autonomy_intervals (session_id, agent_id, started_at, ended_at, calls, denied, errors, mode_raw, autonomy, fs_policy, approval_policy, sandbox_policy, permission_profile)
  VALUES
    ('s1', 'main', ${T + 1000}, ${T + 2000}, 2, 1, 0, 'bypassPermissions', 'full_auto', null, null, null, null),
    ('s2', 'main', ${T + 3000}, ${T + 3000}, 1, 0, 0, 'default', 'prompt_each', null, null, null, null);

  INSERT INTO file_writes (write_key, tool_call_key, session_id, path, path_class, write_class, change_risk_class, class_pattern_id, content_rev, escape_state, visibility_class, ts, first_seen, last_seen)
  VALUES
    ('w1', 'tc3', 's2', '/w/src/a.ts', 'source', 'structured', 'source', null, 1, 'local', null, ${T + 3000}, ${T + 3000}, ${T + 3000}),
    ('w2', 'tc1', 's1', null, null, 'bash_redirect', null, null, null, null, null, ${T + 1000}, ${T + 1000}, ${T + 1000});

  INSERT INTO action_targets (call_key, target_kind, target_label, locality, env_class, first_seen, last_seen)
  VALUES
    ('tc1', 'vcs_repo', 'github.com/acme/billing', 'remote', 'prod', ${T + 1000}, ${T + 1000}),
    ('tc3', 'database', 'prod-db.internal:5432', 'remote', 'prod', ${T + 3000}, ${T + 3000});

  INSERT INTO fetch_ingress (call_key, url_host, status, bytes, ts)
  VALUES
    ('tc1', 'docs.example.com', 200, 1024, ${T + 1000}),
    ('tc1', 'unparsed.host', null, null, ${T + 1500});

  INSERT INTO event_links (event_key, vendor, link_kind, link_id, first_seen)
  VALUES
    ('p1', 'claude_code', 'web_search_requests', '3', ${T}),
    ('p2', 'claude_code', 'web_fetch_requests', '5', ${T + 1000});

  INSERT INTO bulk_uploads (upload_key, repo_path, turn, max_file_bytes, size_bytes, gcs_path, blobs, started_at)
  VALUES
    ('u1', '/w', 3, 1048576, 520761, 'gs://x/abc.tar.gz', 12, ${T}),
    ('u2', '/w', 4, 1048576, null, null, null, ${T + 1000});

  INSERT INTO upload_decisions (upload_key, uploads_enabled, upload_reason, trace_upload_source, telemetry_mode, data_collection_disabled, in_env_trace_upload, in_cfg_telemetry_trace_upload, in_remote_trace_upload_enabled, has_remote_settings, in_requirement_pin, telemetry_source, ts)
  VALUES
    ('u1', 1, 'remote_default', 'remote', 'on', 0, null, null, 1, 1, 0, 'remote', ${T});

  INSERT INTO posture_mcp_servers (source, config_path, client, server_name, mcp_identity, transport, command, argv, url, cwd, enabled, env_key_names, first_seen, last_seen)
  VALUES
    ('claude_code', '/home/u/.claude.json', 'claude_code', 'github', 'id-abc', 'stdio', 'npx -y @github/mcp', null, null, null, 1, null, ${T}, ${T}),
    ('codex', '/home/u/.codex/config.toml', 'codex', 'github', 'id-abc', 'stdio', 'npx -y @github/mcp', null, null, null, 1, null, ${T}, ${T});

  INSERT INTO ai_surfaces (surface_key, kind, name, path, evidence, version, sanctioned, first_seen, last_seen)
  VALUES
    ('app:codex', 'app', 'Codex CLI', '/Applications/Codex.app', 'bundle id', '0.5.0', null, ${T}, ${T}),
    ('gateway:acme', 'gateway', 'acme-ai-gateway', '/etc/acme.yaml', 'launchd argument', null, 'true', ${T}, ${T});
`);

// observation lag: observed_at is insert-time wall clock, so pin every row to a
// fixed value — the parity diff must never see collection time.
db.prepare('UPDATE usage_events SET observed_at = ts + 2500 WHERE event_key IN (?,?,?,?,?,?,?,?)')
  .run('p1', 'p2', 'p3', 'g1', 'g2', 'c1', 'e1', 'e2');
db.prepare('UPDATE usage_events SET observed_at = ? WHERE event_key = ?').run(T + 9000, 'p2');

resetDbCache();   // closes the cached handle the fixtures opened
console.log(`fixture store → ${file}`);
