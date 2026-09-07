import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaveOneOutMedians, medianExcluding, median } from './util';

function naive(values: number[], excludeIndex: number): number {
  return median(values.filter((_, i) => i !== excludeIndex));
}

test('leaveOneOutMedians matches the naive per-index computation, including duplicates', () => {
  const cases: number[][] = [
    [],
    [42],
    [1, 2],
    [3, 1, 2],
    [5, 5, 5, 5],
    [30_000, 800, 800, 30_000, 30_000, 120_000],
    [7, 7, 1, 9, 9, 2, 2, 2, 100, 3],
  ];
  for (const values of cases) {
    const got = leaveOneOutMedians(values);
    assert.equal(got.length, values.length);
    values.forEach((_, i) => {
      assert.equal(
        got[i],
        naive(values, i),
        `index ${i} of [${values.join(',')}]`,
      );
    });
  }
});

test('medianExcluding delegates to the batch form', () => {
  const values = [4, 1, 30, 2, 100];
  for (let i = 0; i < values.length; i++) {
    assert.equal(medianExcluding(values, i), naive(values, i));
  }
});

test('medianExcluding with an out-of-range index falls back to the plain median', () => {
  const values = [1, 2, 3, 4];
  assert.equal(medianExcluding(values, -1), median(values));
  assert.equal(medianExcluding(values, 99), median(values));
});

test('B3: the batch form is usable at 20k windows in well under a second', () => {
  const values = Array.from({ length: 20_000 }, () => Math.random() * 100_000);
  const start = performance.now();
  const got = leaveOneOutMedians(values);
  const ms = performance.now() - start;
  assert.equal(got.length, values.length);
  assert.ok(ms < 1000, `20k windows took ${ms.toFixed(0)}ms`);
});
