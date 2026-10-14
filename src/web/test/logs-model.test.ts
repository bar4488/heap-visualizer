// The Logs panel's pure logic (src/web/logs/logs-model.ts): levels, the
// virtual-list window, follow and playhead math, query state, and the text a
// line becomes. The DOM half (logs-panel.ts) is thin over these.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEVELS, LOG_MAX_SPACER, LOG_PAGE_MAX, LOG_ROW, OP_LOG, countAtLeast, firstRow, firstRowFor,
  fmtFieldValue, fmtRelTime, followTarget, formatLogLine, isScrollKey, levelBadge, levelIndex,
  levelName, lineState, logLayout, logStatusText, logsHoverText, normalizeQuery, playheadSeq,
  rowFullyVisible, rowWindow, sameQuery, scrollTopForFirst, shownLabel,
} from '../logs/logs-model.ts';
import type { LogRow, LogsMeta } from '../protocol.ts';

const row = (over: Partial<LogRow> = {}): LogRow => ({
  row: 0, seq: 10, t: 1500, thr: 2, level: 3, logger: 'net.http', msg: 'retrying request', fields: null, ...over,
});

test('the log op code follows E in the engine\'s numbering', () => {
  assert.equal(OP_LOG, 4);
});

test('levels: numbers pass through, names and aliases map, anything else is info', () => {
  assert.deepEqual([...LEVELS], ['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  for (let i = 0; i < 6; i++) assert.equal(levelIndex(i), i);
  assert.equal(levelIndex('WARN'), 3);
  assert.equal(levelIndex('warning'), 3);
  assert.equal(levelIndex('err'), 4);
  assert.equal(levelIndex('Fatal'), 5);
  assert.equal(levelIndex('verbose'), 2);
  assert.equal(levelIndex(9), 2);
  assert.equal(levelIndex(1.5), 2);
  assert.equal(levelIndex(undefined), 2);
  assert.equal(levelName(4), 'error');
  // fixed width, so messages after it line up
  assert.equal(levelBadge(3), 'WARN ');
  assert.equal(levelBadge(4), 'ERROR');
  assert.equal(levelBadge(0).length, 5);
});

test('query state: clamped level, trimmed text, compared by value', () => {
  assert.deepEqual(normalizeQuery({ minLevel: 9, text: '  timeout ' }), { minLevel: 5, text: 'timeout' });
  assert.deepEqual(normalizeQuery({ minLevel: -1 }), { minLevel: 0, text: '' });
  assert.deepEqual(normalizeQuery({ minLevel: Number.NaN, text: undefined }), { minLevel: 0, text: '' });
  assert.ok(sameQuery({ minLevel: 2, text: 'a' }, normalizeQuery({ minLevel: 2, text: ' a ' })));
  assert.ok(!sameQuery({ minLevel: 2, text: 'a' }, { minLevel: 3, text: 'a' }));
});

test('countAtLeast sums the per-level counts at and above the minimum', () => {
  const meta: LogsMeta = { count: 21, byLevel: [1, 2, 10, 5, 3, 0], loggers: [] };
  assert.equal(countAtLeast(meta, 0), 21);
  assert.equal(countAtLeast(meta, 3), 8);
  assert.equal(countAtLeast(meta, 5), 0);
  assert.equal(countAtLeast(null, 0), 0);
});

test('the heading reads shown / total with grouping', () => {
  assert.equal(shownLabel(1234, 56789), '1,234 / 56,789');
  assert.equal(shownLabel(0, 3), '0 / 3');
});

test('layout: rows to cover the viewport, the spacer capped like Events', () => {
  const L = logLayout(1000, 180);
  assert.equal(L.spacerH, 1000 * LOG_ROW);
  assert.equal(L.visN, 11); // 10 whole lines + 1 partly shown
  assert.equal(L.maxFrom, 990);
  assert.equal(logLayout(1e9, 180).spacerH, LOG_MAX_SPACER);
  assert.equal(logLayout(0, 180).spacerH, 0);
  // never more than one LOG-004 page in view
  assert.equal(logLayout(1e6, 1e5).visN, LOG_PAGE_MAX);
});

test('first row and scrollTop are inverses, also past the spacer cap', () => {
  for (const n of [50, 1000, 5e6]) {
    const L = logLayout(n, 180);
    for (const from of [0, 1, Math.floor(L.maxFrom / 2), L.maxFrom]) {
      assert.equal(firstRow(L, scrollTopForFirst(L, from)), from, `n=${n} from=${from}`);
    }
  }
  const L = logLayout(1000, 180);
  assert.equal(firstRow(L, -50), 0);
  assert.equal(firstRow(L, 1e9), L.maxFrom);
});

test('the fetch window never runs past the end of the matches', () => {
  const L = logLayout(25, 180);
  assert.deepEqual(rowWindow(L, 0), { from: 0, count: 11 });
  assert.deepEqual(rowWindow(L, 20), { from: 20, count: 5 });
  assert.deepEqual(rowWindow(logLayout(0, 180), 0), { from: 0, count: 0 });
});

test('the playhead seq is the last applied record', () => {
  assert.equal(playheadSeq(0), -1);
  assert.equal(playheadSeq(11), 10);
  assert.equal(playheadSeq(null), -1);
});

test('lines after the playhead are future; the located line is cur', () => {
  assert.equal(lineState(row({ row: 4, seq: 12 }), 10, 3), 'future');
  assert.equal(lineState(row({ row: 3, seq: 10 }), 10, 3), 'cur');
  // the located line can be before the playhead when the playhead sits on a
  // non-log record
  assert.equal(lineState(row({ row: 3, seq: 8 }), 10, 3), 'cur');
  assert.equal(lineState(row({ row: 2, seq: 5 }), 10, 3), 'past');
});

test('follow: tail -f — scroll only when the playhead line is out of view', () => {
  const L = logLayout(1000, 180); // 10 whole lines
  assert.ok(rowFullyVisible(L, 100, 109));
  assert.ok(!rowFullyVisible(L, 100, 110));
  // visible: stay put
  assert.equal(followTarget(L, 100, 105, true), null);
  // below the view: it becomes the last whole line
  assert.equal(followTarget(L, 100, 150, true), 141);
  // above the view (a seek backwards): same placement
  assert.equal(followTarget(L, 100, 20, true), 11);
  // near the start, clamped
  assert.equal(followTarget(L, 100, 3, true), 0);
  // not following, nothing located, or nothing to show: no move
  assert.equal(followTarget(L, 100, 150, false), null);
  assert.equal(followTarget(L, 100, -1, true), null);
  assert.equal(followTarget(logLayout(0, 180), 0, 0, true), null);
});

test('reveal centers the line, clamped at both ends', () => {
  const L = logLayout(1000, 180);
  assert.equal(firstRowFor(L, 500, 'center'), 495);
  assert.equal(firstRowFor(L, 2, 'center'), 0);
  assert.equal(firstRowFor(L, 999, 'center'), L.maxFrom);
});

test('keys that scroll the list count as scrolling by hand', () => {
  for (const k of ['ArrowUp', 'PageDown', 'End', ' ']) assert.ok(isScrollKey(k), k);
  assert.ok(!isScrollKey('a'));
  assert.ok(!isScrollKey('Enter'));
});

test('relative time is seconds since the trace start; ticks stay ticks', () => {
  assert.equal(fmtRelTime(1500, 'ns'), '+0.000002s');
  assert.equal(fmtRelTime(2_500_000_000, 'ns'), '+2.500000s');
  assert.equal(fmtRelTime(1500, 'us'), '+0.001500s');
  assert.equal(fmtRelTime(3, 's'), '+3.000000s');
  assert.equal(fmtRelTime(42, 'tick'), '+42');
  assert.equal(fmtRelTime(-5, 'ns'), '+0.000000s');
});

test('field values are bare when unambiguous, JSON otherwise', () => {
  assert.equal(fmtFieldValue('worker-1'), 'worker-1');
  assert.equal(fmtFieldValue('two words'), '"two words"');
  assert.equal(fmtFieldValue(''), '""');
  assert.equal(fmtFieldValue('a=b'), '"a=b"');
  assert.equal(fmtFieldValue(3), '3');
  assert.equal(fmtFieldValue(true), 'true');
  assert.equal(fmtFieldValue(null), 'null');
  assert.equal(fmtFieldValue({ a: [1] }), '{"a":[1]}');
});

test('a line as plain text: time, thread, level, logger, message, fields', () => {
  const r = row({ t: 2500, fields: { attempt: 3, path: '/api/items' } });
  assert.equal(formatLogLine(r, 1000, 'ns'), '+0.000002s [2] WARN  net.http retrying request attempt=3 path=/api/items');
  // no logger, no thread, no fields: nothing left dangling
  assert.equal(formatLogLine(row({ t: 1000, thr: null, logger: null, level: 2, msg: 'up' }), 1000, 'ns'), '+0.000000s [-] INFO  up');
});

test('the status line and the strip tooltip line', () => {
  assert.equal(logStatusText({ seq: 1234, level: 4, logger: 'db', msg: 'down' }), 'log error db: down · seq 1,234');
  assert.equal(logStatusText({ seq: 1, level: 2, logger: null, msg: 'hi' }), 'log info hi · seq 1');
  assert.equal(logsHoverText({ count: 6, byLevel: [0, 1, 3, 0, 2, 0] }), 'logs 6 · 2 error · 3 info · 1 debug');
  assert.equal(logsHoverText({ count: 0, byLevel: [0, 0, 0, 0, 0, 0] }), '');
  assert.equal(logsHoverText(null), '');
});
