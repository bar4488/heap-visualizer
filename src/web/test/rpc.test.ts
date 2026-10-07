// The worker request layer: requestLatest's per-key coalescing (callers that
// must not be superseded take their own key or a plain request), and the
// failure replies that keep every query answered when a worker handler throws.

import test from 'node:test';
import assert from 'node:assert/strict';

const { initRpc, request, requestLatest, cancelLatest, handleReply } = await import('../rpc.ts');
const { queryFailureReply } = await import('../query-failure.ts');

// a worker stand-in that holds requests until the test answers them
const posted: any[] = [];
initRpc({ postMessage(m) { posted.push(m); } });

function answer(m: any) {
  handleReply({ type: 'convert-result', reqId: m.reqId, lo: m.lo * 10, hi: m.hi * 10 });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('requestLatest keeps only the newest queued request per key', async () => {
  posted.length = 0;
  const seen: string[] = [];
  void requestLatest('k', 'convert', { kind: 0, lo: 1, hi: 1 }).then(() => seen.push('first'));
  void requestLatest('k', 'convert', { kind: 0, lo: 2, hi: 2 }).then(() => seen.push('superseded'));
  void requestLatest('k', 'convert', { kind: 0, lo: 3, hi: 3 }).then(() => seen.push('newest'));
  assert.equal(posted.length, 1, 'one in flight per key');
  answer(posted[0]);
  await tick();
  assert.equal(posted.length, 2);
  assert.equal(posted[1].lo, 3);
  answer(posted[1]);
  await tick();
  assert.deepEqual(seen, ['first', 'newest']);
});

test('different keys never supersede each other', async () => {
  posted.length = 0;
  const seen: string[] = [];
  void requestLatest('crop', 'convert', { kind: 1, lo: 1, hi: 2 }).then(() => seen.push('crop'));
  void requestLatest('sel', 'convert', { kind: 1, lo: 3, hi: 4 }).then(() => seen.push('sel'));
  assert.equal(posted.length, 2);
  posted.forEach(answer);
  await tick();
  assert.deepEqual(seen.sort(), ['crop', 'sel']);
});

test('cancelLatest drops the queued request but not one already in flight', async () => {
  posted.length = 0;
  const seen: string[] = [];
  void requestLatest('pick', 'convert', { kind: 0, lo: 1, hi: 1 }).then(() => seen.push('in flight'));
  void requestLatest('pick', 'convert', { kind: 0, lo: 2, hi: 2 }).then(() => seen.push('queued'));
  // a plain request is outside the coalescer, so cancelling the key spares it
  void request('convert', { kind: 0, lo: 5, hi: 5 }).then(() => seen.push('plain'));
  cancelLatest('pick');
  posted.forEach(answer);
  await tick();
  assert.equal(posted.length, 2, 'the cancelled request was never sent');
  assert.deepEqual(seen.sort(), ['in flight', 'plain']);
});

test('a failure reply answers the query with its own reply type and reqId', () => {
  const cases: [any, string][] = [
    [{ type: 'pick', reqId: 1, x: 0, y: 0, forClick: true }, 'pick-result'],
    [{ type: 'convert', reqId: 2, kind: 0, lo: 1, hi: 2 }, 'convert-result'],
    [{ type: 'addr-at', reqId: 3, x: 0, y: 0 }, 'addr-at'],
    [{ type: 'events', reqId: 4, from: 7, count: 10 }, 'events'],
    [{ type: 'ev-pos', reqId: 5, seq: 1 }, 'ev-pos'],
    [{ type: 'filter-apply', reqId: 6, source: 'x' }, 'filter-apply-result'],
    [{ type: 'analysis-change', reqId: 7, expectedRevision: 4, change: {} }, 'analysis-change-result'],
  ];
  for (const [query, type] of cases) {
    const reply: any = queryFailureReply(query, 'worker error: boom');
    assert.equal(reply.type, type);
    assert.equal(reply.reqId, query.reqId);
  }
  const click: any = queryFailureReply(cases[0][0], 'x');
  assert.equal(click.info, null);
  assert.equal(click.forClick, true);
  const apply: any = queryFailureReply(cases[5][0], 'worker error: boom');
  assert.equal(apply.success, false);
  assert.equal(apply.diagnostic.message, 'worker error: boom');
  const change: any = queryFailureReply(cases[6][0], 'worker error: boom');
  assert.equal(change.ok, false);
  assert.notEqual(change.error, 'conflict');
});

test('a failure reply unblocks a coalesced key', async () => {
  posted.length = 0;
  const seen: any[] = [];
  void requestLatest('tl', 'tlhover', { kind: 0, x: 1 }).then((m) => seen.push(m.info));
  void requestLatest('tl', 'tlhover', { kind: 0, x: 2 }).then((m) => seen.push(m.info));
  handleReply(queryFailureReply(posted[0], 'boom') as any);
  await tick();
  assert.equal(posted.length, 2, 'the queued request went out after the failure');
});

test('commands get no failure reply', () => {
  assert.equal(queryFailureReply({ type: 'seek', seq: 1 }, 'x'), null);
  assert.equal(queryFailureReply({ type: 'pause' }, 'x'), null);
});
