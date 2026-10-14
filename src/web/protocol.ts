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
export type AllocInfo = { e: number; id: string; [field: string]: any };

/** Engine JSON: one row of the events list. */
export type EventRow = { seq: number; [field: string]: any };

/** Engine JSON: trace metadata from the load pass. */
export type TraceMeta = {
  /**
   * `hp_logs_meta_json`, attached by the worker at load (LOG-009): null when
   * this core has no log domain; a zero `count` means the trace has no logs.
   */
  logs?: LogsMeta | null;
  /**
   * `hp_domains_json`, attached by the worker at load (DOM-004): every
   * domain's descriptor in registry order, or null from a core without it.
   */
  domains?: DomainDescriptor[] | null;
  /** The `intervals` descriptor from `domains`, attached at load (spec/14), or null. */
  intervals?: DomainDescriptor | null;
  [field: string]: any;
};

/**
 * Engine JSON (DOM-004): one domain's descriptor. The keys the web layer reads
 * are named; the rest (`fields`, `query`, `limits`, a shape's own keys such as
 * the interval domain's `tracks`) cross loosely — the core owns them.
 */
export type DomainDescriptor = {
  id: string;
  name: string;
  /**
   * Record types: the wire letter (`"M"`), the kind name (`"malloc"`), and
   * what the UI calls it — `label` (`"alloc"`) and `description`
   * (`"Allocation"`), optionally refined per summary `source` (an interval's
   * `call` begin reads `call ▸`). Labels are absent from an older core.
   */
  kinds: {
    op: string; kind: string; label?: string; description?: string;
    sources?: Record<string, { label?: string; description?: string }>;
  }[];
  shape: 'allocation' | 'point' | 'interval' | string;
  /** Records of this domain on the spine. */
  count: number;
  [field: string]: any;
};

/** Engine JSON (DOM-004): the generic summary of one spine record. */
export type RecordSummary = {
  seq: number; t: number; thr: number | null; pid?: number;
  domain: string; kind: string; title: string | null;
  level?: number; source?: string; fields: Record<string, unknown> | null;
};

/** Engine JSON: one page of a domain query, in the domain's own row keys. */
export type DomainPage<Row = any> = { total: number; from: number; rows: Row[]; error?: string };

/** Engine JSON: a domain locate — the last match at or before `seq`, or -1. */
export type DomainLocate = { row: number; total: number; error?: string };

/** Engine JSON (spec/14): one row of an interval window. */
export type IntervalWindowRow = {
  ivl: number; name: string; category: string; depth: number;
  start: number; end: number; open: boolean; lane: number;
  thr?: number; cpu?: number; idle?: boolean;
  [field: string]: any;
};

/** Engine JSON (spec/14): the intervals of one track drawn over a range. */
export type IntervalWindow = { rows: IntervalWindowRow[]; culled: number; truncated: boolean; [field: string]: any };

/** One interval track: a thread (optionally in a process), or a CPU. */
export type IntervalTrack = { thr: number; pid?: number } | { cpu: number };

/** The interval window's query (hp_interval_window). */
export type IntervalWindowQuery = {
  track: IntervalTrack;
  axis: 'seq' | 't';
  lo: number;
  hi: number;
  /** Pixel columns the window is drawn into. */
  width: number;
  category?: string;
  [field: string]: unknown;
};

/** Engine JSON (LOG-009): the log domain's load-time summary. */
export type LogsMeta = { count: number; byLevel: number[]; loggers: { name: string; count: number }[] };

/** Engine JSON (LOG-009): one row of a `logs` domain query; `row` indexes the match list. */
export type LogRow = {
  row: number; seq: number; t: number; thr: number | null;
  level: number; logger: string | null; msg: string;
  fields: Record<string, unknown> | null;
};

/**
 * Engine JSON: one caller-defined trace field, as `hp_fields_json` renders it.
 * `type` is the single type the field can be filtered as; `null` means the
 * trace held several types under this key, or held an object or an array,
 * either of which the filter language cannot address.
 */
export type TraceField = {
  name: string;
  type: 'bool' | 'int' | 'float' | 'string' | null;
  /** Some event carried this key as JSON `null`, so it can be missing. */
  optional: boolean;
  /** Events of any op carrying the key — creators and frees alike. */
  events: number;
};

export type FilterDiagnostic = {
  message: string;
  /** UTF-8 byte offsets into the submitted source. */
  start: number;
  end: number;
};

export type FilterCompletion = {
  label: string;
  insertText: string;
  kind: 'field' | 'function' | 'member' | 'operator' | 'value';
  detail?: string;
};

export type FilterCompletions = {
  /** UTF-8 byte offsets into the submitted source. */
  start: number;
  end: number;
  items: FilterCompletion[];
  hasMore?: boolean;
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
  | { type: 'load-begin'; total: number }
  | { type: 'load-chunk'; buffer: ArrayBuffer }
  | { type: 'load-end' }
  | { type: 'load-cancel' }
  | { type: 'unload' }
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
  | { type: 'tag-event'; e: number; tags: number[] }
  | { type: 'tag-range'; kind: Domain; lo: number; hi: number; tag: number; byFree?: boolean }
  | { type: 'tag-filter'; tag: number }
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
  // `domains`: the domains the list includes (absent: every one); see
  // stream/stream-model.ts for how an excluded domain is skipped
  | { type: 'events'; reqId: number; from: number; count: number; filtered?: boolean; domains?: string[] }
  | { type: 'ev-pos'; reqId: number; seq: number; filtered?: boolean; domains?: string[] }
  | { type: 'tlhover'; reqId: number; kind: Domain; x: number }
  | { type: 'filter-check'; reqId: number; source: string; cursor: number }
  | { type: 'filter-apply'; reqId: number; source: string }
  | { type: 'analysis-get'; reqId: number }
  | { type: 'analysis-change'; reqId: number; expectedRevision: number; change: unknown }
  | { type: 'analysis-replace'; reqId: number; document: unknown }
  // the generic domain surface (DOM-004) and the interval domain (spec/14)
  | { type: 'domains'; reqId: number }
  | { type: 'domain-query'; reqId: number; domain: string; query: Record<string, unknown> }
  | { type: 'domain-locate'; reqId: number; domain: string; query: Record<string, unknown> & { seq: number } }
  | { type: 'domain-state'; reqId: number; domain: string; seq: number }
  | { type: 'record'; reqId: number; seq: number }
  | { type: 'tracks'; reqId: number }
  | { type: 'interval-window'; reqId: number; query: IntervalWindowQuery };

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
    completions?: FilterCompletions;
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
  'analysis-get': { type: 'analysis-get-result'; reqId: number; document: unknown };
  'analysis-change': {
    type: 'analysis-change-result'; reqId: number; ok: boolean; revision: number;
    change?: unknown; error?: string; message?: string;
  };
  'analysis-replace': { type: 'analysis-replace-result'; reqId: number; ok: boolean; revision?: number; error?: string; message?: string };
  // The generic domain replies. `available` is false with no trace loaded or
  // when this core lacks the export; `result` is then the empty document of
  // the query's shape (an empty page, a locate of -1, an empty window), or
  // null where the engine itself can answer null (record, state, tracks).
  // An engine-level error (an unknown domain) is available, with `error` in
  // the result.
  domains: { type: 'domains-result'; reqId: number; available: boolean; domains: DomainDescriptor[]; lanes: unknown[] };
  'domain-query': { type: 'domain-query-result'; reqId: number; available: boolean; result: DomainPage };
  'domain-locate': { type: 'domain-locate-result'; reqId: number; available: boolean; result: DomainLocate };
  'domain-state': { type: 'domain-state-result'; reqId: number; available: boolean; result: unknown };
  record: { type: 'record-result'; reqId: number; available: boolean; result: RecordSummary | null };
  tracks: { type: 'tracks-result'; reqId: number; available: boolean; result: unknown };
  'interval-window': { type: 'interval-window-result'; reqId: number; available: boolean; result: IntervalWindow };
};

export type QueryType = keyof ReplyTo;

/** The payload a query carries, minus the envelope rpc.ts fills in. */
export type QueryPayload<T extends QueryType> = Omit<Extract<Query, { type: T }>, 'type' | 'reqId'>;

/** Everything the worker sends that is not a reply. */
export type Notification =
  | { type: 'ready' }
  | { type: 'progress'; pct: number }
  | { type: 'error'; message: string }
  | {
      type: 'loaded';
      meta: TraceMeta;
      warnings: unknown[];
      n: number;
      /** The custom trace fields this trace carries; see TraceField. */
      fields: TraceField[];
    }
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
