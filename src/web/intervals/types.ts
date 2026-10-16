// Interval domain (spec/14): the shapes the interval panels read. protocol.ts
// owns the wire (the queries and their envelopes); this file is the panels'
// typed view of the engine JSON inside them. Each mirrors the worker contract —
// engine JSON the core owns (IVL-005, IVL-007) inside the `{reqId, available,
// result}` envelope. When protocol.ts gains these queries, replace this file's
// `IvlQueries` with imports from there; nothing else here names the wire.

import type { IntervalSelection } from './selection.ts';

/** A [lo, hi] range on one axis. */
export type Range = { lo: number; hi: number };

/** The x-axis the flame chart is drawn on: trace time, or spine index. */
export type Axis = 't' | 'seq';

export type Category = 'call' | 'span' | 'sched';

/** A thread track: `thr` within `pid` (no pid in a v1-style single process). */
export type ThreadKey = { thr: number; pid?: number };

/** `tracks`: the timeline's interval tracks. */
export type TrackThread = { thr: number; pid?: number; name: string; calls: number; spans: number };
export type TrackCpu = { cpu: number; slices: number };
export type Tracks = { threads: TrackThread[]; cpus: TrackCpu[] };

/** `interval-window`: one track, one axis range, at one pixel width. */
export type WindowQuery = {
  track: ThreadKey | { cpu: number };
  axis: Axis;
  lo: number;
  hi: number;
  width: number;
  category?: Category;
};

export type WindowRow = {
  ivl: number;
  name: string;
  category: Category;
  depth: number;
  /** Begin and end, in the queried axis's units. An open interval ends at the trace end. */
  start: number;
  end: number;
  open: boolean;
  lane: 'call' | 'span';
  thr?: number;
  cpu?: number;
  idle?: boolean;
  /** Begin seq — not in the contract yet; used for click-to-seek when present. */
  seq?: number;
};

export type WindowResult = { rows: WindowRow[]; culled: number; truncated: boolean };

/** `domain-query` with `domain: "intervals"`: one interval document (IVL-007). */
export type IntervalRow = {
  row: number;
  ivl: number;
  category: Category;
  name: string;
  seq: number;
  end: number | null;
  t: number;
  endT: number | null;
  dur: number;
  open: boolean;
  depth: number;
  parent: number | null;
  thr: number | null;
  pid?: number;
  fields: Record<string, unknown> | null;
  endFields: Record<string, unknown> | null;
  span?: string | null;
  parentSpan?: string | null;
  endThr?: number | null;
  cpu?: number;
  idle?: boolean;
  implicitClose?: boolean;
  doubleRun?: boolean;
};

/** The interval query's parameters (IVL-007), as the list sends them. */
export type IntervalParams = {
  category?: Category;
  thr?: number;
  pid?: number;
  cpu?: number;
  text?: string;
  minDur?: number;
  seqLo?: number;
  seqHi?: number;
  /** One interval, by id. */
  ivl?: number;
  /** The interval the edge record at this seq begins or ends. */
  edge?: number;
};

export type QueryResult<R> = { total: number; from: number; rows: R[] };
export type LocateResult = { row: number; total: number };

/** `domain-state` for `intervals` (IVL-005). Frame and span `seq` are begin seqs. */
export type StateFrame = { ivl: number; name: string; depth: number; seq: number };
export type StateThread = { thr: number; pid?: number; name: string; stack: StateFrame[] };
export type StateSpan = {
  ivl: number; span: string | null; name: string | null; depth: number; seq: number;
  thr: number | null; parent: number | null; parentSpan: string | null;
};
export type StateCpu = {
  cpu: number; state: 'running' | 'idle' | 'unknown';
  thr?: number; pid?: number; name?: string; since?: number; ivl?: number;
};
export type IntervalState = { applied: number; threads: StateThread[]; spans: StateSpan[]; cpus: StateCpu[] };

/** The interval domain's registry descriptor (DOM-004, IVL-007), as far as the panels read it. */
export type IntervalDescriptor = {
  id: string;
  count: number;
  intervals: number;
  categories: Category[];
  byCategory: number[];
  tracks: { threads: { thr: number; pid?: number; name: string; calls: number }[]; cpus: TrackCpu[] };
  [k: string]: unknown;
};

/** Every reply is `{reqId, available, result}`; `available` is false with no trace or no export. */
export type Reply<R> = { reqId: number; available: boolean; result: R | null };

/** The queries the interval panels send: payload and result, by query name. */
export type IvlQueries = {
  /** The real reply carries `domains`/`lanes` rather than `result` (protocol.ts). */
  domains: { payload: Record<string, never>; result: never };
  'domain-query': { payload: { domain: 'intervals'; query: IntervalParams & { from: number; count: number } }; result: QueryResult<IntervalRow> };
  'domain-locate': { payload: { domain: 'intervals'; query: IntervalParams & { seq: number } }; result: LocateResult };
  'domain-state': { payload: { domain: 'intervals'; seq: number }; result: IntervalState };
  record: { payload: { seq: number }; result: unknown };
  tracks: { payload: Record<string, never>; result: Tracks };
  'interval-window': { payload: { query: WindowQuery }; result: WindowResult };
};

export type IvlQuery = keyof IvlQueries;

/** The playhead, as every `state` message carries it: `seq` records applied, at time `t`. */
export type Playhead = { seq: number; t: number };

/** The timeline strips' view ranges. */
export type Views = { t: Range; seq: Range };

/**
 * What main.ts hands registerIntervalPanels. `layout` is shell/layout.ts's
 * panel API; `request`/`requestLatest` are rpc.ts's.
 */
export type IntervalCtx = {
  layout: {
    register(type: string, spec: any): void;
    isOpen(type: string, key?: string): boolean;
    isShown?(type: string, key?: string): boolean;
    reveal(type: string, key?: string, opts?: any): any;
    close?(type: string, key?: string): void;
    onOpen(type: string, fn: (key: string, el: any) => void): void;
  };
  post: (m: any) => void;
  request: <T extends IvlQuery>(type: T, payload: IvlQueries[T]['payload']) => Promise<Reply<IvlQueries[T]['result']>>;
  requestLatest: <T extends IvlQuery>(key: string, type: T, payload: IvlQueries[T]['payload']) => Promise<Reply<IvlQueries[T]['result']>>;
  ui: {
    loaded: boolean;
    meta: { n?: number; tMin?: number; tMax?: number; unit?: string; intervals?: { intervals?: number } | null; [k: string]: any } | null;
    state: { seq: number; t?: number } | null;
    /** The strips' range selection and its mirror on the other axis (kind 0 = time, 1 = events). */
    sel?: { kind: number; lo: number; hi: number } | null;
    selMirror?: { kind: number; lo: number; hi: number } | null;
    /** The interval selection (IVL-UI-005). */
    intervalSel?: IntervalSelection | null;
  };
  onState(fn: (s: Playhead) => void): void;
  onView(fn: (v: Views | { tlT: Range; tlS: Range }) => void): void;
  /** Optional: drive the strips' view (main.ts's `UI.setView`). Without it the flame chart keeps a local view. */
  setView?: (axis: Axis, r: Range) => void;
  /** Optional: the strips' range selection (shift+drag): set, clear (null), or end at client {x, y} with its popover. */
  select?: (axis: Axis, r: Range | null, at?: { x: number; y: number }) => void;
  /** Optional: a trace finished loading. Without it the panels notice a new `ui.meta`. */
  onLoad?: (fn: () => void) => void;
  /** The interval selection (IVL-UI-005), shared with the Events list: set it (null clears). */
  selectInterval?: (sel: IntervalSelection | null) => void;
  /** fn(selection) whenever the interval selection changes, from any panel. */
  onIntervalSelect?: (fn: (sel: IntervalSelection | null) => void) => void;
};
