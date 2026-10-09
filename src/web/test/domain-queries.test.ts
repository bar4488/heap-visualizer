// The generic domain queries (DOM-004, spec/14) always reply: with no trace or
// an export missing the worker answers QUERY_FAILURE's document, which must
// be well-formed — the Logs panel and the interval panels read it directly.

import test from 'node:test';
import assert from 'node:assert/strict';

import { QUERY_FAILURE, queryFailureReply } from '../query-failure.ts';

test('every generic domain query has a failure reply of its own shape', () => {
  const cases: [any, string][] = [
    [{ type: 'domains', reqId: 1 }, 'domains-result'],
    [{ type: 'domain-query', reqId: 2, domain: 'logs', query: { from: 40, count: 10 } }, 'domain-query-result'],
    [{ type: 'domain-locate', reqId: 3, domain: 'logs', query: { seq: 7 } }, 'domain-locate-result'],
    [{ type: 'domain-state', reqId: 4, domain: 'intervals', seq: 9 }, 'domain-state-result'],
    [{ type: 'record', reqId: 5, seq: 9 }, 'record-result'],
    [{ type: 'tracks', reqId: 6 }, 'tracks-result'],
    [{ type: 'interval-window', reqId: 7, query: { track: { cpu: 0 }, axis: 'seq', lo: 0, hi: 10, width: 100 } }, 'interval-window-result'],
  ];
  for (const [query, type] of cases) {
    const reply: any = queryFailureReply(query, 'worker error: boom');
    assert.equal(reply.type, type);
    assert.equal(reply.reqId, query.reqId);
    assert.equal(reply.available, false);
  }
  const [domains, page, locate, state, record, tracks, win] = cases.map(([q]) => queryFailureReply(q, '') as any);
  assert.deepEqual([domains.domains, domains.lanes], [[], []]);
  // an empty page echoes the asked-for `from`, as the engine does past the end
  assert.deepEqual(page.result, { total: 0, from: 40, rows: [] });
  assert.deepEqual(locate.result, { row: -1, total: 0 });
  assert.equal(state.result, null);
  assert.equal(record.result, null);
  assert.equal(tracks.result, null);
  assert.deepEqual(win.result, { rows: [], culled: 0, truncated: false });
});

test('a failed domain query with no `from` answers from 0', () => {
  const r = QUERY_FAILURE['domain-query']({ type: 'domain-query', reqId: 1, domain: 'logs', query: {} }, '');
  assert.equal(r.result.from, 0);
});

test('the removed log-only queries are gone from the protocol', () => {
  assert.equal(queryFailureReply({ type: 'logs-query', reqId: 1 } as any, ''), null);
  assert.equal(queryFailureReply({ type: 'logs-locate', reqId: 1 } as any, ''), null);
});
