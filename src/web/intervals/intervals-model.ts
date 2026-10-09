// Interval domain: the pure logic shared by the State and Intervals panels —
// duration formatting, track ordering and labels, the open-span tree, and the
// list's query state. No DOM and no worker, so `node --test` covers it
// (src/web/test/intervals-model.test.ts). The flame chart's geometry is
// flame-model.ts.
//
// The engine owns what an interval is (IVL-005, IVL-007); this file only reads
// its documents.

import type { Category, IntervalParams, StateSpan, StateThread, TrackCpu, TrackThread } from './types.ts';

// --- durations -----------------------------------------------------------------

const NS_PER_UNIT: Record<string, number> = { ns: 1, us: 1e3, ms: 1e6, s: 1e9 };

/** Three significant digits, without trailing zeros past the point. */
function sig3(v: number): string {
  if (v >= 100) return String(Math.round(v));
  if (v >= 10) return String(+v.toFixed(1));
  return String(+v.toFixed(2));
}

/**
 * A duration in trace time units as people read it: `850ns`, `1.25µs`,
 * `12.5ms`, `3.2s`, `2m05s`. An unknown unit (ticks) stays a count.
 */
export function fmtDur(d: number, unit: string | undefined): string {
  if (!Number.isFinite(d)) return '—';
  d = Math.max(0, d);
  const f = NS_PER_UNIT[unit ?? 'ns'];
  if (!f) return `${sig3(d)} ticks`;
  const ns = d * f;
  if (ns < 1e3) return `${sig3(ns)}ns`;
  if (ns < 1e6) return `${sig3(ns / 1e3)}µs`;
  if (ns < 1e9) return `${sig3(ns / 1e6)}ms`;
  const s = ns / 1e9;
  if (s < 60) return `${sig3(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.floor(s - m * 60)).padStart(2, '0')}s`;
}

/** A span of spine indexes: `1 record`, `1,204 records`. */
export function fmtRecords(n: number): string {
  n = Math.max(0, Math.round(n));
  return `${n.toLocaleString('en-US')} record${n === 1 ? '' : 's'}`;
}

/**
 * The inverse of fmtDur for a filter box: `250us`, `1.5 ms`, `2s`, or a bare
 * number in trace units. Returns trace units, 0 for empty, null when unreadable.
 */
export function parseDur(s: string, unit: string | undefined): number | null {
  const m = /^\s*(\d+(?:\.\d*)?|\.\d+)\s*(ns|us|µs|ms|s)?\s*$/i.exec(s ?? '');
  if (!s || !s.trim()) return 0;
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!m[2]) return v;
  const f = NS_PER_UNIT[unit ?? 'ns'];
  if (!f) return null; // a suffix means nothing when the trace's unit is ticks
  const suffix = m[2].toLowerCase().replace('µ', 'u');
  return (v * NS_PER_UNIT[suffix]) / f;
}

// --- tracks ----------------------------------------------------------------------

/** One key per thread track, the same string wherever a track is named. */
export function threadKey(t: { thr: number; pid?: number | null }): string {
  return t.pid === undefined || t.pid === null ? `thr:${t.thr}` : `thr:${t.pid}:${t.thr}`;
}

export function cpuKey(cpu: number): string {
  return `cpu:${cpu}`;
}

/** A track key back into the query parameters that select it. */
export function trackParams(key: string): Pick<IntervalParams, 'thr' | 'pid' | 'cpu'> {
  const p = key.split(':');
  if (p[0] === 'cpu' && p.length === 2) return { cpu: +p[1] };
  if (p[0] === 'thr' && p.length === 2) return { thr: +p[1] };
  if (p[0] === 'thr' && p.length === 3) return { pid: +p[1], thr: +p[2] };
  return {};
}

/** `name (pid 7 · thr 1)`, the thread's identity after its name. */
export function threadLabel(t: { thr: number; pid?: number | null; name?: string | null }): string {
  const id = t.pid === undefined || t.pid === null ? `thr ${t.thr}` : `pid ${t.pid} · thr ${t.thr}`;
  const name = t.name && t.name !== String(t.thr) ? t.name : '';
  return name ? `${name} (${id})` : id;
}

const byThread = (a: { thr: number; pid?: number | null }, b: { thr: number; pid?: number | null }) => {
  // no pid (a single-process trace) first, then by process, then by thread
  const pa = a.pid ?? -1;
  const pb = b.pid ?? -1;
  return pa - pb || a.thr - b.thr;
};

/**
 * The flame chart's track order: threads by process then thread id, only
 * those with calls or spans; then CPUs by number. Stable and independent of
 * the order the engine listed them in.
 */
export function orderTracks(threads: TrackThread[], cpus: TrackCpu[]) {
  return {
    threads: threads.filter((t) => (t.calls || 0) + (t.spans || 0) > 0).slice().sort(byThread),
    cpus: cpus.filter((c) => (c.slices || 0) > 0).slice().sort((a, b) => a.cpu - b.cpu),
  };
}

/** State threads in the same order the flame chart stacks them. */
export function orderStateThreads(threads: StateThread[]): StateThread[] {
  return threads.slice().sort(byThread);
}

// --- the open-span tree ------------------------------------------------------------

export type SpanNode = { span: StateSpan; indent: number; orphan: boolean };

/**
 * The open spans as a parent tree, flattened in display (pre-)order: each span
 * under its parent when the parent is open too, children in begin order. A
 * span whose parent has closed (an async child outliving it) or that has none
 * is a root; `orphan` marks the former, which still names its parent's id.
 */
export function spanTree(spans: StateSpan[]): SpanNode[] {
  const open = new Map<number, StateSpan>();
  for (const s of spans) open.set(s.ivl, s);
  const kids = new Map<number, StateSpan[]>();
  const roots: StateSpan[] = [];
  for (const s of spans) {
    if (s.parent !== null && s.parent !== undefined && open.has(s.parent) && s.parent !== s.ivl) {
      if (!kids.has(s.parent)) kids.set(s.parent, []);
      kids.get(s.parent).push(s);
    } else {
      roots.push(s);
    }
  }
  const bySeq = (a: StateSpan, b: StateSpan) => a.seq - b.seq || a.ivl - b.ivl;
  const out: SpanNode[] = [];
  const seen = new Set<number>();
  const walk = (s: StateSpan, indent: number) => {
    if (seen.has(s.ivl)) return; // a malformed cycle cannot loop
    seen.add(s.ivl);
    out.push({ span: s, indent, orphan: indent === 0 && s.parent !== null && s.parent !== undefined });
    for (const k of (kids.get(s.ivl) || []).sort(bySeq)) walk(k, indent + 1);
  };
  for (const r of roots.sort(bySeq)) walk(r, 0);
  // anything left belongs to a parent cycle: list it flat rather than lose it
  for (const s of spans) if (!seen.has(s.ivl)) out.push({ span: s, indent: 0, orphan: true });
  return out;
}

// --- the Intervals list's query ---------------------------------------------------

/** What the list's filter bar says. `track` is a threadKey/cpuKey or ''. */
export type ListQuery = {
  category: '' | Category;
  track: string;
  text: string;
  /** Trace units; 0 is no minimum. */
  minDur: number;
  /** Start order: oldest first, or newest first. */
  desc: boolean;
};

export const DEFAULT_LIST_QUERY: ListQuery = { category: '', track: '', text: '', minDur: 0, desc: false };

const CATEGORIES: readonly string[] = ['call', 'span', 'sched'];

export function normalizeListQuery(q: Partial<ListQuery>): ListQuery {
  const minDur = Number(q.minDur);
  return {
    category: CATEGORIES.includes(q.category as string) ? (q.category as Category) : '',
    track: typeof q.track === 'string' && /^(thr:-?\d+(:-?\d+)?|cpu:\d+)$/.test(q.track) ? q.track : '',
    text: (q.text ?? '').trim(),
    minDur: Number.isFinite(minDur) && minDur > 0 ? minDur : 0,
    desc: !!q.desc,
  };
}

export function sameListQuery(a: ListQuery, b: ListQuery): boolean {
  return a.category === b.category && a.track === b.track && a.text === b.text && a.minDur === b.minDur && a.desc === b.desc;
}

/** Whether two queries select the same intervals (the sort order aside). */
export function sameSelection(a: ListQuery, b: ListQuery): boolean {
  return sameListQuery({ ...a, desc: false }, { ...b, desc: false });
}

/** The engine parameters for a list query: only what is set. */
export function listParams(q: ListQuery): IntervalParams {
  const p: IntervalParams = {};
  if (q.category) p.category = q.category;
  Object.assign(p, trackParams(q.track));
  if (q.text) p.text = q.text;
  if (q.minDur > 0) p.minDur = q.minDur;
  return p;
}

/**
 * The page to ask for when display row `from` is first: the engine answers in
 * begin order, so newest-first reads the mirrored range and reverses it.
 */
export function pageFor(q: Pick<ListQuery, 'desc'>, total: number, from: number, count: number) {
  from = Math.max(0, from);
  count = Math.max(0, Math.min(count, total - from));
  if (!q.desc) return { from, count, reverse: false };
  return { from: Math.max(0, total - from - count), count, reverse: true };
}

/** The heading's `shown / total`. */
export function shownLabel(shown: number, total: number): string {
  const f = (n: number) => Math.max(0, n).toLocaleString('en-US');
  return `${f(shown)} / ${f(total)}`;
}

/**
 * An interval relative to the playhead (`applied` records): `future` has not
 * begun, `open` is open at the playhead (IVL-005), `past` has closed.
 */
export function rowPosition(r: { seq: number; end: number | null; open?: boolean }, applied: number): 'future' | 'open' | 'past' {
  if (r.seq >= applied) return 'future';
  if (r.end === null || r.end === undefined || r.end >= applied) return 'open';
  return 'past';
}

/** The list's track column: `cpu 2`, or the thread's id. */
export function trackText(r: { thr?: number | null; pid?: number; cpu?: number }): string {
  if (r.cpu !== undefined && r.cpu !== null) return `cpu ${r.cpu}`;
  if (r.thr === null || r.thr === undefined) return '-';
  return r.pid === undefined || r.pid === null ? `${r.thr}` : `${r.pid}/${r.thr}`;
}

/**
 * Where a click on an interval seeks: one past its begin record, so the
 * interval is open at the playhead (IVL-005: begin < P).
 */
export function seekSeqFor(beginSeq: number): number {
  return Math.max(0, beginSeq) + 1;
}
