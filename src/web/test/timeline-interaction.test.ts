// The timeline gestures' math (src/web/timeline-interaction.ts, TL-004),
// shared by the strips and the Tracks panel: axis mapping, clamp, wheel zoom
// and pan, the shift+drag range, and the playhead's paint.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAYHEAD, WHEEL_PAN_STEP, axisBounds, clampAxis, paintPlayhead, panBy, selectionRange, valAt, wheelView, xOf, zoomAt,
} from '../timeline-interaction.ts';

test('the axis maps values to pixels and back', () => {
  const v = { lo: 100, hi: 300 };
  assert.equal(xOf(200, v, 400), 200);
  assert.equal(xOf(100, v, 400), 0);
  assert.equal(valAt(400, v, 400), 300);
  assert.equal(valAt(xOf(250, v, 800), v, 800), 250);
  assert.equal(valAt(10, v, 0), 100); // a view with no width does not divide by zero
});

test('views clamp to the axis as the worker does', () => {
  const meta = { n: 1000, tMin: 50, tMax: 150 };
  assert.deepEqual(axisBounds('seq', meta), { lo: 0, hi: 1000, minSpan: 4 });
  assert.deepEqual(axisBounds('t', meta), { lo: 50, hi: 150, minSpan: 1e-9 });
  assert.deepEqual(axisBounds('t', { tMin: 5, tMax: 5 }), { lo: 5, hi: 6, minSpan: 1e-9 });
  assert.deepEqual(clampAxis({ lo: -10, hi: 90 }, axisBounds('seq', meta)), { lo: 0, hi: 100 });
  assert.deepEqual(clampAxis({ lo: 0, hi: 5000 }, axisBounds('t', meta)), { lo: 50, hi: 150 });
  assert.deepEqual(clampAxis({ lo: 10, hi: 11 }, axisBounds('seq', meta)), { lo: 10, hi: 14 });
});

test('zoom keeps the value under the pointer; pan moves with the drag', () => {
  const v = { lo: 0, hi: 100 };
  const z = zoomAt(v, 100, 400, 0.5); // pointer at value 25
  assert.equal(valAt(100, z, 400), 25);
  assert.equal(z.hi - z.lo, 50);
  assert.deepEqual(panBy(v, 40, 400), { lo: -10, hi: 90 });
});

test('a wheel zooms about the pointer, in for up and out for down', () => {
  const v = { lo: 0, hi: 1000 };
  const zin = wheelView(v, { deltaY: -100 }, 250, 1000);
  assert.ok(zin.hi - zin.lo < 1000);
  assert.ok(Math.abs(valAt(250, zin, 1000) - 250) < 1e-9);
  const zout = wheelView(v, { deltaY: 100 }, 250, 1000);
  assert.ok(zout.hi - zout.lo > 1000);
  // in then out by the same notch is the identity
  const back = wheelView(zin, { deltaY: 100 }, 250, 1000);
  assert.ok(Math.abs(back.lo - v.lo) < 1e-9 && Math.abs(back.hi - v.hi) < 1e-9);
});

test('shift+wheel pans one step of the span, whichever delta carries it', () => {
  const v = { lo: 100, hi: 200 };
  const step = 100 * WHEEL_PAN_STEP;
  assert.deepEqual(wheelView(v, { deltaY: 3, shiftKey: true }, 0, 500), { lo: 100 + step, hi: 200 + step });
  assert.deepEqual(wheelView(v, { deltaY: -120, shiftKey: true }, 0, 500), { lo: 100 - step, hi: 200 - step });
  // a browser that turns shift+wheel into a horizontal wheel
  assert.deepEqual(wheelView(v, { deltaY: 0, deltaX: 120, shiftKey: true }, 0, 500), { lo: 100 + step, hi: 200 + step });
  assert.deepEqual(wheelView(v, { deltaY: 0, deltaX: 0, shiftKey: true }, 0, 500), v);
});

test('a shift+drag selects low end first, whichever way it went', () => {
  const v = { lo: 0, hi: 100 };
  assert.deepEqual(selectionRange(v, 200, 150, 50), { lo: 25, hi: 75 });
  assert.deepEqual(selectionRange(v, 200, 50, 150), { lo: 25, hi: 75 });
});

test('the playhead paints the played tint, the line and the grab triangle', () => {
  const ops: string[] = [];
  const g = {
    fillStyle: '' as any,
    fillRect(x: number, y: number, w: number, h: number) { ops.push(`rect ${this.fillStyle} ${x} ${y} ${w} ${h}`); },
    beginPath() { ops.push('begin'); },
    moveTo(x: number, y: number) { ops.push(`move ${x} ${y}`); },
    lineTo(x: number, y: number) { ops.push(`line ${x} ${y}`); },
    fill() { ops.push(`fill ${this.fillStyle}`); },
  };
  paintPlayhead(g, 50, 0, 80, 2);
  assert.deepEqual(ops, [
    `rect ${PLAYHEAD.played} 0 0 50 80`,
    `rect ${PLAYHEAD.line} 49 0 3 80`,
    'begin', 'move 42 0', 'line 58 0', 'line 50 10', `fill ${PLAYHEAD.line}`,
  ]);
});
