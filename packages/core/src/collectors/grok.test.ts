import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DB } from '../db';
import { collectGrok } from './grok';

const line = (ts: string, msg: string, ctx: Record<string, unknown>) =>
  JSON.stringify({ ts, sid: 'sid-1', msg, ctx });

test('grok: tool executions attach to the call that asked for them; failed inferences become error rows', () => {
  const home = mkdtempSync(join(tmpdir(), 'vole-grok-'));
  mkdirSync(join(home, '.grok', 'logs'), { recursive: true });
  writeFileSync(join(home, '.grok', 'logs', 'unified.jsonl'), [
    line('2026-01-01T00:00:00.000Z', 'shell.turn.inference_done', { prompt_tokens: 1000, cached_prompt_tokens: 200, completion_tokens: 50 }),
    line('2026-01-01T00:00:01.000Z', 'shell.tool.exec_done', { tool_name: 'list_dir', success: true }),
    line('2026-01-01T00:00:02.000Z', 'shell.tool.exec_done', { tool_name: 'read_file', success: true }),
    line('2026-01-01T00:00:03.000Z', 'shell.turn.inference_failed', { kind: 'api', status_code: 403, message: 'out of credits' }),
    line('2026-01-01T00:00:04.000Z', 'shell.turn.inference_done', { prompt_tokens: 1500, cached_prompt_tokens: 1000, completion_tokens: 20 }),
  ].join('\n') + '\n');
  process.env.VOLE_HOME_OVERRIDE = home;
  try {
    const r = collectGrok(null as unknown as DB);
    assert.equal(r.events.length, 3);
    const [first, failed, second] = r.events;
    assert.equal(first!.tools, 'list_dir,read_file');
    assert.equal(first!.input_tokens, 800, 'fresh input excludes the cached part');
    assert.equal(failed!.is_error, 1);
    assert.equal(failed!.confidence, 'activity_only', 'no usage was recorded for a failed call');
    assert.equal(failed!.total_tokens, null);
    assert.equal(failed!.stop_reason, 'error:403');
    assert.equal(second!.tools, null);
  } finally {
    delete process.env.VOLE_HOME_OVERRIDE;
  }
});
