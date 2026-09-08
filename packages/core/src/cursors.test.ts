import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chainDigest, headSha, advanceCursor, getCursor } from './cursors';
import { makeStore } from './collectors/test-store';

test('chainDigest: the spec chain sha256(prev_digest || chunk), deterministic and order-sensitive', () => {
  const a = Buffer.from('hello ');
  const b = Buffer.from('world');
  const step = chainDigest(chainDigest(null, a), b);
  // deterministic: same chunks, same chain
  assert.equal(step, chainDigest(chainDigest(null, a), b));
  // the digest bytes chain (not the hex text): differs from hashing the hex
  assert.notEqual(step, chainDigest(null, Buffer.from(chainDigest(null, a), 'utf8')));
  // and the chain is order-sensitive
  assert.notEqual(step, chainDigest(chainDigest(null, b), a));
});

test('headSha: the first 4 KiB only, null on a missing file', () => {
  const dir = join(tmpdir(), `vole-cur-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'f.log');
  const big = 'x'.repeat(10_000);
  writeFileSync(p, big);
  const head = headSha(p)!;
  const expect = createHash('sha256').update(Buffer.from(big.slice(0, 4096))).digest('hex');
  assert.equal(head, expect);
  assert.equal(headSha(join(dir, 'nope')), null);
  unlinkSync(p);
});

test('advanceCursor: stores offset/digest/inode; appends chain; shrink fires source_rewritten and resets', () => {
  const s = makeStore('cursors');
  try {
    const p = join(s.home, 'src.jsonl');
    writeFileSync(p, 'line1\n');
    const st = { ino: statSync(p).ino, birthtimeMs: statSync(p).birthtimeMs };
    const r1 = advanceCursor(s.db, { sourceKey: p, tool: 'codex', offset: 6, mtimeMs: 1, stat: st, anomalyTool: 'codex' });
    assert.equal(r1.rewritten, false);
    const c1 = getCursor(s.db, p)!;
    assert.equal(c1.last_offset, 6);
    assert.ok(c1.prefix_sha256, 'the chained digest is stored');
    assert.ok(c1.head_sha256, 'the head digest is stored');
    assert.ok(c1.inode, 'the inode is stored');

    // Append: the digest chains over only the new bytes.
    writeFileSync(p, 'line1\nline2\n');
    const r2 = advanceCursor(s.db, { sourceKey: p, tool: 'codex', offset: 12, mtimeMs: 2, anomalyTool: 'codex' });
    assert.equal(r2.rewritten, false);
    const c2 = getCursor(s.db, p)!;
    const expect = chainDigest(c1.prefix_sha256, Buffer.from('line2\n'));
    assert.equal(c2.prefix_sha256, expect);

    // Shrink: rewritten, cursor reset, one source_rewritten anomaly stored.
    writeFileSync(p, 'tiny\n');
    const r3 = advanceCursor(s.db, { sourceKey: p, tool: 'codex', offset: 5, mtimeMs: 3, anomalyTool: 'codex' });
    assert.equal(r3.rewritten, true);
    const c3 = getCursor(s.db, p)!;
    assert.equal(c3.last_offset, 5, 'the cursor restarts from the shrunken size');
    const anomalies = s.db
      .prepare("SELECT rule, severity, source FROM anomalies WHERE rule = 'source_rewritten'")
      .all() as { rule: string; severity: string; source: string }[];
    assert.equal(anomalies.length, 1, 'exactly one incident per rewrite');
    assert.equal(anomalies[0]!.source, 'live');

    // The same rewrite detected again is a no-op (stable anomaly_key).
    advanceCursor(s.db, { sourceKey: p, tool: 'codex', offset: 5, mtimeMs: 3, anomalyTool: 'codex' });
    const again = s.db
      .prepare("SELECT COUNT(*) AS n FROM anomalies WHERE rule = 'source_rewritten'")
      .get() as { n: number };
    assert.equal(again.n, 1);
  } finally {
    s.done();
  }
});

test('advanceCursor: an in-place rewrite at the same size changes the head digest and is caught', () => {
  const s = makeStore('cursors2');
  try {
    const p = join(s.home, 'same.jsonl');
    const content = 'aaaaaaaa\n';
    writeFileSync(p, content);
    advanceCursor(s.db, { sourceKey: p, tool: 'claude_code', offset: content.length, mtimeMs: 1, anomalyTool: 'claude_code' });
    // rewritten in place: same size, same offset, different bytes
    writeFileSync(p, 'bbbbbbbb\n');
    const r = advanceCursor(s.db, { sourceKey: p, tool: 'claude_code', offset: content.length, mtimeMs: 2, anomalyTool: 'claude_code' });
    assert.equal(r.rewritten, true, 'the head digest proves the file changed under the cursor');
  } finally {
    s.done();
  }
});
