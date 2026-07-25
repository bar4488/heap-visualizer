// The one description of the main thread ↔ worker protocol. Both sides import
// it, so a message name or field that exists on one side and not the other is
// a build error rather than a message that silently does nothing.
//
// Two directions and one rule between them: fire-and-forget commands carry no
// reply and are reflected by the next `state` message; queries carry a `reqId`
// and are answered by exactly one reply, matched in rpc.ts. Every query is
// answered even before a trace is loaded, or the coalescer would wait forever.
//
// Payloads that are engine JSON — allocation info, event rows, timeline hover,
// trace metadata — are described loosely and marked as such: the engine
// (src/core/) owns those shapes, they cross as JSON, and duplicating them here
// would create a second owner that drifts. What this file is authoritative
// about is the envelope: which messages exist, in which direction, carrying
// which fields.

/** A [lo, hi] range, in whichever domain the message names. */
export type Range = { lo: number; hi: number };

/** 0 = time (`t`), 1 = sequence (`seq`). The two timeline domains. */
export type Domain = 0 | 1;

/** Which canvas a message is about. */
export type CanvasKey = 'addr' | 'tlt' | 'tls';

/** Engine JSON: an allocation, as `hp_pick` / `hp_alloc_info` render it. */
export type AllocInfo = { e: number; [field: string]: any };

/** Engine JSON: one row of the events list. */
export type EventRow = { seq: number; [field: string]: any };

/** Engine JSON: trace metadata from the load pass. */
export type TraceMeta = { [field: string]: any };

export type FilterDiagnostic = {
  message: string;
  /** UTF-8 byte offsets into the submitted source. */
  start: number;
  end: number;
};

// --- settings ---------------------------------------------------------------
// One `set` message per setting, keyed by name. The value type per key is the
// contract; the worker's SETTINGS table is the applier for the same key, and
// TypeScript is what keeps the two lists from drifting apart.

export type SettingValue = {
  rowBytes: number;
  collapseMin: number;
  rowPx: number;
  locked: boolean;
  sizeLabels: boolean;
  overlapMode: number;
  ghostMode: boolean;
  addrLabels: boolean;
  allocSizeFormat: 'hex' | 'human';
  showAll: boolean;
  xview: { zoom: number; pan: number };
  colorMode: number;
  selected: number | null;
  crop: Range | null;
};

export type SettingKey = keyof SettingValue;

/** `collapseMin` is the one setting with a unit: rows by default, bytes when said so. */
export type SetMessage = {
  [K in SettingKey]: { type: 'set'; key: K; value: SettingValue[K] }
    & (K extends 'collapseMin' ? { mode?: 'bytes' | 'rows' } : {});
}[SettingKey];

// --- main thread -> worker ---------------------------------------------------

/** Commands: no reply, reflected by the next `state`. */
export type Command =
  | { type: 'init'; wasmURL: string; addr: OffscreenCanvas; tlt: OffscreenCanvas; tls: OffscreenCanvas; dpr: number }
  | { type: 'load'; buffer: ArrayBuffer }
  | { type: 'resize'; which: CanvasKey; w: number; h: number; dpr?: number }
  | { type: 'seek'; seq?: number; t?: number }
  | { type: 'play'; mode: 't' | 'seq'; rate: number }
  | { type: 'pause' }
  | { type: 'step'; delta: number }
  | { type: 'jump'; seq?: number; t?: number; select?: boolean }
  | { type: 'scroll'; y: number }
  | { type: 'names'; names: [number, string][] }
  | { type: 'tag-labels'; labels: string[] }
  | { type: 'filter-mode'; mode: 0 | 1 | 2 }
  | { type: 'addr-marks'; marks: Range[] }
  | { type: 'goto-addr'; lo: number; hi: number }
  | { type: 'tlview'; kind: Domain; lo: number; hi: number }
  | { type: 'tag-event'; e: number; tag: number }
  | { type: 'tag-range'; kind: Domain; lo: number; hi: number; tag: number; byFree?: boolean }
  | { type: 'tag-events'; events: number[] | Uint32Array; tag: number }
  | { type: 'retag'; from: number; to: number }
  | { type: 'tags-clear' }
  | { type: 'tag-colors'; colors: number[] }
  | { type: 'alloc-color'; e: number; rgb: number | null }
  | { type: 'flash-event'; seq: number }
  | SetMessage;

/**
 * Queries: exactly one reply each, matched by `reqId`. rpc.ts fills the
 * `reqId` in, which is why callers pass everything but that (`QueryPayload`);
 * on the wire, and on the worker's side of it, every query carries one.
 */
export type Query =
  | { type: 'addr-at'; reqId: number; x: number; y: number }
  | { type: 'convert'; reqId: number; kind: Domain; lo: number; hi: number }
  | { type: 'tags-dump'; reqId: number }
  | { type: 'pick'; reqId: number; x: number; y: number; forClick?: boolean }
  | { type: 'alloc-info'; reqId: number; e: number }
  | { type: 'events'; reqId: number; from: number; count: number; filtered?: boolean }
  | { type: 'ev-pos'; reqId: number; seq: number }
  | { type: 'tlhover'; reqId: number; kind: Domain; x: number }
  | { type: 'filter-check'; reqId: number; source: string; cursor: number }
  | { type: 'filter-apply'; reqId: number; source: string };

export type ToWorker = Command | Query;

// --- worker -> main thread ---------------------------------------------------

/** Replies to queries, by the query that asked. */
export type ReplyTo = {
  'addr-at': { type: 'addr-at'; reqId: number; addr: string | null };
  convert: { type: 'convert-result'; reqId: number; lo: number; hi: number };
  'tags-dump': { type: 'tags-dump'; reqId: number; tags: Record<string, number[]> };
  pick: { type: 'pick-result'; reqId: number; info: AllocInfo | null; forClick?: boolean };
  'alloc-info': { type: 'alloc-info-result'; reqId: number; info: AllocInfo | null };
  events: { type: 'events'; reqId: number; from: number; events: EventRow[]; total: number };
  'ev-pos': { type: 'ev-pos'; reqId: number; pos: number; total: number };
  tlhover: { type: 'tlhover-result'; reqId: number; kind: Domain; info: unknown };
  'filter-check': {
    type: 'filter-check-result';
    reqId: number;
    valid: boolean;
    /** False when this worker's core has no checker implementation. */
    available?: boolean;
    diagnostic?: FilterDiagnostic;
    completions?: string[];
  };
  'filter-apply': {
    type: 'filter-apply-result';
    reqId: number;
    success: boolean;
    source?: string;
    matches?: number;
    creators?: number;
    elapsedMs?: number;
    diagnostic?: FilterDiagnostic;
  };
};

export type QueryType = keyof ReplyTo;

/** The payload a query carries, minus the envelope rpc.ts fills in. */
export type QueryPayload<T extends QueryType> = Omit<Extract<Query, { type: T }>, 'type' | 'reqId'>;

/** Everything the worker sends that is not a reply. */
export type Notification =
  | { type: 'ready' }
  | { type: 'progress'; pct: number }
  | { type: 'error'; message: string }
  | { type: 'loaded'; meta: TraceMeta; warnings: unknown[]; n: number }
  | {
      type: 'state';
      anchor: string | null;
      addrMarkYs: (number | null)[];
      seq: number;
      n: number;
      t: number;
      liveCount: number;
      liveBytes: number;
      virtualH: number;
      scroll: number;
      playing: boolean;
      tlT: Range;
      tlS: Range;
      moveLink: unknown;
    }
  | { type: 'scrollTo'; y: number; virtualH?: number; anchored?: boolean }
  | { type: 'xview'; pan?: number; zoom?: number }
  | { type: 'stepped'; event: EventRow | null; info: AllocInfo | null }
  | { type: 'addr-flash'; y: number }
  | { type: 'addr-selected'; info: AllocInfo | null }
  | { type: 'flash-rects'; rects: unknown }
  | { type: 'tagged'; count: number; tag: number }
  | { type: 'tag-counts'; counts: { tag: number; count: number }[] };

export type FromWorker = Notification | ReplyTo[QueryType];
