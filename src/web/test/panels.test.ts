// The panel table is the single place a panel id is written; everything else
// derives its list from it. These tests pin the two properties the rest of the
// code leans on: every record is complete, and an id that is not in the table
// is an error rather than a build function that silently never runs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { heapPanels } from '../heap/panels.ts';

test('every record carries an id, a title, a default layout, and a build slot', () => {
  const panels = heapPanels();
  assert.ok(panels.length > 0);
  for (const p of panels) {
    assert.equal(typeof p.id, 'string');
    assert.ok(p.id.endsWith('-panel'), `${p.id} is not a panel id`);
    assert.ok(p.title.length > 0, `${p.id} has no title`);
    assert.ok(p.dock === null || p.dock === 'left' || p.dock === 'right');
    assert.equal(typeof p.open, 'boolean');
    assert.equal(p.build, null); // no builders supplied
  }
  assert.equal(new Set(panels.map((p) => p.id)).size, panels.length);
});

test('the panel table declares the complete default workspace', () => {
  const panels = heapPanels();
  assert.deepEqual(
    panels.filter((p) => p.dock === 'left').map((p) => [p.id, p.open]),
    [['events-panel', true]],
  );
  assert.deepEqual(
    panels.filter((p) => p.dock === 'right').map((p) => [p.id, p.open]),
    [
      ['layout-panel', true],
      ['appearance-panel', true],
      ['filter-panel', true],
      ['analysis-panel', true],
    ],
  );
  assert.deepEqual(
    panels.filter((p) => p.dock === null).map((p) => [p.id, p.open]),
    [['play-panel', false], ['warnings-panel', false]],
  );
});

test('builders attach by panel id, and an unknown id throws', () => {
  const build = () => {};
  const [first] = heapPanels();
  const panels = heapPanels({ [first.id]: build });
  assert.equal(panels.find((p) => p.id === first.id).build, build);
  assert.equal(panels.filter((p) => p.build).length, 1);

  assert.throws(() => heapPanels({ 'no-such-panel': build }), /no such panel/);
});
