// The one worker request/response layer. Two shapes:
//
//   request(type, payload)             → Promise of the reply message
//   requestLatest(key, type, payload)  → Promise, coalesced per key: while a
//     request is in flight only the newest queued one is kept, and a
//     superseded request's promise is dropped (never resolved) — callers
//     never see stale replies, and a fast drag cannot build a backlog.
//
// Replies are matched by reqId. Any worker message carrying a reqId that has
// no dedicated onmessage case belongs here — route it to handleReply. The
// events-panel and addr-at paths keep their own reqId streams and cases.
//
// The query name picks the reply type: `request('pick', …)` resolves to a
// pick-result and nothing else, so a caller reading a field the reply does not
// carry is a build error. Both maps live in protocol.ts.

import type { FromWorker, QueryPayload, QueryType, ReplyTo } from './protocol.ts';

/** Just enough of a worker to post to — a test supplies a stand-in. */
type Poster = { postMessage(m: any): void };

let worker: Poster | null = null;
let nextId = 1;
const waiters = new Map<number, ((m: any) => void) | null>(); // reqId -> resolve(replyMessage)
const latest = new Map<string, LatestState>(); // key -> in-flight/queued pair

// The queue itself is untyped on purpose: it holds one entry per key across
// different query types, and the pairing that matters — query name to reply
// shape — is already enforced at the two public entry points below.
type Queued = { type: QueryType; payload: any; resolve: ((m: any) => void) | null };
type LatestState = { inFlight: boolean; queued: Queued | null };

export function initRpc(w: Poster) {
  worker = w;
}

export function request<T extends QueryType>(type: T, payload: QueryPayload<T> = {} as QueryPayload<T>): Promise<ReplyTo[T]> {
  return new Promise((resolve) => {
    const reqId = nextId++;
    waiters.set(reqId, resolve);
    worker.postMessage({ type, ...payload, reqId });
  });
}

export function requestLatest<T extends QueryType>(key: string, type: T, payload: QueryPayload<T> = {} as QueryPayload<T>): Promise<ReplyTo[T]> {
  return new Promise((resolve) => {
    let st = latest.get(key);
    if (!st) { st = { inFlight: false, queued: null }; latest.set(key, st); }
    if (st.queued) st.queued.resolve = null; // superseded: drop its promise
    st.queued = { type, payload, resolve };
    if (!st.inFlight) flushLatest(st);
  });
}

// Drop whatever is queued under `key` (e.g. the pointer left the surface);
// an already in-flight request still resolves.
export function cancelLatest(key: string) {
  const st = latest.get(key);
  if (st && st.queued) {
    st.queued.resolve = null;
    st.queued = null;
  }
}

function flushLatest(st: LatestState) {
  const q = st.queued;
  st.queued = null;
  if (!q) {
    st.inFlight = false;
    return;
  }
  st.inFlight = true;
  const reqId = nextId++;
  waiters.set(reqId, (m) => {
    if (q.resolve) q.resolve(m);
    flushLatest(st);
  });
  worker.postMessage({ type: q.type, ...q.payload, reqId });
}

// Resolve the waiter for a reply message; false if it isn't an rpc reply.
export function handleReply(m: FromWorker & { reqId?: number }): boolean {
  if (m.reqId === undefined) return false;
  const w = waiters.get(m.reqId);
  if (!w) return false;
  waiters.delete(m.reqId);
  w(m);
  return true;
}
