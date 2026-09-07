import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../sqlite';
import { SCHEMA } from '../schema';
import { getState, insertEvents } from '../db';
import { collectClaudeCode } from './claude-code';

function assistant(id: string, output: number, extra: Record<string, unknown> = {}, content?: unknown[]) {
  return JSON.stringify({
    type: 'assistant', sessionId: 'sess-1', cwd: '/w', timestamp: '2026-01-01T00:00:00.000Z',
    message: { id, model: 'claude-opus-5', stop_reason: output ? 'end_turn' : null,
               content: content ?? [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash' }, { type: 'tool_use', name: 'Read' }],
               usage: { input_tokens: 5, output_tokens: output, cache_read_input_tokens: 100 } },
    ...extra,
  });
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'vole-cc-'));
  const proj = join(home, '.claude', 'projects', '-w');
  mkdirSync(join(proj, 'sess-1', 'subagents', 'workflows', 'wf_1'), { recursive: true });
  writeFileSync(join(proj, 'sess-1.jsonl'), [assistant('m1', 0), assistant('m1', 40)].join('\n') + '\n');
  writeFileSync(join(proj, 'sess-1', 'subagents', 'workflows', 'wf_1', 'agent-a.jsonl'),
    assistant('m2', 70, { isSidechain: true, agentId: 'agent-a' }) + '\n');
  const db = new Database(join(home, 'test.db'));
  db.exec(SCHEMA);
  process.env.VOLE_HOME_OVERRIDE = home;
  return { db, proj, home };
}

test('subagent transcripts nested under the session are collected', () => {
  const { db } = setup();
  try {
    const r = collectClaudeCode(db);
    assert.equal(r.filesScanned, 2);
    assert.deepEqual(r.events.map((e) => e.event_key).sort(), ['claude_code:m1', 'claude_code:m2']);
    const m1 = r.events.find((e) => e.event_key === 'claude_code:m1')!;
    assert.equal(m1.output_tokens, 40, 'placeholder copy coalesces to the fullest one');
    const m2 = r.events.find((e) => e.event_key === 'claude_code:m2')!;
    assert.equal(m2.session_id, 'sess-1');
    assert.equal(m2.agent_id, 'agent-a', 'subagent calls keep the parent session and carry their agent id');
    assert.equal(m1.agent_id, null);
    assert.equal(m1.tools, 'Bash,Read');
    assert.equal(m1.context_window, 1_000_000);
  } finally {
    delete process.env.VOLE_HOME_OVERRIDE;
  }
});

test('read offsets advance only on commit, after the rows are stored', () => {
  const { db, proj } = setup();
  try {
    const r = collectClaudeCode(db);
    assert.equal(getState(db, join(proj, 'sess-1.jsonl')), undefined, 'nothing persisted yet');
    insertEvents(db, r.events);
    r.commit!();
    assert.ok((getState(db, join(proj, 'sess-1.jsonl'))?.last_offset ?? 0) > 0);
    assert.equal(collectClaudeCode(db).events.length, 0, 'second pass reads nothing new');
  } finally {
    delete process.env.VOLE_HOME_OVERRIDE;
  }
});

test('B5: tool names are unioned across per-block copies of the same message id', () => {
  // Real transcripts write one line per content block under the same message.id
  // with identical usage — the tool_use blocks sit on different sibling copies.
  // The old keep() took one copy and dropped the other's names.
  const { db, home } = setup();
  try {
    const file = join(home, '.claude', 'projects', '-w', 'sess-2.jsonl');
    writeFileSync(file, [
      assistant('m3', 10, {}, [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash' }]),
      assistant('m3', 10, {}, [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Grep' }]),
    ].join('\n') + '\n');
    const r = collectClaudeCode(db);
    const m3 = r.events.find((e) => e.event_key === 'claude_code:m3')!;
    assert.equal(r.events.filter((e) => e.event_key === 'claude_code:m3').length, 1, 'copies coalesce to one row');
    assert.equal(m3.tools, 'Bash,Read,Grep', 'names from every sibling copy survive, first-appearance order');
  } finally {
    delete process.env.VOLE_HOME_OVERRIDE;
  }
});

test('turn-scoped duration: the assistant message carries the gap from the previous turn line', () => {
  const { db, home } = setup();
  try {
    const file = join(home, '.claude', 'projects', '-w', 'sess-3.jsonl');
    const user = (t: string) => JSON.stringify({
      type: 'user', sessionId: 'sess-3', cwd: '/w', timestamp: t,
      message: { role: 'user', content: 'go' },
    });
    const asst = (t: string, id: string) => JSON.stringify({
      type: 'assistant', sessionId: 'sess-3', cwd: '/w', timestamp: t,
      message: { id, model: 'claude-opus-5', stop_reason: 'end_turn',
                 content: [{ type: 'text', text: 'ok' }],
                 usage: { input_tokens: 5, output_tokens: 300, cache_read_input_tokens: 100 } },
    });
    // user turn at T, assistant completes 6s later: gap = 6000ms.
    const T = '2026-01-02T00:00:00.000Z';
    const T6 = '2026-01-02T00:00:06.000Z';
    writeFileSync(file, [user(T), asst(T6, 'm9')].join('\n') + '\n');
    const r = collectClaudeCode(db);
    const m9 = r.events.find((e) => e.event_key === 'claude_code:m9')!;
    assert.equal(m9.duration_ms, 6000, 'the turn gap becomes the duration');
    assert.equal(m9.duration_kind, 'turn_scoped', 'and it says it was estimated');
  } finally {
    delete process.env.VOLE_HOME_OVERRIDE;
  }
});
