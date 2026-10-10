import assert from 'node:assert/strict';
import test from 'node:test';

import {
  edgeSelection, intervalSelection, isEdgeRow, isSelected, resolved, sameSelection, selectedEdges, selectionQuery,
} from '../intervals/selection.ts';
import { fmtOffset, intervalKind, intervalWindowBody, intervalWindowTitle } from '../intervals/interval-window.ts';
import { layoutGroups, scrollToRow, selectedBox, viewToShow, ROW_H } from '../intervals/flame-model.ts';
import type { IntervalRow } from '../intervals/types.ts';

const CALL: IntervalRow = {
  row: 0, ivl: 12, category: 'call', name: 'parse_body', seq: 100, end: 140, t: 2000, endT: 2600, dur: 600,
  open: false, depth: 2, parent: 9, thr: 1, pid: 7, fields: { route: '/upload' }, endFields: { status: 200 },
};
const SPAN: IntervalRow = {
  ...CALL, ivl: 13, category: 'span', name: 'request', depth: 0, parent: null, span: 'r42', parentSpan: null,
  end: null, endT: null, open: true, endThr: null, fields: null, endFields: null,
};
const SLICE: IntervalRow = {
  ...CALL, ivl: 3, category: 'sched', name: 'worker', cpu: 2, idle: false, thr: 2, depth: 0, parent: null,
  fields: null, endFields: null,
};
const thread = (thr: number | null | undefined) => (thr === 1 ? 'main' : `t${thr}`);

test('an edge selection is resolved by edge, an interval one by id', () => {
  const e = edgeSelection(70777, { x: 5, y: 6 });
  assert.deepEqual(e, { ivl: null, seq: 70777, at: { x: 5, y: 6 } });
  assert.deepEqual(selectionQuery(e), { edge: 70777 });
  assert.deepEqual(selectionQuery(intervalSelection(12)), { ivl: 12 });
  assert.equal(selectionQuery({ ivl: null }), null);
  assert.ok(isEdgeRow('intervals'));
  assert.ok(!isEdgeRow('heap') && !isEdgeRow(undefined));
});

test('a resolved selection carries the interval and its edges, and marks them', () => {
  const r = resolved(edgeSelection(140), CALL);
  assert.deepEqual({ ivl: r.ivl, seq: r.seq, begin: r.begin, end: r.end }, { ivl: 12, seq: 140, begin: 100, end: 140 });
  assert.deepEqual([...selectedEdges(r)].sort((a, b) => a - b), [100, 140]);
  assert.deepEqual([...selectedEdges(resolved(intervalSelection(13), SPAN))], [100], 'an open interval has one edge');
  assert.equal(selectedEdges(null).size, 0);
  assert.ok(isSelected(r, 12));
  assert.ok(!isSelected(r, 13) && !isSelected(null, 12) && !isSelected(edgeSelection(5), undefined));
  assert.ok(sameSelection(r, intervalSelection(12)));
  assert.ok(!sameSelection(edgeSelection(1), edgeSelection(2)));
  assert.ok(sameSelection(null, null) && !sameSelection(null, r));
});

test('the Interval window names the interval and links its edges and parent', () => {
  assert.equal(intervalWindowTitle(CALL), 'Call · parse_body');
  assert.equal(intervalWindowTitle(SPAN), 'Span · request');
  assert.equal(intervalWindowTitle(SLICE), 'CPU 2 · worker');
  assert.equal(intervalWindowTitle({ ...SLICE, idle: true }), 'CPU 2 · idle');
  assert.equal(intervalWindowTitle(null), 'Interval');
  assert.equal(intervalKind(SLICE), 'CPU run slice');
  // times to the trace's resolution: a 5 ns call's two ends differ
  assert.equal(fmtOffset(4332512, 'ns'), '+0.004332512s');
  assert.equal(fmtOffset(4332, 'us'), '+0.004332s');
  assert.equal(fmtOffset(17, undefined), '+0.000000017s');
  assert.equal(fmtOffset(17, 'ticks'), '+17');

  const html = intervalWindowBody(CALL, { unit: 'ns', t0: 1000, thread, parent: { ...CALL, ivl: 9, name: 'handle_upload' } });
  assert.match(html, /<span class="k">kind<\/span><span>call<\/span>/);
  assert.match(html, /<span class="k">thread<\/span><span>main<\/span>/);
  // begin and end seek to just after their record
  assert.match(html, /data-seek="101"[^>]*>seq 100<\/a> <span class="dim">\+0\.000001000s/);
  assert.match(html, /data-seek="141"[^>]*>seq 140<\/a>/);
  assert.match(html, /<span class="k">duration<\/span><span>600ns<\/span>/);
  assert.match(html, /<span class="k">depth<\/span><span>2<\/span>/);
  assert.match(html, /data-ivl="9"[^>]*>handle_upload<\/a>/);
  assert.match(html, /fields at begin.*route.*\/upload/s);
  assert.match(html, /fields at end.*status.*200/s);
});

test('an open span says so, with its id; a slice shows its CPU and thread, no depth', () => {
  const span = intervalWindowBody(SPAN, { unit: 'ns', thread });
  assert.match(span, /still open/);
  assert.match(span, /duration<\/span><span>≥ 600ns/);
  assert.match(span, /span id<\/span><span>r42/);
  assert.match(span, /none \(a root\)/);
  assert.doesNotMatch(span, /ended on|fields at/);
  assert.match(intervalWindowBody({ ...SPAN, open: false, end: 150, endT: 2700, endThr: 2 }, { thread }), /ended on<\/span><span>t2/);
  const slice = intervalWindowBody(SLICE, { thread });
  assert.match(slice, /<span class="k">cpu<\/span><span>2<\/span>/);
  assert.match(slice, /<span class="k">thread<\/span><span>t2<\/span>/);
  assert.doesNotMatch(slice, /depth|parent/);
  assert.match(intervalWindowBody({ ...CALL, name: '<b>' }, { thread }), /&lt;b&gt;/);
});

test('Tracks finds the selected interval\'s row, and brings it into view', () => {
  const { groups } = layoutGroups(
    [{ thr: 1, pid: 7, name: 'main', calls: 3, spans: 1 }],
    [{ cpu: 2, slices: 4 }],
    new Map([['thr:7:1', { call: 3, span: 1 }]]),
  );
  const main = groups.find((g) => g.key === 'thr:7:1');
  assert.deepEqual(selectedBox(groups, CALL, 't', 9000), { key: 'thr:7:1', y: main.callTop + 2 * ROW_H, lo: 2000, hi: 2600 });
  assert.deepEqual(selectedBox(groups, SPAN, 'seq', 5000), { key: 'thr:7:1', y: main.spanTop, lo: 100, hi: 5000 }, 'open: to the end');
  assert.equal(selectedBox(groups, SLICE, 't', 0).key, 'cpu:2');
  assert.equal(selectedBox(groups, { ...CALL, thr: 99 }, 't', 0), null);

  assert.equal(scrollToRow(100, 50, 200), null, 'in view');
  assert.equal(scrollToRow(600, 0, 200), 600 - (200 - ROW_H) / 2);
  const v = { lo: 0, hi: 100 };
  assert.equal(viewToShow(v, 50, 60), v);
  assert.deepEqual(viewToShow(v, 500, 510), { lo: 455, hi: 555 });
  assert.deepEqual(viewToShow(v, 1000, 2000), { lo: 900, hi: 2100 });
  assert.deepEqual(viewToShow(v, 1, 3, 10), { lo: -48, hi: 52 }, 'under the gutter is out of view');
});
