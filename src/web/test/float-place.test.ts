// Where a floating window opens (shell/float-place.ts): beside the point the
// user acted on, clear of the windows already floating, inside the area.

import test from 'node:test';
import assert from 'node:assert/strict';

import { placeFloat, clampBox, fitSize, GAP, TITLE, type Box } from '../shell/float-place.ts';

const area = { width: 1000, height: 700 };
const size = { width: 360, height: 420 };
const overlap = (a: Box, b: Box) => a.left < b.left + b.width && b.left < a.left + a.width
  && a.top < b.top + b.height && b.top < a.top + a.height;
const inside = (b: Box) => b.left >= 0 && b.top >= 0 && b.left + b.width <= area.width && b.top + b.height <= area.height;

test('with no anchor and nothing floating, it takes the corner it asks for', () => {
  assert.deepEqual(placeFloat({ area, size }), { left: GAP, top: area.height - size.height - GAP, ...size });
  assert.deepEqual(placeFloat({ area, size, corner: 'top-right' }), { left: area.width - size.width - GAP, top: GAP, ...size });
});

test('beside an anchor: to its right, never covering it, inside the area', () => {
  const b = placeFloat({ area, size, anchor: { x: 200, y: 300 } });
  assert.equal(b.left, 200 + 2 * GAP);
  assert.ok(inside(b));
  // near the right edge it flips to the left of the point
  const r = placeFloat({ area, size, anchor: { x: 900, y: 300 } });
  assert.ok(r.left + r.width <= 900 - GAP, JSON.stringify(r));
  assert.ok(inside(r));
});

test('it does not land on windows already floating', () => {
  const big = { width: 1600, height: 1000 };
  const others: Box[] = [];
  for (let i = 0; i < 3; i++) {
    const b = placeFloat({ area: big, size, others, anchor: { x: 700, y: 450 } });
    for (const o of others) assert.ok(!overlap(b, o), `${JSON.stringify(b)} overlaps ${JSON.stringify(o)}`);
    assert.ok(b.left + b.width <= big.width && b.top + b.height <= big.height);
    others.push(b);
  }
});

test('with no free room it cascades: the windows below keep their title strips in sight', () => {
  const others: Box[] = [];
  for (let i = 0; i < 4; i++) {
    const b = placeFloat({ area, size, others, anchor: { x: 500, y: 350 } });
    assert.ok(inside(b), JSON.stringify(b));
    for (const o of others) {
      assert.ok(!overlap(b, { ...o, height: TITLE }), `window ${i} ${JSON.stringify(b)} hides the title of ${JSON.stringify(o)}`);
    }
    others.push(b);
  }
});

test('a window larger than the area is fitted to it; a box is clamped into it', () => {
  const small = { width: 300, height: 200 };
  const f = fitSize({ width: 360, height: 420 }, small);
  assert.ok(f.width <= small.width && f.height <= small.height);
  assert.deepEqual(clampBox({ left: 900, top: -20, width: 360, height: 420 }, area), { left: 640, top: 0, width: 360, height: 420 });
});
