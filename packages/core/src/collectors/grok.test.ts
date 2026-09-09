import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, resetDbCache } from '../db';
import { collectGrok } from './grok';

/** A migrated store in a fresh temp dir, pointed at by VOLE_DB / VOLE_HOME_OVERRIDE. */
function makeStore(prefix: string) {
  const home = mkdtempSync(join(tmpdir(), `vole-${prefix}-`));
  const dbFile = join(home, 'vole.db');
  process.env.VOLE_HOME_OVERRIDE = home;
  process.env.VOLE_DB = dbFile;
  return {
    db: openDb(dbFile),
    home,
    done() {
      resetDbCache();
      delete process.env.VOLE_HOME_OVERRIDE;
      delete process.env.VOLE_DB;
    },
  };
}

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
    // the read offset is recorded for the log
    const cur = s.db
      .prepare('SELECT last_offset FROM collector_state WHERE source_path LIKE ?')
      .get('%unified.jsonl') as { last_offset: number };
    assert.ok(cur.last_offset > 0);
  } finally {
    s.done();
  }
});
