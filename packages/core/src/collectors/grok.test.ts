import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectGrok } from './grok';
import { makeStore } from './test-store';

const line = (ts: string, msg: string, ctx: Record<string, unknown>) =>
  JSON.stringify({ ts, sid: 'sid-1', msg, ctx });

function grokHome(home: string, lines: string[]) {
  mkdirSync(join(home, '.grok', 'logs'), { recursive: true });
  writeFileSync(join(home, '.grok', 'logs', 'unified.jsonl'), lines.join('\n') + '\n');
}

test('grok: tool executions attach to the call that asked for them; failed inferences become error rows', () => {
  const s = makeStore('grok');
  try {
    grokHome(s.home, [
      line('2026-01-01T00:00:00.000Z', 'shell.turn.inference_done', { prompt_tokens: 1000, cached_prompt_tokens: 200, completion_tokens: 50 }),
      line('2026-01-01T00:00:01.000Z', 'shell.tool.exec_done', { tool_name: 'list_dir', success: true }),
      line('2026-01-01T00:00:02.000Z', 'shell.tool.exec_done', { tool_name: 'read_file', success: true }),
      line('2026-01-01T00:00:03.000Z', 'shell.turn.inference_failed', { kind: 'api', status_code: 403, message: 'out of credits' }),
      line('2026-01-01T00:00:04.000Z', 'shell.turn.inference_done', { prompt_tokens: 1500, cached_prompt_tokens: 1000, completion_tokens: 20 }),
    ]);
    const r = collectGrok(s.db);
    assert.equal(r.events.length, 3);
    const [first, failed, second] = r.events;
    assert.equal(first!.tools, 'list_dir,read_file');
    assert.equal(first!.input_tokens, 800, 'fresh input excludes the cached part');
    assert.equal(failed!.is_error, 1);
    assert.equal(failed!.confidence, 'activity_only', 'no usage was recorded for a failed call');
    assert.equal(failed!.total_tokens, null);
    assert.equal(failed!.stop_reason, 'error:403');
    assert.equal(second!.tools, null);
    // the declared cursor: offset + chained digest recorded for the log
    const cur = s.db
      .prepare('SELECT last_offset, prefix_sha256 FROM collector_state WHERE source_path LIKE ?')
      .get('%unified.jsonl') as { last_offset: number; prefix_sha256: string | null };
    assert.ok(cur.last_offset > 0);
    assert.ok(cur.prefix_sha256);
  } finally {
    s.done();
  }
});

test('grok: repo_state upload start/enqueued and the trace.upload.decision precedence chain', () => {
  const s = makeStore('grok-uploads');
  try {
    grokHome(s.home, [
      line('2026-01-01T00:00:00.000Z', 'repo_state.upload.start', { phase: 'start', turn_number: 3, repo_path: '/Users/x/repo', max_file_bytes: 1048576 }),
      line('2026-01-01T00:00:01.000Z', 'repo_state.upload.start', { phase: 'start', turn_number: 4, repo_path: '/Users/x/repo', max_file_bytes: 1048576 }),
      line('2026-01-01T00:00:02.000Z', 'repo_state.upload.enqueued', { size_bytes: 520761, gcs_path: 'gs://x/abc.tar.gz', blobs: 12 }),
      line('2026-01-01T00:00:03.000Z', 'trace.upload.decision', {
        trace_upload: true, trace_upload_source: 'remote', telemetry_mode: 'on', telemetry_source: 'remote',
        in_requirement_pin: false, in_env_trace_upload: null, in_env_telemetry_enabled: null,
        in_cfg_telemetry_trace_upload: null, in_remote_trace_upload_enabled: true, has_remote_settings: true,
        uploads_enabled: true, upload_reason: 'remote_default', data_collection_disabled: false,
      }),
    ]);
    const r = collectGrok(s.db);
    assert.equal(r.events.length, 0, 'upload lines are not model calls');

    const uploads = s.db
      .prepare('SELECT upload_key, repo_path, turn, max_file_bytes, size_bytes, gcs_path, blobs FROM bulk_uploads ORDER BY turn')
      .all() as { upload_key: string; repo_path: string; turn: number; max_file_bytes: number; size_bytes: number | null; gcs_path: string | null; blobs: number | null }[];
    assert.equal(uploads.length, 2, 'turn 3 and turn 4 are distinct uploads');
    assert.equal(uploads[0]!.repo_path, '/Users/x/repo');
    assert.equal(uploads[0]!.max_file_bytes, 1048576);
    // the enqueued line widens the most recent start (turn 4); turn 3 never
    // enqueued and keeps size NULL — an unknown, never a 0-byte upload.
    assert.equal(uploads[0]!.size_bytes, null);
    assert.equal(uploads[1]!.size_bytes, 520761);
    assert.equal(uploads[1]!.gcs_path, 'gs://x/abc.tar.gz');
    assert.equal(uploads[1]!.blobs, 12);

    const d = s.db
      .prepare('SELECT * FROM upload_decisions')
      .all() as Record<string, unknown>[];
    assert.equal(d.length, 1);
    assert.equal(d[0]!.uploads_enabled, 1);
    assert.equal(d[0]!.trace_upload_source, 'remote');
    assert.equal(d[0]!.in_env_trace_upload, null, 'a NULL input stays NULL — the ladder shows which rung decided');
    assert.equal(d[0]!.in_remote_trace_upload_enabled, 1);
    assert.equal(d[0]!.has_remote_settings, 1);

    // idempotent: a second pass upserts, never duplicates
    collectGrok(s.db);
    const n = s.db.prepare('SELECT COUNT(*) AS n FROM upload_decisions').get() as { n: number };
    assert.equal(n.n, 1);
    const u = s.db.prepare('SELECT COUNT(*) AS n FROM bulk_uploads').get() as { n: number };
    assert.equal(u.n, 2);
  } finally {
    s.done();
  }
});
