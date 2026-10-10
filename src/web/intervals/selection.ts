// Interval domain: the interval selection (IVL-UI-005) — one call, span or
// run slice that the Events list, Tracks, Stacks and Intervals agree on.
// It is kept apart from the allocation selection: selecting an interval
// leaves the selected allocation alone, and the reverse.
//
// A selection is made either from an interval (`ivl`, known to Tracks,
// Stacks and Intervals) or from an edge record (`seq`, all the Events list
// knows): the interval module resolves an edge to the interval it begins or
// ends through `domain-query` with `edge`, and the selection then carries
// both, with the interval's begin and end seqs so the Events list can mark
// its edges. Pure, so `node --test` covers it.

import type { IntervalParams, IntervalRow } from './types.ts';

export type IntervalSelection = {
  /** The interval, or null until an edge is resolved. */
  ivl: number | null;
  /** The edge record clicked, when the selection came from one. */
  seq?: number;
  /** The interval's begin and end seqs, once resolved (end null while open). */
  begin?: number;
  end?: number | null;
  /** Where the click was (client px): the window opens beside it. */
  at?: { x: number; y: number };
};

/** A selection from an Events-list edge row. */
export function edgeSelection(seq: number, at?: { x: number; y: number }): IntervalSelection {
  return at ? { ivl: null, seq, at } : { ivl: null, seq };
}

/** A selection from an interval (a Tracks bar, a Stacks frame, an Intervals row). */
export function intervalSelection(ivl: number, at?: { x: number; y: number }): IntervalSelection {
  return at ? { ivl, at } : { ivl };
}

/** Whether an Events-list row of `domain` is an interval edge, which selects an interval. */
export function isEdgeRow(domain: string | undefined): boolean {
  return domain === 'intervals';
}

/** The `domain-query` operands that find the selection's interval: by id, else by edge. */
export function selectionQuery(sel: IntervalSelection): Pick<IntervalParams, 'ivl' | 'edge'> | null {
  if (sel.ivl !== null && sel.ivl !== undefined) return { ivl: sel.ivl };
  if (typeof sel.seq === 'number' && sel.seq >= 0) return { edge: sel.seq };
  return null;
}

/** The selection once its interval is known: the id, and its begin and end seqs. */
export function resolved(sel: IntervalSelection, row: IntervalRow): IntervalSelection {
  return { ...sel, ivl: row.ivl, begin: row.seq, end: row.end };
}

/** Whether a selection names the same interval (or the same unresolved edge) as another. */
export function sameSelection(a: IntervalSelection | null, b: IntervalSelection | null): boolean {
  if (!a || !b) return a === b;
  if (a.ivl !== null && b.ivl !== null) return a.ivl === b.ivl;
  return a.ivl === b.ivl && a.seq === b.seq;
}

/** Whether `ivl` is the selected interval. */
export function isSelected(sel: IntervalSelection | null, ivl: number | null | undefined): boolean {
  return !!sel && sel.ivl !== null && ivl !== null && ivl !== undefined && sel.ivl === ivl;
}

/** The Events-list seqs to mark for a selection: the edge clicked, and the interval's two edges. */
export function selectedEdges(sel: IntervalSelection | null): Set<number> {
  const out = new Set<number>();
  if (!sel) return out;
  for (const s of [sel.seq, sel.begin, sel.end]) if (typeof s === 'number' && s >= 0) out.add(s);
  return out;
}
