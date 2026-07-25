import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fmtBytes, fmtHexSize, fmtAllocSize, fmtNum, parseSize, esc, clampView,
} from '../fmt.js';

test('fmtBytes: bytes below 1 KiB stay exact', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1), '1 B');
  assert.equal(fmtBytes(1023), '1023 B');
});

test('fmtBytes: one decimal below 100, none at or above', () => {
  assert.equal(fmtBytes(1024), '1.0 KiB');
  assert.equal(fmtBytes(1536), '1.5 KiB');
  assert.equal(fmtBytes(99 * 1024), '99.0 KiB');
  assert.equal(fmtBytes(100 * 1024), '100 KiB');
  assert.equal(fmtBytes(1023 * 1024), '1023 KiB');
});

test('fmtBytes: climbs units and stops at PiB', () => {
  assert.equal(fmtBytes(1024 ** 2), '1.0 MiB');
  assert.equal(fmtBytes(1024 ** 3), '1.0 GiB');
  assert.equal(fmtBytes(1024 ** 4), '1.0 TiB');
  assert.equal(fmtBytes(1024 ** 5), '1.0 PiB');
  // beyond PiB the number keeps growing rather than inventing a unit
  assert.equal(fmtBytes(1024 ** 6), '1024 PiB');
});

test('fmtHexSize: rounds, clamps negatives, never NaN', () => {
  assert.equal(fmtHexSize(0), '0x0');
  assert.equal(fmtHexSize(255), '0xff');
  assert.equal(fmtHexSize(4096), '0x1000');
  assert.equal(fmtHexSize(10.6), '0xb');
  assert.equal(fmtHexSize(-5), '0x0');
  assert.equal(fmtHexSize(NaN), '0x0');
  assert.equal(fmtHexSize(undefined), '0x0');
});

test('fmtAllocSize: mode selects the formatter, anything but "hex" is human', () => {
  assert.equal(fmtAllocSize(4096, 'hex'), '0x1000');
  assert.equal(fmtAllocSize(4096, 'human'), '4.0 KiB');
  assert.equal(fmtAllocSize(4096, undefined), '4.0 KiB');
});

test('fmtNum: thousands separators', () => {
  assert.equal(fmtNum(0), '0');
  assert.equal(fmtNum(1234567), '1,234,567');
});

test('parseSize: empty means "no value" (0), unparseable means null', () => {
  // the distinction F17 turns on: a typo must not read as "unbounded"
  assert.equal(parseSize(''), 0);
  assert.equal(parseSize('   '), 0);
  assert.equal(parseSize(undefined), 0);
  assert.equal(parseSize('abc'), null);
  assert.equal(parseSize('12x'), null);
  assert.equal(parseSize('0xzz'), null);
  assert.equal(parseSize('1k2'), null);
});

test('parseSize: known quirk — repeated dots parse as their leading number', () => {
  // `[\d.]+` accepts "1..2", and parseFloat stops at the second dot. Pinned
  // as current behavior, not endorsed: it is a rejection the format arguably
  // should make, and changing it is a behavior change with its own commit.
  assert.equal(parseSize('1..2'), 1);
});

test('parseSize: plain, suffixed, hex and exponent forms', () => {
  assert.equal(parseSize('512'), 512);
  assert.equal(parseSize('1k'), 1024);
  assert.equal(parseSize('1kb'), 1024);
  assert.equal(parseSize('1kib'), 1024);
  assert.equal(parseSize('2K'), 2048);
  assert.equal(parseSize('1m'), 1024 ** 2);
  assert.equal(parseSize('1g'), 1024 ** 3);
  assert.equal(parseSize('1t'), 1024 ** 4);
  assert.equal(parseSize('1.5k'), 1536);
  assert.equal(parseSize(' 4 k '), 4096);
  assert.equal(parseSize('0x1000'), 4096);
  assert.equal(parseSize('1e6'), 1e6);
  assert.equal(parseSize('1e+3'), 1000);
});

test('esc: escapes exactly the four characters that break attributes', () => {
  assert.equal(esc('<b>&"'), '&lt;b&gt;&amp;&quot;');
  assert.equal(esc("it's fine"), "it's fine"); // apostrophes are not escaped
  assert.equal(esc(42), '42');
  assert.equal(esc(null), 'null');
});

// clampView is the one function both threads run on the same input: the main
// thread's optimistic local zoom has to land where the worker's authoritative
// clamp lands. These pin the contract that agreement rests on.
test('clampView: a view inside the bounds is returned unchanged', () => {
  assert.deepEqual(clampView({ lo: 20, hi: 80 }, 0, 100, 1), { lo: 20, hi: 80 });
});

test('clampView: a span narrower than minSpan is widened from lo', () => {
  assert.deepEqual(clampView({ lo: 50, hi: 50 }, 0, 100, 10), { lo: 50, hi: 60 });
  assert.deepEqual(clampView({ lo: 50, hi: 52 }, 0, 100, 10), { lo: 50, hi: 60 });
});

test('clampView: a span at least as wide as the bounds snaps to the full range', () => {
  assert.deepEqual(clampView({ lo: -50, hi: 500 }, 0, 100, 1), { lo: 0, hi: 100 });
  assert.deepEqual(clampView({ lo: 0, hi: 100 }, 0, 100, 1), { lo: 0, hi: 100 });
});

test('clampView: degenerate bounds still honor minSpan', () => {
  assert.deepEqual(clampView({ lo: 0, hi: 0 }, 5, 5, 10), { lo: 5, hi: 15 });
});

test('clampView: overshoot slides the window, preserving the span', () => {
  assert.deepEqual(clampView({ lo: -10, hi: 10 }, 0, 100, 1), { lo: 0, hi: 20 });
  assert.deepEqual(clampView({ lo: 95, hi: 115 }, 0, 100, 1), { lo: 80, hi: 100 });
});

test('clampView: widening then sliding compose in one call', () => {
  // too narrow *and* past the top edge: widen to minSpan, then slide inside
  assert.deepEqual(clampView({ lo: 99, hi: 99.5 }, 0, 100, 10), { lo: 90, hi: 100 });
});

test('clampView: is idempotent', () => {
  const cases = [
    [{ lo: -10, hi: 10 }, 0, 100, 1],
    [{ lo: 99, hi: 99.5 }, 0, 100, 10],
    [{ lo: -50, hi: 500 }, 0, 100, 1],
    [{ lo: 20, hi: 80 }, 0, 100, 1],
  ];
  for (const [v, min, max, minSpan] of cases) {
    const once = clampView(v, min, max, minSpan);
    assert.deepEqual(clampView(once, min, max, minSpan), once);
  }
});
