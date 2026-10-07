// What a query answers when its worker handler throws (a wasm trap, engine
// JSON that does not parse) or has nothing to answer from. protocol.ts
// promises exactly one reply per query, and rpc.ts's coalescer waits for it,
// so a failure must still reply. The table is total over the query names: a
// new query without a failure reply is a build error rather than a
// requestLatest key that hangs forever.

import type { FromWorker, Query, QueryType, ReplyTo, ToWorker } from './protocol.ts';

export const QUERY_FAILURE: { [K in QueryType]: (m: Extract<Query, { type: K }>, message: string) => ReplyTo[K] } = {
  'addr-at': (m) => ({ type: 'addr-at', reqId: m.reqId, addr: null }),
  convert: (m) => ({ type: 'convert-result', reqId: m.reqId, lo: m.lo, hi: m.hi }),
  'tags-dump': (m) => ({ type: 'tags-dump', reqId: m.reqId, tags: {} }),
  pick: (m) => ({ type: 'pick-result', reqId: m.reqId, info: null, forClick: m.forClick }),
  'alloc-info': (m) => ({ type: 'alloc-info-result', reqId: m.reqId, info: null }),
  events: (m) => ({ type: 'events', reqId: m.reqId, from: m.from, events: [], total: 0 }),
  'ev-pos': (m) => ({ type: 'ev-pos', reqId: m.reqId, pos: 0, total: 0 }),
  tlhover: (m) => ({ type: 'tlhover-result', reqId: m.reqId, kind: m.kind, info: null }),
  'filter-check': (m, message) => ({
    type: 'filter-check-result', reqId: m.reqId, valid: false, diagnostic: { message, start: 0, end: 0 },
  }),
  'filter-apply': (m, message) => ({
    type: 'filter-apply-result', reqId: m.reqId, success: false, diagnostic: { message, start: 0, end: 0 },
  }),
  'analysis-get': (m) => ({ type: 'analysis-get-result', reqId: m.reqId, document: null }),
  'analysis-change': (m, message) => ({
    type: 'analysis-change-result', reqId: m.reqId, ok: false, revision: m.expectedRevision, error: 'invalid', message,
  }),
  'analysis-replace': (m, message) => ({
    type: 'analysis-replace-result', reqId: m.reqId, ok: false, error: 'invalid', message,
  }),
};

/** The failure reply for `m` if it is a query, else null. */
export function queryFailureReply(m: ToWorker, message: string): FromWorker | null {
  const reply = (QUERY_FAILURE as Record<string, ((m: any, message: string) => FromWorker) | undefined>)[m.type];
  return reply && (m as { reqId?: number }).reqId !== undefined ? reply(m, message) : null;
}
