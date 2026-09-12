import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count, sumCounts } from './jsonl';

test('count passes through ordinary measured counts', () => {
  assert.equal(count(0), 0);
  assert.equal(count(1), 1);
  assert.equal(count(999_999), 999_999);
});

test('count rejects the types that abort a collection pass', () => {
  // node:sqlite cannot bind these; unguarded they throw and kill the whole run.
  assert.equal(count([1, 2]), 0);
  assert.equal(count({ a: 1 }), 0);
  assert.equal(count(true), 0);
  assert.equal(count(null), 0);
  assert.equal(count(undefined), 0);
});

test('count rejects numeric strings, which would concatenate instead of add', () => {
  // The bug this exists to stop: "999999" + 5000 === "9999995000".
  assert.equal(count('999999'), 0);
  assert.equal(count('one hundred'), 0);
  const total = count('999999') + count(5000);
  assert.equal(total, 5000);
  assert.equal(typeof total, 'number');
});

test('count floors a negative count to zero, never a negative cost', () => {
  assert.equal(count(-1), 0);
  assert.equal(count(-500_000), 0);
});

test('count keeps non-finite values out of the aggregates', () => {
  assert.equal(count(Infinity), 0);
  assert.equal(count(-Infinity), 0);
  assert.equal(count(NaN), 0);
});

test('count rejects out-of-range rather than inventing a ceiling value', () => {
  // Clamping to MAX_SAFE_INTEGER would leave rows at the ceiling whose SUM()
  // then cannot be read back out of SQLite.
  assert.equal(count(1e308), 0);
  assert.equal(count(9_007_199_254_740_993), 0);
  assert.equal(count(12.7), 12);
  assert.equal(count(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test('sumCounts keeps a total readable back out of SQLite', () => {
  const ceiling = Number.MAX_SAFE_INTEGER;
  // Three already-clamped fields sum past the ceiling; SQLite stores that 64-bit
  // integer but node:sqlite then throws on the read, poisoning every later pass.
  assert.equal(sumCounts(ceiling, ceiling, ceiling), ceiling);
  assert.ok(Number.isSafeInteger(sumCounts(ceiling, ceiling, ceiling)));
  assert.equal(sumCounts(1e308, 5), 5); // the absurd addend is not a measurement
  assert.equal(sumCounts(1, 2, 3), 6);
  assert.equal(sumCounts(), 0);
});

test('sumCounts sanitises each addend, so no string sneaks in as concatenation', () => {
  const bad = ['999999', null, undefined, [1], true, -5, NaN] as unknown as number[];
  const t = sumCounts(...bad, 100);
  assert.equal(t, 100);
  assert.equal(typeof t, 'number');
});
