// Interval domain: the body of the Interval window (IVL-UI-005) — one call,
// span or CPU run slice, from its interval document (IVL-007).
//
// Pure: one interval row in, HTML out, like heap/event-window.ts and for the
// same reason. Seqs are links (`data-seek`, a seq to seek to: one past the
// record, so it is applied) and the parent is a link (`data-ivl`, an interval
// to select); window-panel.ts wires them.

import { esc } from '../fmt.ts';
import { fmtFieldValue } from '../logs/logs-model.ts';
import { fmtDur } from './intervals-model.ts';
import type { IntervalRow } from './types.ts';

export type WindowContext = {
  /** The trace's time unit (`ns`, …), for durations and times. */
  unit?: string;
  /** The trace's first timestamp: times read relative to it. */
  t0?: number;
  /** A thread, short: its name, with its pid only in a multi-process trace. */
  thread: (thr: number | null | undefined, pid: number | null | undefined) => string;
  /** The parent interval, when it has been fetched: its name is shown. */
  parent?: IntervalRow | null;
};

/** The interval's kind in words. */
export function intervalKind(r: Pick<IntervalRow, 'category' | 'idle'>): string {
  if (r.category === 'call') return 'call';
  if (r.category === 'span') return 'span';
  return r.idle ? 'CPU idle slice' : 'CPU run slice';
}

/** The window's tab title: `Call · parse_body`, `Span · request`, `CPU 2 · worker-1`. */
export function intervalWindowTitle(r: IntervalRow | null | undefined): string {
  if (!r) return 'Interval';
  if (r.category === 'sched') return `CPU ${r.cpu ?? '?'} · ${r.idle ? 'idle' : (r.name ?? '?')}`;
  const what = r.category === 'call' ? 'Call' : 'Span';
  const name = r.name ?? (r.category === 'span' ? r.span : null);
  return name ? `${what} · ${name}` : what;
}

const NS_PER_UNIT: Record<string, number> = { ns: 1, us: 1e3, ms: 1e6, s: 1e9 };

/**
 * A time since the trace start, to the trace's own resolution — a call a few
 * ns long must not begin and end at the same printed time: `+0.004332512s`.
 * A trace without a known unit shows ticks.
 */
export function fmtOffset(dt: number, unit: string | undefined): string {
  const f = NS_PER_UNIT[unit ?? 'ns'];
  if (!f) return `+${Math.round(dt)}`;
  const digits = Math.max(0, Math.min(9, 9 - Math.round(Math.log10(f))));
  return `+${((Math.max(0, dt) * f) / 1e9).toFixed(digits)}s`;
}

const row = (k: string, v: string) => `<div class="row"><span class="k">${k}</span><span>${v}</span></div>`;

/** A seq as a link that seeks to just after that record. */
const seqLink = (seq: number) =>
  `<a class="ivl-link" href="#" data-seek="${seq + 1}" title="Seek to just after this record">seq ${seq.toLocaleString('en-US')}</a>`;

/** The interval's fields as rows, under a heading. */
function fieldsSection(title: string, fields: Record<string, unknown> | null | undefined): string {
  const entries = Object.entries(fields || {});
  if (!entries.length) return '';
  const rows = entries.map(([k, v]) => `<div class="row cf-row"><span class="k">${esc(k)}</span>`
    + `<span class="cf-value ${typeof v === 'number' ? 'cf-number' : typeof v === 'string' ? 'cf-string' : 'dim'}">${esc(fmtFieldValue(v))}</span><span></span></div>`);
  return `<div class="cf-head"><span>${esc(title)}</span></div><div class="cf-list">${rows.join('')}</div>`;
}

export function intervalWindowBody(r: IntervalRow, ctx: WindowContext): string {
  const t0 = ctx.t0 ?? 0;
  const when = (seq: number, t: number) => `${seqLink(seq)} <span class="dim">${esc(fmtOffset(t - t0, ctx.unit))}</span>`;
  const out: string[] = [];
  out.push(row('kind', esc(intervalKind(r))));
  if (r.category !== 'sched' || !r.idle) out.push(row('name', r.name ? esc(r.name) : '<span class="dim">unnamed</span>'));
  if (r.category === 'sched') {
    out.push(row('cpu', String(r.cpu ?? '?')));
    if (!r.idle && r.thr !== null && r.thr !== undefined) out.push(row('thread', esc(ctx.thread(r.thr, r.pid))));
  } else if (r.thr !== null && r.thr !== undefined) {
    out.push(row('thread', esc(ctx.thread(r.thr, r.pid))));
  }
  out.push(row('begin', when(r.seq, r.t)));
  if (r.open || r.end === null || r.end === undefined) out.push(row('end', '<span class="ivl-open">still open</span>'));
  else out.push(row('end', when(r.end, r.endT ?? r.t)));
  out.push(row('duration', `${r.open ? '≥ ' : ''}${esc(fmtDur(r.dur, ctx.unit))}`));
  if (r.category !== 'sched') {
    out.push(row('depth', String(r.depth)));
    if (r.parent === null || r.parent === undefined) {
      out.push(row('parent', '<span class="dim">none (a root)</span>'));
    } else {
      const p = ctx.parent && ctx.parent.ivl === r.parent ? ctx.parent : null;
      const label = p ? (p.name ?? p.span ?? `#${r.parent}`) : `#${r.parent}`;
      out.push(row('parent', `<a class="ivl-link" href="#" data-ivl="${r.parent}" title="Select the parent and seek to its begin">${esc(label)}</a>`));
    }
  }
  if (r.category === 'span') {
    out.push(row('span id', r.span ? esc(r.span) : '<span class="dim">none</span>'));
    if (r.parentSpan) out.push(row('parent id', esc(r.parentSpan)));
    if (r.endThr !== null && r.endThr !== undefined && r.endThr !== r.thr) {
      out.push(row('ended on', esc(ctx.thread(r.endThr, r.pid))));
    }
  }
  if (r.implicitClose) out.push(row('note', 'closed by an outer frame\'s return'));
  if (r.doubleRun) out.push(row('note', 'its thread was already running on another CPU'));
  return out.join('')
    + fieldsSection('fields at begin', r.fields)
    + fieldsSection('fields at end', r.endFields);
}
