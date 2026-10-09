// The panel table is the single place a panel id is written; everything else
// derives its list from it. These tests pin the two properties the rest of the
// code leans on: every record is complete, and an id that is not in the table
// is an error rather than a refill function that silently never runs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { heapPanels } from '../heap/panels.ts';

test('every record carries an id, a title, a default layout, and a refill slot', () => {
  const panels = heapPanels();
  assert.ok(panels.length > 0);
  for (const p of panels) {
    assert.equal(typeof p.id, 'string');
    assert.ok(p.title.length > 0, `${p.id} has no title`);
    assert.ok(p.dock === null || p.dock === 'left' || p.dock === 'right');
    assert.equal(typeof p.open, 'boolean');
    assert.equal(p.refill, null); // no refills supplied
  }
  assert.equal(new Set(panels.map((p) => p.id)).size, panels.length);
});

test('the panel table declares the complete default workspace', () => {
  const panels = heapPanels();
  assert.deepEqual(
    panels.filter((p) => p.dock === 'left').map((p) => [p.id, p.open]),
    [['events-panel', true], ['logs-panel', true]],
  );
  // ...but Logs opens only for a trace that has log records (LOG-007)
  assert.deepEqual(panels.filter((p) => p.needs).map((p) => [p.id, p.needs]), [['logs-panel', 'logs']]);
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
    panels.filter((p) => p.dock === null && p.persist !== false).map((p) => [p.id, p.open]),
    [['play-panel', false], ['warnings-panel', false]],
  );
});

test('the per-selection windows are declared, floating and closed, but not persisted', () => {
  const transient = heapPanels().filter((p) => p.persist === false);
  assert.deepEqual(transient.map((p) => p.id), ['detail-panel', 'pinned-detail', 'event-panel']);
  for (const p of transient) {
    assert.equal(p.dock, null);
    assert.equal(p.open, false);
  }
  assert.deepEqual(transient.filter((p) => p.multi).map((p) => p.id), ['pinned-detail']);
});

test('refills attach by panel id, and an unknown id throws', () => {
  const refill = () => {};
  const [first] = heapPanels();
  const panels = heapPanels({ [first.id]: refill });
  assert.equal(panels.find((p) => p.id === first.id).refill, refill);
  assert.equal(panels.filter((p) => p.refill).length, 1);

  assert.throws(() => heapPanels({ 'no-such-panel': refill }), /no such panel/);
});
