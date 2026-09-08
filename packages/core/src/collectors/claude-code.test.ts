import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getState, insertEvents } from '../db';
import { insertToolCalls } from '../toolcalls/bind';
import { collectClaudeCode } from './claude-code';
import { makeStore, type Store } from './test-store';

function assistant(id: string, output: number, extra: Record<string, unknown> = {}, content?: unknown[]) {
  return JSON.stringify({
    type: 'assistant', sessionId: 'sess-1', cwd: '/w', timestamp: '2026-01-01T00:00:00.000Z',
    message: { id, model: 'claude-opus-5', stop_reason: output ? 'end_turn' : null,
               content: content ?? [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash' }, { type: 'tool_use', name: 'Read' }],
               usage: { input_tokens: 5, output_tokens: output, cache_read_input_tokens: 100 } },
    ...extra,
  });
}

function setup(): Store & { proj: string } {
  const s = makeStore('cc');
  const proj = join(s.home, '.claude', 'projects', '-w');
  mkdirSync(join(proj, 'sess-1', 'subagents', 'workflows', 'wf_1'), { recursive: true });
  writeFileSync(join(proj, 'sess-1.jsonl'), [assistant('m1', 0), assistant('m1', 40)].join('\n') + '\n');
  writeFileSync(join(proj, 'sess-1', 'subagents', 'workflows', 'wf_1', 'agent-a.jsonl'),
    assistant('m2', 70, { isSidechain: true, agentId: 'agent-a' }) + '\n');
  return { ...s, proj };
}

test('subagent transcripts nested under the session are collected', () => {
  const { db, done } = setup();
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
    done();
  }
});

test('read offsets advance only on commit, after the rows are stored', () => {
  const { db, proj, done } = setup();
  try {
    const r = collectClaudeCode(db);
    assert.equal(getState(db, join(proj, 'sess-1.jsonl')), undefined, 'nothing persisted yet');
    insertEvents(db, r.events);
    r.commit!();
    const st = getState(db, join(proj, 'sess-1.jsonl'))!;
    assert.ok((st.last_offset ?? 0) > 0);
    assert.ok(st.prefix_sha256, 'the chained prefix digest is stored with the offset');
    assert.ok(st.head_sha256, 'the head digest is stored');
    assert.equal(collectClaudeCode(db).events.length, 0, 'second pass reads nothing new');
  } finally {
    done();
  }
});

test('B5: tool names are unioned across per-block copies of the same message id', () => {
  // Real transcripts write one line per content block under the same message.id
  // with identical usage — the tool_use blocks sit on different sibling copies.
  // The old keep() took one copy and dropped the other's names.
  const { db, home, done } = setup();
  try {
    const file = join(home, '.claude', 'projects', '-w', 'sess-2.jsonl');
    writeFileSync(file, [
      assistant('m3', 10, {}, [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'toolu_a', name: 'Bash' }]),
      assistant('m3', 10, {}, [{ type: 'tool_use', id: 'toolu_b', name: 'Read' }, { type: 'tool_use', id: 'toolu_c', name: 'Grep' }]),
    ].join('\n') + '\n');
    const r = collectClaudeCode(db);
    const m3 = r.events.find((e) => e.event_key === 'claude_code:m3')!;
    assert.equal(r.events.filter((e) => e.event_key === 'claude_code:m3').length, 1, 'copies coalesce to one row');
    assert.equal(m3.tools, 'Bash,Read,Grep', 'names from every sibling copy survive, first-appearance order');

    // v2: the toolu_ ids and the mcp server prefixes land where the ledgers read them
    insertEvents(db, r.events);
    insertToolCalls(db, r.toolCalls!);
    r.commit!();
    const links = db
      .prepare("SELECT link_kind, link_id FROM event_links WHERE event_key = 'claude_code:m3'")
      .all() as { link_kind: string; link_id: string }[];
    assert.deepEqual(
      links.map((l) => l.link_id).sort(),
      ['toolu_a', 'toolu_b', 'toolu_c'],
      'every tool_use id is a vendor-join key on its message row',
    );
  } finally {
    done();
  }
});

test('v2: server_tool_use counts are stored as billing-line links; observed_at stamps on commit', () => {
  const { db, home, done } = setup();
  try {
    const file = join(home, '.claude', 'projects', '-w', 'sess-4.jsonl');
    writeFileSync(file, assistant('m4', 10, {
      requestId: 'req_123',
      message: {
        id: 'm4', model: 'claude-opus-5', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 1, server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 } },
      },
    }) + '\n');
    const r = collectClaudeCode(db);
    insertEvents(db, r.events);
    r.commit!();
    const links = db
      .prepare("SELECT link_kind, link_id FROM event_links WHERE event_key = 'claude_code:m4'")
      .all() as { link_kind: string; link_id: string }[];
    const byKind = Object.fromEntries(links.map((l) => [l.link_kind, l.link_id]));
    assert.equal(byKind['web_search_requests'], '3', 'the per-request billing line is stored');
    assert.equal(byKind['web_fetch_requests'], '0', 'a zero count is stored too — field presence is the proof');
    assert.equal(byKind['request_id'], 'req_123', 'the API request id is a join key');
    const obs = db
      .prepare("SELECT observed_at FROM usage_events WHERE event_key = 'claude_code:m4'")
      .get() as { observed_at: number | null };
    assert.ok(obs.observed_at, 'the collector clock is stamped after the rows are stored');
  } finally {
    done();
  }
});

test('v2: mcp__ server prefixes widen the stored tool_calls row', () => {
  const { db, home, done } = setup();
  try {
    const file = join(home, '.claude', 'projects', '-w', 'sess-5.jsonl');
    writeFileSync(file, assistant('m5', 10, {}, [
      { type: 'text', text: 'ok' },
      { type: 'tool_use', id: 'toolu_mcp', name: 'mcp__github__push_files' },
    ]) + '\n');
    const r = collectClaudeCode(db);
    insertEvents(db, r.events);
    insertToolCalls(db, r.toolCalls!);
    r.commit!();
    const row = db
      .prepare('SELECT server FROM tool_calls WHERE tool_call_key = ?')
      .get('claude_code:toolu_mcp') as { server: string | null };
    assert.equal(row!.server, 'github', 'the server column names which server the call went to');
  } finally {
    done();
  }
});

test('turn-scoped duration: the assistant message carries the gap from the previous turn line', () => {
  const { db, home, done } = setup();
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
    done();
  }
});
