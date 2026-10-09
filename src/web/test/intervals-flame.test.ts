// The Tracks panel's geometry (src/web/intervals/flame-model.ts): the axis,
// zoom and pan, the group stack and its vertical window, bars and culling,
// and hit testing.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GROUP_GAP, HEAD_H, ROW_H, axisBounds, axisTicks, clampAxis, colorKey, colorSlot, depthsOf, groupAt,
  hitBar, laneAt, layoutBars, layoutGroups, mergeDepths, panBy, valAt, visibleGroups, windowCovers, windowFor, xOf, zoomAt,
} from '../intervals/flame-model.ts';
import type { WindowRow } from '../intervals/types.ts';

const row = (over: Partial<WindowRow>): WindowRow => ({
  ivl: 0, name: 'f', category: 'call', depth: 0, start: 0, end: 10, open: false, lane: 'call', ...over,
});

test('the axis maps values to pixels and back', () => {
  const v = { lo: 100, hi: 300 };
  assert.equal(xOf(200, v, 400), 200);
  assert.equal(xOf(100, v, 400), 0);
  assert.equal(valAt(400, v, 400), 300);
  assert.equal(valAt(xOf(250, v, 800), v, 800), 250);
});

test('zoom keeps the value under the pointer; pan moves with the drag', () => {
  const v = { lo: 0, hi: 100 };
  const z = zoomAt(v, 100, 400, 0.5); // pointer at value 25
  assert.equal(valAt(100, z, 400), 25);
  assert.equal(z.hi - z.lo, 50);
  const p = panBy(v, 40, 400); // content right by a tenth: view left by 10
  assert.deepEqual(p, { lo: -10, hi: 90 });
});

test('views clamp to the axis as the strips do', () => {
  const meta = { n: 1000, tMin: 50, tMax: 150 };
  assert.deepEqual(axisBounds('seq', meta), { lo: 0, hi: 1000, minSpan: 4 });
  assert.deepEqual(clampAxis({ lo: -10, hi: 90 }, axisBounds('seq', meta)), { lo: 0, hi: 100 });
  assert.deepEqual(clampAxis({ lo: 0, hi: 5000 }, axisBounds('t', meta)), { lo: 50, hi: 150 });
  assert.deepEqual(clampAxis({ lo: 10, hi: 11 }, axisBounds('seq', meta)), { lo: 10, hi: 14 });
});

test('ticks land on a 1/2/5 grid inside the view', () => {
  const t = axisTicks({ lo: 3, hi: 1003 }, 1000, 100);
  assert.deepEqual(t.slice(0, 3), [100, 200, 300]);
  assert.ok(t.every((v) => v >= 3 && v <= 1003));
  assert.deepEqual(axisTicks({ lo: 0, hi: 0 }, 100), []);
});

test('groups stack a head, call rows by depth, then span rows; CPUs under a heading', () => {
  const depths = new Map([['thr:1', { call: 3, span: 0 }]]);
  const L = layoutGroups(
    [{ thr: 1, name: 'main', calls: 4, spans: 2 }, { thr: 2, name: 'w', calls: 0, spans: 1 }],
    [{ cpu: 0, slices: 3 }],
    depths,
  );
  const [a, b, head, cpu] = L.groups;
  assert.equal(a.callRows, 3);
  assert.equal(a.spanRows, 1); // spans but no depth seen yet: one row
  assert.equal(a.height, HEAD_H + 4 * ROW_H + GROUP_GAP);
  assert.equal(a.spanTop, a.top + HEAD_H + 3 * ROW_H);
  assert.equal(b.top, a.height);
  assert.equal(b.callRows, 0);
  assert.equal(head.kind, 'heading');
  assert.equal(cpu.kind, 'cpu');
  assert.equal(L.height, cpu.top + cpu.height);
  assert.deepEqual(laneAt(a, a.callTop + 2 * ROW_H + 1), { lane: 'call', depth: 2 });
  assert.deepEqual(laneAt(a, a.spanTop + 1), { lane: 'span', depth: 0 });
  assert.equal(laneAt(a, a.top + 1), null);
});

test('only the groups in the viewport are visible (virtualized)', () => {
  const threads = Array.from({ length: 1000 }, (_, i) => ({ thr: i, name: `t${i}`, calls: 1, spans: 0 }));
  const L = layoutGroups(threads, [], new Map());
  const gh = HEAD_H + ROW_H + GROUP_GAP;
  const vis = visibleGroups(L.groups, 10 * gh + 5, 3 * gh);
  assert.deepEqual(vis.map((g) => g.thr), [10, 11, 12, 13]);
  assert.equal(groupAt(L.groups, 500 * gh + 1).thr, 500);
  assert.equal(groupAt(L.groups, L.height + 5), null);
});

test('depths grow from windows and never shrink', () => {
  const d = depthsOf([row({ depth: 2 }), row({ lane: 'span', depth: 0 }), row({ cpu: 1, depth: 9 })]);
  assert.deepEqual(d, { call: 3, span: 1 });
  assert.deepEqual(mergeDepths({ call: 5, span: 0 }, d), { call: 5, span: 1 });
});

test('bars clip to the canvas and drop what is off it', () => {
  const v = { lo: 0, hi: 100 };
  const { bars } = layoutBars([
    row({ start: -50, end: 50 }), row({ start: 150, end: 160 }), row({ start: 90, end: 500, depth: 1 }),
  ], v, 100);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].x, -1);
  assert.equal(bars[0].x + bars[0].w, 50);
  assert.equal(bars[1].x + bars[1].w, 101);
});

test('sub-pixel bars in one row fold into a run (culling at width)', () => {
  const v = { lo: 0, hi: 10_000 };
  const tiny = Array.from({ length: 100 }, (_, i) => row({ ivl: i, start: i * 2, end: i * 2 + 1 }));
  const { bars, merged } = layoutBars([...tiny, row({ ivl: 999, start: 5000, end: 6000 })], v, 1000);
  assert.equal(bars.length, 2);
  assert.equal(merged, 99);
  assert.equal(bars[0].merged, 99);
  assert.ok(bars[0].w >= 1);
  // a wide bar is never folded
  assert.equal(bars[1].row.ivl, 999);
  assert.equal(bars[1].w, 100);
});

test('hit testing finds the bar in its lane row', () => {
  const { bars } = layoutBars([row({ ivl: 1, start: 0, end: 50 }), row({ ivl: 2, start: 10, end: 20, depth: 1 })], { lo: 0, hi: 100 }, 100);
  assert.equal(hitBar(bars, 'call', 0, 30).row.ivl, 1);
  assert.equal(hitBar(bars, 'call', 1, 15).row.ivl, 2);
  assert.equal(hitBar(bars, 'call', 1, 40), null);
  assert.equal(hitBar(bars, 'span', 0, 30), null);
});

test('colors: calls by name, slices by thread, stable', () => {
  assert.equal(colorKey(row({ name: 'parse' })), 'call:parse');
  assert.equal(colorKey(row({ cpu: 0, thr: 4, name: 'worker' })), 'thr:4');
  assert.equal(colorKey(row({ cpu: 0, idle: true })), '');
  assert.equal(colorSlot('call:parse', 12), colorSlot('call:parse', 12));
  assert.ok(colorSlot('x', 12) < 12);
});

test('a fetched window serves pans within its margin, not a new zoom or axis', () => {
  const v = { lo: 100, hi: 200 };
  const f = windowFor('t', v, 400);
  assert.deepEqual(f, { axis: 't', lo: 50, hi: 250, width: 800 });
  assert.ok(windowCovers(f, 't', { lo: 140, hi: 240 }, 400));
  assert.ok(!windowCovers(f, 't', { lo: 160, hi: 260 }, 400)); // past the margin
  assert.ok(!windowCovers(f, 't', { lo: 120, hi: 170 }, 400)); // zoomed in 2x
  assert.ok(!windowCovers(f, 'seq', v, 400));
  assert.ok(!windowCovers(f, 't', v, 500));
  assert.ok(!windowCovers(null, 't', v, 400));
});
