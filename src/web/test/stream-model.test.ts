// The Events panel's pure logic (src/web/stream/stream-model.ts): rows of
// every domain, their kind labels, the domain toggles, and the position ↔ seq
// map of a list with domains left out.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_COLUMNS, domainChips, genericStatusText, includedDomains, kindInfo, kindTooltip, maskPlan, maskRank, maskSeqAt,
  parseColumns, renderRow, rowDomain, rowText, shortAddr, threadLabel, threadNames, threadPhrase, toggleColumn,
} from '../stream/stream-model.ts';
import type { DomainDescriptor } from '../protocol.ts';

// descriptors as an older core sends them: letters and kind names only, so
// every label below comes from the web's defaults
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

const HEAP_M = { seq: 0, op: 0, t: 1, id: '1', e: 0, addr: '0x1000', size: 64, site: 'json_node' };
const LOG = { seq: 1, op: 4, t: 2, e: null, level: 3, logger: 'net', msg: 'retry <x>', thr: 2 };
const MARK = { seq: 2, op: 3, t: 3, e: null, title: 'phase', thr: null };
const edge = (seq: number, kind: string, source: string, title: string, thr = 1, pid: number | null = 7) => ({
  op: 5, e: null, seq, t: seq, thr, pid, domain: 'intervals', kind, title, source, fields: null,
});

test('every domain and kind reads as a word, never a wire letter', () => {
  const label = (ev: any) => kindInfo(ev, DOMAINS).label;
  assert.deepEqual(
    [0, 1, 2].map((op) => label({ seq: 0, op })),
    ['alloc', 'free', 'realloc'],
  );
  assert.equal(label(MARK), 'mark');
  assert.equal(label(LOG), 'log');
  assert.equal(label(edge(3, 'begin', 'call', '→ f')), 'call ▸');
  assert.equal(label(edge(3, 'end', 'call', '← f')), 'ret ◂');
  assert.equal(label(edge(3, 'begin', 'span', '→ r')), 'span ▸');
  assert.equal(label(edge(3, 'end', 'span', '← r')), 'span ◂');
  assert.equal(label(edge(3, 'switch', 'sched', 'cpu 3 ⇐ main')), 'switch');
  // a category the defaults do not refine falls back to the kind's own label
  assert.equal(label(edge(3, 'begin', 'gpu', '→ k')), 'begin');
});

test('labels and descriptions come from the descriptors when the core sends them', () => {
  const labeled: DomainDescriptor[] = [
    { id: 'heap', name: 'Heap', shape: 'allocation', count: 1, kinds: [{ op: 'M', kind: 'malloc', label: 'new', description: 'Birth' }] },
    {
      id: 'intervals', name: 'Intervals', shape: 'interval', count: 1,
      kinds: [{ op: 'B', kind: 'begin', label: 'begin', sources: { call: { label: 'enter', description: 'Call entered' } } }],
    },
  ];
  assert.deepEqual(kindInfo(HEAP_M, labeled), { domain: 'heap', kind: 'malloc', label: 'new', description: 'Birth', sourced: true });
  const k = kindInfo(edge(3, 'begin', 'call', '→ f'), labeled);
  assert.equal(k.label, 'enter');
  assert.equal(k.description, 'Call entered');
});

test('an unknown kind falls back to its name, clipped to the column', () => {
  const ev = { op: 9, e: null, seq: 9, t: 1, thr: null, domain: 'gpu', kind: 'kernel_launch', title: 'matmul', fields: null };
  const k = kindInfo(ev, DOMAINS);
  assert.equal(rowDomain(ev), 'gpu');
  assert.equal(k.label, 'kernel_l');
  assert.equal(k.description, 'gpu kernel_launch record');
  assert.equal(k.sourced, false);
  assert.equal(kindInfo({ seq: 0, op: 42 }, DOMAINS).label, 'record');
  assert.match(renderRow(ev, ctx), /matmul/);
  assert.equal(genericStatusText(ev, DOMAINS), 'kernel_l matmul · seq 9');
});

test('the kind tooltip says the record in words', () => {
  assert.equal(kindTooltip(HEAP_M, ctx), 'Allocation of 64 B at 0x1000 (site json_node)');
  assert.equal(kindTooltip({ seq: 0, op: 1, addr: '0x1000', size: 64 }, ctx), 'Free of 64 B at 0x1000');
  assert.equal(kindTooltip(LOG, ctx), 'Log line at level WARN from net on thread 2');
  assert.equal(kindTooltip(MARK, ctx), 'Mark: phase');
  assert.equal(kindTooltip(edge(3, 'begin', 'call', '→ handle_upload'), ctx), 'Function call begins on thread worker-1: handle_upload');
  assert.equal(kindTooltip(edge(3, 'end', 'span', '← r42', 2, null), ctx), 'Span ends on thread 2: r42');
  assert.equal(kindTooltip(edge(3, 'switch', 'sched', 'cpu 3 ⇐ worker-1'), ctx), 'Context switch on thread worker-1: cpu 3 → worker-1');
});

test('a row says what the record is first, then where', () => {
  const text = (ev: any) => rowText(ev, ctx);
  const heap = { ...HEAP_M, addr: '0x555555ea41a0', thr: 1, pid: 7 };
  assert.deepEqual(text(heap), { primary: '64 B json_node', thread: 'worker-1', addr: '…ea41a0' });
  // a free reads the freed allocation's size and site, as the engine reports them
  assert.equal(text({ seq: 5, op: 1, addr: '0x1000', size: 32, site: 'buf' }).primary, '32 B buf');
  assert.equal(text({ seq: 5, op: 1, addr: '0x1000', size: 32, site: null }).primary, '32 B');
  assert.deepEqual(text(edge(3, 'begin', 'call', '→ handle_upload')), { primary: 'handle_upload', thread: 'worker-1', addr: '' });
  assert.equal(text(edge(3, 'end', 'span', '← request')).primary, 'request');
  assert.equal(text(edge(3, 'switch', 'sched', 'cpu 3 ⇐ worker-1')).primary, 'cpu 3 → worker-1');
  assert.deepEqual(text(LOG), { primary: 'retry <x>', thread: 't2', addr: '' });
  assert.deepEqual(text(MARK), { primary: 'phase', thread: '', addr: '' });

  // markup order: kind, primary, secondary, seq (when shown)
  const html = renderRow(heap, { ...ctx, columns: { seq: true, addr: true, thread: true } });
  const at = (cls: string) => html.indexOf(`class="${cls}`);
  assert.ok(at('ev-kind') < at('ev-main') && at('ev-main') < at('ev-sub') && at('ev-sub') < at('ev-seq'));
  assert.match(html, /<span class="ev-seq">0<\/span>/);
  // the row's tooltip carries what the row shortens or leaves out
  assert.match(html, /title="seq 0 · t 1 · addr 0x555555ea41a0 · thread worker-1 \(pid 7\)\nclick: seek here and select the allocation"/);
  assert.match(renderRow({ ...HEAP_M, seq: 70777 }, ctx), /title="seq 70777 /);
});

test('the columns menu shows or hides the seq, address and thread', () => {
  assert.deepEqual(DEFAULT_COLUMNS, { seq: false, addr: true, thread: true });
  assert.deepEqual(parseColumns(null), DEFAULT_COLUMNS);
  assert.deepEqual(parseColumns('not json'), DEFAULT_COLUMNS);
  assert.deepEqual(parseColumns('{"seq":true,"addr":"x"}'), { seq: true, addr: true, thread: true });
  assert.deepEqual(toggleColumn(DEFAULT_COLUMNS, 'thread'), { seq: false, addr: true, thread: false });

  const heap = { ...HEAP_M, thr: 1, pid: 7 };
  const row = (columns: any) => renderRow(heap, { ...ctx, columns });
  const shown = row(DEFAULT_COLUMNS);
  assert.match(shown, /ev-addr">0x1000</);
  assert.match(shown, /ev-thr">worker-1</);
  assert.doesNotMatch(shown, /ev-seq/);
  const bare = row({ seq: true, addr: false, thread: false });
  assert.doesNotMatch(bare, /ev-addr|ev-thr|ev-sub/);
  assert.match(bare, /ev-seq">0</);
  // hidden fields stay in the tooltip
  assert.match(bare, /addr 0x1000 · thread worker-1/);
});

test('rows of every shape: heap geometry, a log line, a landmark, and a generic summary', () => {
  const heap = renderRow(HEAP_M, ctx);
  assert.match(heap, /class="ev-kind k-malloc" title="Allocation of 64 B at 0x1000 \(site json_node\)">alloc</);
  assert.match(heap, /ev-addr">0x1000</);
  assert.match(heap, /ev-size">64 B</);
  assert.match(heap, /ev-site">json_node</);
  assert.match(heap, /data-domain="heap"/);

  const log = renderRow(LOG, ctx);
  assert.match(log, /data-log="1"/);
  assert.match(log, /ev-kind k-log ev-lv"[^>]*>WARN</);
  assert.match(log, /retry &lt;x&gt;/);
  assert.match(log, /data-domain="logs"/);

  const mark = renderRow(MARK, ctx);
  assert.match(mark, /ev-kind k-event"[^>]*>mark</);
  assert.match(mark, /phase/);

  // interval edges arrive as the generic summary; the label says the
  // direction, so the title's arrow and the source column go
  const begin = renderRow(edge(3, 'begin', 'call', '→ handle_upload'), ctx);
  assert.match(begin, />call ▸</);
  assert.match(begin, /ev-label">handle_upload</);
  assert.match(begin, /ev-thr">worker-1</);
  assert.doesNotMatch(begin, /ev-src/);
  assert.match(begin, / cur"/);
  assert.doesNotMatch(begin, /undefined/);

  const sw = renderRow({ ...edge(4, 'switch', 'sched', 'cpu 3 ⇐ worker'), thr: 2, pid: undefined }, ctx);
  assert.match(sw, />switch</);
  assert.match(sw, /cpu 3 → worker/);
  // the core's placeholder label is not a thread name
  assert.match(sw, /ev-thr">t2</);
  for (const html of [heap, log, mark, begin, sw]) assert.doesNotMatch(html, /ev-op/);
});

test('the status line uses the same words as the list', () => {
  assert.equal(
    genericStatusText(edge(9, 'begin', 'call', '→ handle_upload'), DOMAINS, ctx.names),
    'call ▸ handle_upload · thread worker-1 · seq 9',
  );
  assert.equal(genericStatusText(edge(9, 'switch', 'sched', 'cpu 3 ⇐ main', 1, null), DOMAINS), 'switch cpu 3 → main · thread 1 · seq 9');
});

test('threads read by name, with the pid only when the trace has more than one process', () => {
  assert.equal(threadLabel(null, null), '');
  assert.equal(threadLabel(3, undefined), 't3');
  assert.equal(threadLabel(1, 7, ctx.names), 'worker-1');
  assert.equal(threadLabel(1, 8, ctx.names), 't1');
  assert.equal(threadPhrase(1, 7, ctx.names), 'thread worker-1');

  const two: DomainDescriptor[] = [{
    id: 'intervals', name: 'Intervals', kinds: [], shape: 'interval', count: 1,
    tracks: { threads: [{ thr: 1, pid: 7, name: 'worker-1' }, { thr: 1, pid: 9, name: 'main' }], cpus: [] },
  }];
  const names = threadNames(two);
  assert.equal(ctx.names.multiProcess, false);
  assert.equal(names.multiProcess, true);
  assert.equal(threadLabel(1, 7, names), '7/worker-1');
  assert.equal(threadLabel(1, 9, names), '9/main');
  assert.equal(threadPhrase(1, 9, names), 'thread main (pid 9)');
  assert.equal(
    genericStatusText(edge(9, 'begin', 'call', '→ f', 1, 9), two, names),
    'call ▸ f · thread main (pid 9) · seq 9',
  );
});

test('a short address keeps its last six hex digits', () => {
  assert.equal(shortAddr('0x555555ea41a0'), '…ea41a0');
  assert.equal(shortAddr('0x1000'), '0x1000');
  assert.equal(shortAddr(undefined), '');
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
