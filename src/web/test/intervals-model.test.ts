// The interval panels' pure logic (src/web/intervals/intervals-model.ts):
// durations, track ordering, the open-span tree, and the list's query state.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LIST_QUERY, fmtDur, fmtRecords, listParams, normalizeListQuery, orderStateThreads, orderTracks,
  pageFor, parseDur, rowPosition, sameSelection, seekSeqFor, spanTree, threadKey, threadLabel, trackParams,
} from '../intervals/intervals-model.ts';
import type { StateSpan } from '../intervals/types.ts';

test('durations read in the largest sensible unit', () => {
  assert.equal(fmtDur(850, 'ns'), '850ns');
  assert.equal(fmtDur(1250, 'ns'), '1.25µs');
  assert.equal(fmtDur(12_500_000, 'ns'), '12.5ms');
  assert.equal(fmtDur(3.2, 's'), '3.2s');
  assert.equal(fmtDur(1500, 'us'), '1.5ms');
  assert.equal(fmtDur(125, 's'), '2m05s');
  assert.equal(fmtDur(0, 'ns'), '0ns');
  assert.equal(fmtDur(-4, 'ns'), '0ns');
  assert.equal(fmtDur(42, 'ticks'), '42 ticks');
  assert.equal(fmtDur(NaN, 'ns'), '—');
  assert.equal(fmtRecords(1), '1 record');
  assert.equal(fmtRecords(1204), '1,204 records');
});

test('a duration typed in the filter box becomes trace units', () => {
  assert.equal(parseDur('', 'ns'), 0);
  assert.equal(parseDur('250', 'us'), 250);
  assert.equal(parseDur('1.5ms', 'ns'), 1_500_000);
  assert.equal(parseDur('2 s', 'ms'), 2000);
  assert.equal(parseDur('250µs', 'us'), 250);
  assert.equal(parseDur('3ms', 'ticks'), null);
  assert.equal(parseDur('fast', 'ns'), null);
});

test('tracks: threads by process then id, empty ones dropped, CPUs by number', () => {
  const o = orderTracks(
    [
      { thr: 3, pid: 7, name: 'b', calls: 1, spans: 0 },
      { thr: 1, pid: 7, name: 'a', calls: 0, spans: 2 },
      { thr: 9, name: 'main', calls: 5, spans: 0 },
      { thr: 2, pid: 4, name: 'idle', calls: 0, spans: 0 },
      { thr: 1, pid: 4, name: 'x', calls: 1, spans: 0 },
    ],
    [{ cpu: 2, slices: 3 }, { cpu: 0, slices: 1 }, { cpu: 1, slices: 0 }],
  );
  assert.deepEqual(o.threads.map(threadKey), ['thr:9', 'thr:4:1', 'thr:7:1', 'thr:7:3']);
  assert.deepEqual(o.cpus.map((c) => c.cpu), [0, 2]);
  assert.deepEqual(orderStateThreads([{ thr: 2, name: '', stack: [] }, { thr: 1, name: '', stack: [] }]).map((t) => t.thr), [1, 2]);
});

test('track keys round-trip into query parameters', () => {
  assert.deepEqual(trackParams(threadKey({ thr: 3 })), { thr: 3 });
  assert.deepEqual(trackParams(threadKey({ thr: 3, pid: 7 })), { pid: 7, thr: 3 });
  assert.deepEqual(trackParams('cpu:5'), { cpu: 5 });
  assert.deepEqual(trackParams(''), {});
  assert.equal(threadLabel({ thr: 1, pid: 7, name: 'worker' }), 'worker (pid 7 · thr 1)');
  assert.equal(threadLabel({ thr: 1, name: '1' }), 'thr 1');
});

const span = (ivl: number, seq: number, parent: number | null, id = `s${ivl}`): StateSpan => ({
  ivl, span: id, name: `n${ivl}`, depth: 0, seq, thr: 1, parent, parentSpan: parent === null ? null : `s${parent}`,
});

test('open spans form a parent tree in begin order; a closed parent leaves an orphan root', () => {
  const tree = spanTree([span(1, 10, null), span(4, 40, 1), span(2, 20, 1), span(3, 30, 2), span(5, 50, 99)]);
  assert.deepEqual(tree.map((n) => [n.span.ivl, n.indent, n.orphan]), [
    [1, 0, false], [2, 1, false], [3, 2, false], [4, 1, false], [5, 0, true],
  ]);
  // a cycle (malformed input) still lists every span once
  const cyc = spanTree([span(1, 1, 2), span(2, 2, 1)]);
  assert.deepEqual(cyc.map((n) => n.span.ivl).sort(), [1, 2]);
});

test('the list query: normalized, and only what is set is sent', () => {
  const q = normalizeListQuery({ category: 'span', track: 'thr:7:1', text: '  req ', minDur: 500 });
  assert.deepEqual(listParams(q), { category: 'span', pid: 7, thr: 1, text: 'req', minDur: 500 });
  assert.deepEqual(listParams(DEFAULT_LIST_QUERY), {});
  const bad = normalizeListQuery({ category: 'heap' as any, track: 'bogus', minDur: -3 });
  assert.deepEqual([bad.category, bad.track, bad.minDur], ['', '', 0]);
  assert.ok(sameSelection(q, { ...q, desc: true }));
  assert.ok(!sameSelection(q, { ...q, text: 'x' }));
});

test('newest-first pages read the mirrored range', () => {
  assert.deepEqual(pageFor({ desc: false }, 100, 10, 20), { from: 10, count: 20, reverse: false });
  assert.deepEqual(pageFor({ desc: true }, 100, 0, 20), { from: 80, count: 20, reverse: true });
  assert.deepEqual(pageFor({ desc: true }, 100, 90, 20), { from: 0, count: 10, reverse: true });
});

test('rows relative to the playhead, and seeking opens the interval', () => {
  // applied = 10: records 0..9 are applied
  assert.equal(rowPosition({ seq: 10, end: 20 }, 10), 'future');
  assert.equal(rowPosition({ seq: 9, end: 10 }, 10), 'open');
  assert.equal(rowPosition({ seq: 3, end: null }, 10), 'open');
  assert.equal(rowPosition({ seq: 3, end: 9 }, 10), 'past');
  assert.equal(seekSeqFor(9), 10);
  assert.equal(rowPosition({ seq: 9, end: 12 }, seekSeqFor(9)), 'open');
});
