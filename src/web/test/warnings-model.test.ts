// Warnings grouped by domain (MODEL-005, IVL-006), with totals from
// `warnCounts` (21 codes) that stay exact past the list's cap.

import test from 'node:test';
import assert from 'node:assert/strict';

import { groupWarnings, warningDetail, warningDomain } from '../warnings-model.ts';

test('warnings group by domain in a fixed order, totals from warnCounts', () => {
  const warnings = [
    { seq: 9, code: 19, kind: 'double_run', domain: 'sched', msg: 'thread running on two CPUs', detail: 3, detailExact: '3' },
    { seq: 1, code: 4, kind: 'double_free', domain: 'heap', msg: 'double free' },
    { seq: 5, code: 12, kind: 'unmatched_end', domain: 'interval', msg: 'interval end matches no open interval' },
    { seq: 6, code: 14, kind: 'unclosed', domain: 'interval', msg: 'interval still open', detail: 2, detailExact: '2' },
  ];
  const counts = new Array(21).fill(0);
  counts[4] = 1; counts[12] = 5; counts[14] = 1; counts[19] = 1; counts[20] = 2;
  const groups = groupWarnings(warnings, counts);
  assert.deepEqual(groups.map((g) => [g.domain, g.total, g.rows.length]), [
    ['trace', 2, 0], // long_field (20): counted though none is listed
    ['heap', 1, 1],
    ['interval', 6, 2],
    ['sched', 1, 1],
  ]);
});

test('without warnCounts a group counts its rows; an older core\'s warning falls back by code', () => {
  assert.equal(warningDomain({ code: 16 }), 'interval');
  assert.equal(warningDomain({ code: 19 }), 'sched');
  assert.equal(warningDomain({ code: 9 }), 'log');
  const groups = groupWarnings([{ seq: 0, code: 3, msg: 'free of unknown id' }]);
  assert.deepEqual(groups.map((g) => [g.domain, g.total]), [['heap', 1]]);
});

test('details read per code', () => {
  assert.equal(warningDetail({ seq: 0, code: 13, msg: '', detailExact: '40' }), 'begin #40');
  assert.equal(warningDetail({ seq: 0, code: 19, msg: '', detailExact: '2' }), 'cpu 2');
  assert.equal(warningDetail({ seq: 0, code: 20, msg: '', detailExact: '2048' }), '2048 bytes');
  assert.equal(warningDetail({ seq: 0, code: 4, msg: '', detailExact: '7' }), '');
});
