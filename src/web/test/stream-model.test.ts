// The Events panel's pure logic (src/web/stream/stream-model.ts): rows of
// every domain, the domain toggles, and the position ↔ seq map of a list with
// domains left out.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  domainChips, genericStatusText, includedDomains, maskPlan, maskRank, maskSeqAt, opLetter,
  renderRow, rowDomain, threadLabel, threadNames,
} from '../stream/stream-model.ts';
import type { DomainDescriptor } from '../protocol.ts';

const kinds = (pairs: string) => pairs.split(' ').map((p) => { const [op, kind] = p.split(':'); return { op, kind }; });
const DOMAINS: DomainDescriptor[] = [
  { id: 'heap', name: 'Heap', kinds: kinds('M:malloc F:free R:realloc'), shape: 'allocation', count: 6 },
  { id: 'marks', name: 'Marks', kinds: kinds('E:event'), shape: 'point', count: 0 },
  { id: 'logs', name: 'Logs', kinds: kinds('L:log'), shape: 'point', count: 2 },
  {
    id: 'intervals', name: 'Intervals', kinds: kinds('B:begin X:end C:switch'), shape: 'interval', count: 4,
    tracks: { threads: [{ thr: 1, pid: 7, name: 'worker-1', calls: 3 }, { thr: 2, name: 'thread 2', calls: 0 }], cpus: [] },
  },
];
const ctx = { domains: DOMAINS, names: threadNames(DOMAINS), fmtAllocSize: (b: number) => `${b} B`, curSeq: 3 };

test('rows of every shape: heap geometry, a log line, a landmark, and a generic summary', () => {
  const heap = renderRow({ seq: 0, op: 0, t: 1, id: '1', e: 0, addr: '0x1000', size: 64, site: 'alloc_a' }, ctx);
  assert.match(heap, /ev-op m">M</);
  assert.match(heap, /0x1000/);
  assert.match(heap, /64 B/);
  assert.match(heap, /alloc_a/);

  const log = renderRow({ seq: 1, op: 4, t: 2, e: null, level: 3, logger: 'net', msg: 'retry <x>', thr: 2 }, ctx);
  assert.match(log, /data-log="1"/);
  assert.match(log, /WARN/);
  assert.match(log, /retry &lt;x&gt;/);
  assert.match(log, /data-domain="logs"/);

  const mark = renderRow({ seq: 2, op: 3, t: 3, e: null, title: 'phase', thr: null }, ctx);
  assert.match(mark, /ev-op e">E</);
  assert.match(mark, /phase/);

  // interval edges arrive as the generic summary; op 5+ is no longer indexed
  // into a fixed table
  const begin = renderRow({
    op: 5, e: null, seq: 3, t: 4, thr: 1, pid: 7, domain: 'intervals', kind: 'begin', title: '→ handle_upload',
    source: 'call', fields: null,
  }, ctx);
  assert.match(begin, /ev-op b">B</);
  assert.match(begin, /→ handle_upload/);
  assert.match(begin, /7\/1 worker-1/);
  assert.match(begin, /ev-src">call</);
  assert.match(begin, / cur"/);
  assert.doesNotMatch(begin, /undefined/);

  const sw = renderRow({
    op: 7, e: null, seq: 4, t: 5, thr: 2, domain: 'intervals', kind: 'switch', title: 'cpu 3 ⇐ worker', source: 'sched', fields: null,
  }, ctx);
  assert.match(sw, /ev-op c">C</);
  assert.match(sw, /cpu 3 ⇐ worker/);
  // the core's placeholder label is not a thread name
  assert.match(sw, /ev-thr">2</);
});

test('a domain the descriptors do not list still renders, lettered by its kind', () => {
  const ev = { op: 9, e: null, seq: 9, t: 1, thr: null, domain: 'gpu', kind: 'kernel', title: 'matmul', fields: null };
  assert.equal(rowDomain(ev), 'gpu');
  assert.equal(opLetter(ev, DOMAINS), 'K');
  assert.match(renderRow(ev, ctx), /matmul/);
  assert.equal(opLetter({ seq: 0, op: 42 }, DOMAINS), '?');
  assert.equal(genericStatusText(ev), 'gpu kernel · matmul · seq 9');
});

test('thread labels: id, process, and name when there is one', () => {
  assert.equal(threadLabel(null, null), '');
  assert.equal(threadLabel(3, undefined), '3');
  assert.equal(threadLabel(1, 7, ctx.names), '7/1 worker-1');
  assert.equal(threadLabel(1, 8, ctx.names), '8/1');
});

test('domain chips list the domains with records, and an all-on set excludes nothing', () => {
  const chips = domainChips(DOMAINS);
  assert.deepEqual(chips.map((c) => c.id), ['heap', 'logs', 'intervals']);
  assert.equal(includedDomains(chips, new Set()), undefined);
  // a domain without records is not a chip, so excluding it changes nothing
  assert.equal(includedDomains(chips, new Set(['marks'])), undefined);
  assert.deepEqual(includedDomains(chips, new Set(['logs'])), ['heap', 'intervals']);
});

// A spine of 12 records: H H L B H X H L H C H C (heap 6, logs 2, intervals 4).
const SPINE = 'HHLBHXHLHCHC'.split('').map((c) => (c === 'H' ? 'heap' : c === 'L' ? 'logs' : 'intervals'));
const rankOf = (domain: string, seq: number) => SPINE.slice(0, seq + 1).filter((d) => d === domain).length;
const listed = (included: string[]) => SPINE.map((d, seq) => [d, seq] as const).filter(([d]) => included.includes(d)).map(([, s]) => s);

test('a list with domains left out maps positions to seqs exactly', () => {
  assert.equal(maskPlan(DOMAINS, undefined), null);
  assert.equal(maskPlan(DOMAINS, ['heap', 'logs', 'intervals']), null, 'nothing with records left out');
  for (const included of [['heap'], ['logs'], ['intervals'], ['heap', 'intervals'], ['logs', 'intervals'], ['heap', 'logs'], []]) {
    const plan = maskPlan(DOMAINS, included);
    const want = listed(included);
    assert.equal(plan.total, want.length, included.join('+'));
    want.forEach((seq, k) => {
      assert.equal(maskSeqAt(plan, k, SPINE.length, rankOf), seq, `${included.join('+')} #${k}`);
      // the position of a listed record is the count listed before it
      assert.equal(maskRank(plan, seq - 1, rankOf), k);
    });
    assert.equal(maskSeqAt(plan, want.length, SPINE.length, rankOf), SPINE.length, 'past the end');
  }
});

test('the interval domain is counted as the residual, never by its locate', () => {
  const plan = maskPlan(DOMAINS, ['heap', 'intervals']);
  assert.equal(plan.residual, true);
  assert.deepEqual(plan.sub, ['logs']);
  const asked: string[] = [];
  maskRank(plan, 5, (d, s) => { asked.push(d); return rankOf(d, s); });
  assert.deepEqual(asked, ['logs']);
});
