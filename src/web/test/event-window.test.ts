import assert from 'node:assert/strict';
import test from 'node:test';

import { eventWindowBody, eventWindowTitle } from '../heap/event-window.ts';

const fmtTime = (t) => `${t} ns`;

test('the title names the event, or says what kind of window this is', () => {
  assert.equal(eventWindowTitle({ seq: 4, title: 'frame 12' }), 'Event · frame 12');
  assert.equal(eventWindowTitle({ seq: 4, title: null }), 'Event');
  assert.equal(eventWindowTitle(null), 'Event');
});

test('the body places the event in the stream', () => {
  const html = eventWindowBody(
    { seq: 41, op: 3, t: 900, title: 'frame 12', thr: 2 }, fmtTime,
  );
  assert.ok(html.includes('<span class="k">seq</span><span>41</span>'));
  assert.ok(html.includes('<span class="k">t</span><span>900 ns</span>'));
  assert.ok(html.includes('<span class="k">thread</span><span>2</span>'));
  assert.ok(html.includes('frame 12'));
});

test('an unlabelled event with no thread shows neither row', () => {
  const html = eventWindowBody({ seq: 0, op: 3, t: 0, title: null, thr: null }, fmtTime);
  assert.ok(!html.includes('label'));
  assert.ok(!html.includes('thread'));
  assert.ok(html.includes('<span class="k">seq</span><span>0</span>'));
});

test('custom fields are shown but carry no filter action', () => {
  // the filter language is over allocations: a predicate here would match
  // records that are not this event
  const html = eventWindowBody(
    { seq: 7, op: 3, t: 1, title: 'x', thr: null, extra: { phase: 'render', frame: 12 } },
    fmtTime,
  );
  assert.ok(html.includes('trace fields'));
  assert.ok(html.includes('<span class="cf-value cf-string">&quot;render&quot;</span>'));
  assert.ok(html.includes('<span class="cf-value cf-number">12</span>'));
  assert.ok(!html.includes('data-predicate'));
  assert.ok(!html.includes('cf-none'));
});

test('a label is escaped in both the title and the body', () => {
  const event = { seq: 1, op: 3, t: 1, title: '<b>boom</b>', thr: null };
  // the title is written with textContent, so it is never markup
  assert.equal(eventWindowTitle(event), 'Event · <b>boom</b>');
  assert.ok(!eventWindowBody(event, fmtTime).includes('<b>boom</b>'));
});
