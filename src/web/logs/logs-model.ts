// Log domain: the Logs panel's pure logic — level names, the virtual-list
// arithmetic, follow/playhead math, query state, and line formatting. No DOM
// and no worker here, so `node --test` covers all of it directly
// (src/web/test/logs-model.test.ts). The panel itself is logs-panel.ts.
//
// The engine owns what a log row is (spec LOG-009); this file only reads it.

import type { LogRow, LogsMeta } from '../protocol.ts';

/** The engine's op code for a log (`L`) record in the events JSON. */
export const OP_LOG = 4;

/** LOG-002: severity order, encoded 0–5. */
export const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LevelName = typeof LEVELS[number];

const ALIASES: Record<string, number> = { warning: 3, err: 4 };

/**
 * A level as an index 0–5. The engine sends a number; a string (a record read
 * some other way) is mapped by name, with LOG-001's aliases. Anything else is
 * `info`, which is also what the core reads an unknown level as.
 */
export function levelIndex(v: unknown): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < LEVELS.length) return v;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    const i = (LEVELS as readonly string[]).indexOf(s);
    if (i >= 0) return i;
    if (s in ALIASES) return ALIASES[s];
  }
  return 2;
}

export function levelName(v: unknown): LevelName {
  return LEVELS[levelIndex(v)];
}

/** Badge text: fixed width, so messages line up like a terminal's. */
export function levelBadge(v: unknown): string {
  return levelName(v).toUpperCase().padEnd(5, ' ');
}

// --- query state --------------------------------------------------------------

/** LOG-004, minus the paging: what the selector and the search box say. */
export type LogQuery = { minLevel: number; text: string };

export const DEFAULT_QUERY: LogQuery = { minLevel: 0, text: '' };

/** The query as sent: level clamped, search text trimmed. */
export function normalizeQuery(q: Partial<LogQuery>): LogQuery {
  const lv = Math.round(Number(q.minLevel));
  return {
    minLevel: Number.isFinite(lv) ? Math.max(0, Math.min(LEVELS.length - 1, lv)) : 0,
    text: (q.text ?? '').trim(),
  };
}

export function sameQuery(a: LogQuery, b: LogQuery): boolean {
  return a.minLevel === b.minLevel && a.text === b.text;
}

/**
 * The count a query can match before it is asked: everything at or above
 * `minLevel`, from the load-time per-level counts. A text search can only
 * narrow it further, so this is exact when `text` is empty and an upper bound
 * otherwise.
 */
export function countAtLeast(meta: LogsMeta | null, minLevel: number): number {
  if (!meta) return 0;
  let n = 0;
  for (let i = Math.max(0, minLevel); i < meta.byLevel.length; i++) n += meta.byLevel[i] || 0;
  return n;
}

/** The heading's `shown / total`: matches of the query, of all log records. */
export function shownLabel(shown: number, total: number): string {
  const f = (n: number) => Math.max(0, n).toLocaleString('en-US');
  return `${f(shown)} / ${f(total)}`;
}

// --- the virtual list ----------------------------------------------------------

/** px per line. */
export const LOG_ROW = 18;
/** Same element-height cap as the Events panel (NAV-005), same consequence. */
export const LOG_MAX_SPACER = 12e6;
/** LOG-004's page bound. */
export const LOG_PAGE_MAX = 500;

export type LogLayout = {
  n: number;
  viewH: number;
  spacerH: number;
  /** Lines needed to cover the viewport, plus one partly shown. */
  visN: number;
  /** The highest first row. */
  maxFrom: number;
};

export function logLayout(n: number, viewH: number): LogLayout {
  n = Math.max(0, n);
  const spacerH = Math.min(n * LOG_ROW, LOG_MAX_SPACER);
  const visN = Math.min(LOG_PAGE_MAX, Math.max(1, Math.ceil(viewH / LOG_ROW) + 1));
  const maxFrom = Math.max(0, n - visN + 1);
  return { n, viewH, spacerH, visN, maxFrom };
}

/** The first row shown at `scrollTop`; index-mapped once the spacer is capped. */
export function firstRow(L: LogLayout, scrollTop: number): number {
  const denom = Math.max(1, L.spacerH - L.viewH);
  return Math.max(0, Math.min(L.maxFrom, Math.round((scrollTop / denom) * L.maxFrom)));
}

/** The rows to fetch for a first row: never past the end, never over a page. */
export function rowWindow(L: LogLayout, from: number): { from: number; count: number } {
  const f = Math.max(0, Math.min(from, Math.max(0, L.n - 1)));
  return { from: f, count: Math.max(0, Math.min(L.visN, L.n - f)) };
}

/** The scrollTop that makes `from` the first row — firstRow's inverse. */
export function scrollTopForFirst(L: LogLayout, from: number): number {
  const target = Math.max(0, Math.min(L.maxFrom, from));
  return (target / Math.max(1, L.maxFrom)) * Math.max(0, L.spacerH - L.viewH);
}

/** Lines that fit wholly in the viewport. */
export function fullLines(L: LogLayout): number {
  return Math.max(1, Math.floor(L.viewH / LOG_ROW));
}

/** Whether `row` is wholly visible when `from` is the first row. */
export function rowFullyVisible(L: LogLayout, from: number, row: number): boolean {
  return row >= from && row < from + fullLines(L);
}

/**
 * The first row that puts `row` in view: `'bottom'` is `tail -f` — the line is
 * the last whole one, with history above it; `'center'` is for revealing a
 * line someone asked for.
 */
export function firstRowFor(L: LogLayout, row: number, place: 'bottom' | 'center'): number {
  const full = fullLines(L);
  const from = place === 'bottom' ? row - full + 1 : row - Math.floor(full / 2);
  return Math.max(0, Math.min(L.maxFrom, from));
}

// --- the playhead --------------------------------------------------------------

/**
 * The seq of the last applied record, as the Events panel reads it: a `state`
 * message's `seq` counts applied records, so the current one is `seq - 1`
 * (and -1 before the first).
 */
export function playheadSeq(stateSeq: number | null | undefined): number {
  return typeof stateSeq === 'number' ? stateSeq - 1 : -1;
}

/**
 * A line relative to the playhead (LOG-007): `future` has not happened yet and
 * is dimmed; `cur` is the line at or before the playhead (the locate result);
 * everything else is `past`.
 */
export function lineState(row: Pick<LogRow, 'row' | 'seq'>, curSeq: number, playheadRow: number): 'future' | 'cur' | 'past' {
  if (row.seq > curSeq) return 'future';
  if (row.row === playheadRow) return 'cur';
  return 'past';
}

/**
 * Follow (LOG-007): where the list should move after a locate, or null to stay
 * put. Only while following, and only when the playhead line is not already
 * wholly in view — a line that is visible is left where it is, so playback
 * reads like a terminal that scrolls once output reaches the bottom.
 */
export function followTarget(L: LogLayout, from: number, playheadRow: number, follow: boolean): number | null {
  if (!follow || playheadRow < 0 || L.n === 0) return null;
  if (rowFullyVisible(L, from, playheadRow)) return null;
  return firstRowFor(L, playheadRow, 'bottom');
}

/** Keys that scroll a focused list; pressing one is scrolling by hand. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
export function isScrollKey(key: string): boolean {
  return SCROLL_KEYS.has(key);
}

// --- formatting ----------------------------------------------------------------

const NS_PER_UNIT: Record<string, number> = { ns: 1, us: 1e3, ms: 1e6, s: 1e9 };

/**
 * Time since the start of the trace, fixed-width-ish and in the largest unit
 * that keeps it readable: `+0.000124s`. Ticks (an unknown unit) stay ticks.
 */
export function fmtRelTime(dt: number, unit: string | undefined): string {
  const f = NS_PER_UNIT[unit ?? 'ns'];
  if (!f) return `+${Math.round(dt)}`;
  const s = (Math.max(0, dt) * f) / 1e9;
  return `+${s.toFixed(6)}s`;
}

/** A custom field's value as `key=value` shows it: bare when unambiguous. */
export function fmtFieldValue(v: unknown): string {
  if (typeof v === 'string') return v !== '' && /^[^\s"=]+$/.test(v) ? v : JSON.stringify(v);
  if (v === undefined) return 'null';
  return JSON.stringify(v);
}

export function fmtFields(fields: Record<string, unknown> | null | undefined): string {
  if (!fields) return '';
  return Object.entries(fields).map(([k, v]) => `${k}=${fmtFieldValue(v)}`).join(' ');
}

/** The parts of one line, in display order (LOG-007). */
export function lineParts(row: LogRow, t0: number, unit: string | undefined) {
  return {
    time: fmtRelTime(row.t - t0, unit),
    thr: row.thr === null || row.thr === undefined ? '-' : String(row.thr),
    level: levelBadge(row.level),
    logger: row.logger || '',
    msg: row.msg ?? '',
    fields: fmtFields(row.fields),
  };
}

/** One line as plain text — what copying a selection puts on the clipboard. */
export function formatLogLine(row: LogRow, t0: number, unit: string | undefined): string {
  const p = lineParts(row, t0, unit);
  return [p.time, `[${p.thr}]`, p.level, p.logger, p.msg, p.fields].filter((s) => s !== '').join(' ');
}

/** The status-bar line for stepping onto a log record. */
export function logStatusText(ev: { seq: number; level?: unknown; logger?: string | null; msg?: string }): string {
  const who = ev.logger ? ` ${ev.logger}:` : '';
  return `log ${levelName(ev.level)}${who} ${ev.msg ?? ''} · seq ${ev.seq.toLocaleString('en-US')}`;
}

/**
 * The strip tooltip's log line (LOG-005): the count, then each non-empty
 * level from most severe down. Empty when the column holds no log.
 */
export function logsHoverText(logs: { count: number; byLevel: number[] } | null | undefined): string {
  if (!logs || !logs.count) return '';
  const parts: string[] = [];
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    const n = logs.byLevel?.[i] || 0;
    if (n) parts.push(`${n.toLocaleString('en-US')} ${LEVELS[i]}`);
  }
  return `logs ${logs.count.toLocaleString('en-US')}${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
}
