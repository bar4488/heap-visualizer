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

let worker = null;
let nextId = 1;
const waiters = new Map(); // reqId -> resolve(replyMessage)
const latest = new Map(); // key -> { inFlight, queued: {type, payload, resolve} }

export function initRpc(w) {
  worker = w;
}

export function request(type, payload = {}) {
  return new Promise((resolve) => {
    const reqId = nextId++;
    waiters.set(reqId, resolve);
    worker.postMessage({ type, ...payload, reqId });
  });
}

export function requestLatest(key, type, payload = {}) {
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
export function cancelLatest(key) {
  const st = latest.get(key);
  if (st && st.queued) {
    st.queued.resolve = null;
    st.queued = null;
  }
}

function flushLatest(st) {
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
export function handleReply(m) {
  if (m.reqId === undefined) return false;
  const w = waiters.get(m.reqId);
  if (!w) return false;
  waiters.delete(m.reqId);
  w(m);
  return true;
}
