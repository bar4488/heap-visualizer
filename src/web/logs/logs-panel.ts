// Log domain: the Logs panel (spec LOG-007) — the trace's log lines as a
// terminal that follows the playhead.
//
// The list is virtualized the way the Events panel is (stream/events-panel.ts):
// a spacer sized to the match count, capped, and one absolutely-placed block
// holding only the lines in view, fetched from the engine per window. Unlike
// that panel it talks through rpc.ts's coalescing `requestLatest` — the
// generic `domain-query` / `domain-locate` with `domain: "logs"` (DOM-004) — under keys
// no other feature uses, so a fast scroll or playback never builds a backlog.
//
// Two things move the list: the user's scroll, and — while following — the
// playhead. Each `state` message asks the engine to locate the playhead's
// line in the current matches (a `domain-locate` on `logs`); following then scrolls only
// when that line is out of view, so playback reads like `tail -f`. Scrolling
// by hand turns follow off; the head's checkbox turns it back on.
//
// The arithmetic is in logs-model.ts and tested there; this file is the DOM.

import { $ } from '../shell/dom.ts';
import { layout as windows } from '../shell/layout.ts';
import { esc } from '../fmt.ts';
import type { LogRow, LogsMeta, QueryPayload, QueryType, ReplyTo } from '../protocol.ts';
import {
  DEFAULT_QUERY, countAtLeast, firstRow, firstRowFor, followTarget, formatLogLine,
  isScrollKey, levelIndex, lineParts, lineState, logLayout, normalizeQuery, playheadSeq,
  rowWindow, sameQuery, scrollTopForFirst, shownLabel, type LogQuery,
} from './logs-model.ts';

type Deps = {
  ui: { loaded: boolean; meta: { logs?: LogsMeta | null; tMin?: number; unit?: string } | null; state: { seq: number } | null };
  post: (m: any) => void;
  requestLatest: <T extends QueryType>(key: string, type: T, payload: QueryPayload<T>) => Promise<ReplyTo[T]>;
};

let d: Deps = null;

// requestLatest keys: unique to this panel, one per independent stream
const KEY_ROWS = 'logs-panel-rows';
const KEY_LOCATE = 'logs-panel-locate';
const KEY_REVEAL = 'logs-panel-reveal';
/** The log domain's registry id (DOM-004). */
const LOGS = 'logs';

const st = {
  meta: null as LogsMeta | null,
  query: DEFAULT_QUERY as LogQuery,
  /** Bumped whenever the match list changes meaning (query, trace). */
  gen: 0,
  /** Matches of the current query, or -1 until the engine has said. */
  total: -1,
  from: 0,
  rows: [] as LogRow[],
  /** The locate result: the last match at or before the playhead, or -1. */
  playheadRow: -1,
  /** The seq last located, so an unchanged playhead asks nothing. */
  locatedSeq: NaN,
  revealSeq: -1,
};

const scroller = () => $('logs-scroll');
const visible = () => windows.isOpen('logs-panel');

/** Whether the loaded trace has any log record — the panel's default-open rule. */
export function logsPresent(): boolean {
  return !!st.meta && st.meta.count > 0;
}

function following(): boolean {
  return $('log-follow').checked;
}

function setFollow(on: boolean) {
  if ($('log-follow').checked === on) return;
  $('log-follow').checked = on;
  if (on) relocate();
}

export function initLogsPanel(deps: Deps) {
  d = deps;
  wire();
}

/** A freshly loaded trace (the panel table's build step). */
export function resetLogsPanel() {
  st.meta = d.ui.meta?.logs ?? null;
  st.query = DEFAULT_QUERY;
  $('log-level').value = '0';
  $('log-search').value = '';
  $('log-follow').checked = true;
  st.revealSeq = -1;
  queryChanged();
}

function queryChanged() {
  st.gen++;
  st.total = st.query.text ? -1 : countAtLeast(st.meta, st.query.minLevel);
  st.rows = [];
  st.playheadRow = -1;
  st.locatedSeq = NaN;
  $('logs-rows').innerHTML = '';
  scroller().scrollTop = 0;
  updateHeading();
  refreshLogsPanel();
  updateLogsPanel();
}

function updateHeading() {
  $('log-count').textContent = logsPresent() && st.total >= 0 ? shownLabel(st.total, st.meta.count) : '';
  const empty = $('logs-empty');
  let msg = '';
  if (!st.meta) msg = d.ui.loaded ? 'this build has no log support' : '';
  else if (!st.meta.count) msg = 'this trace has no log records';
  else if (st.total === 0) msg = 'no lines match';
  empty.textContent = msg;
  empty.hidden = !msg;
}

function layout() {
  return logLayout(Math.max(0, st.total), scroller().clientHeight);
}

/** Fetch and draw the lines in view. */
export function refreshLogsPanel() {
  if (!d.ui.loaded || !visible() || !logsPresent()) return;
  const L = layout();
  $('logs-spacer').style.height = `${L.spacerH}px`;
  const sc = scroller();
  const from = st.total < 0 ? 0 : firstRow(L, sc.scrollTop);
  const win = st.total < 0 ? { from: 0, count: L.visN } : rowWindow(L, from);
  $('logs-rows').style.top = `${sc.scrollTop}px`;
  const gen = st.gen;
  d.requestLatest(KEY_ROWS, 'domain-query', { domain: LOGS, query: { ...st.query, ...win } }).then(({ result: m }) => {
    if (gen !== st.gen) return;
    if (m.total !== st.total) {
      // the match count is (re)learned: lay out once more with it — the next
      // reply carries the same total, so this converges at once
      st.total = m.total;
      updateHeading();
      refreshLogsPanel();
      return;
    }
    st.from = m.from;
    st.rows = m.rows as LogRow[];
    renderRows();
  });
}

function renderRows() {
  const cur = playheadSeq(d.ui.state?.seq);
  const t0 = d.ui.meta?.tMin ?? 0;
  const unit = d.ui.meta?.unit;
  $('logs-rows').innerHTML = st.rows.map((r) => {
    const p = lineParts(r, t0, unit);
    const pos = lineState(r, cur, st.playheadRow);
    const cls = `log-line lv-${levelIndex(r.level)}${pos === 'past' ? '' : ` ${pos}`}${r.seq === st.revealSeq ? ' reveal' : ''}`;
    // spaces between the spans are real text, so a native copy of part of a
    // line still reads as one
    return `<div class="${cls}" data-seq="${r.seq}" data-row="${r.row}">`
      + `<span class="lg-t">${p.time}</span> <span class="lg-thr">[${esc(p.thr)}]</span> `
      + `<span class="lg-lv">${p.level}</span> `
      + (p.logger ? `<span class="lg-name">${esc(p.logger)}</span> ` : '')
      + `<span class="lg-msg">${esc(p.msg)}</span>`
      + (p.fields ? ` <span class="lg-f">${esc(p.fields)}</span>` : '')
      + '</div>';
  }).join('');
}

/** The playhead moved (or may have): re-mark lines, and follow. */
export function updateLogsPanel() {
  if (!d.ui.loaded || !visible() || !logsPresent() || !d.ui.state) return;
  const cur = playheadSeq(d.ui.state.seq);
  if (cur === st.locatedSeq) return;
  st.locatedSeq = cur;
  relocate();
}

function relocate() {
  if (!d.ui.loaded || !visible() || !logsPresent() || !d.ui.state) return;
  const seq = playheadSeq(d.ui.state.seq);
  const gen = st.gen;
  d.requestLatest(KEY_LOCATE, 'domain-locate', { domain: LOGS, query: { ...st.query, seq } }).then(({ result: m }) => {
    if (gen !== st.gen) return;
    st.playheadRow = m.row;
    if (m.total !== st.total) { st.total = m.total; updateHeading(); }
    const L = layout();
    const target = followTarget(L, st.from, m.row, following());
    if (target !== null && target !== st.from) {
      scroller().scrollTop = scrollTopForFirst(L, target);
      refreshLogsPanel();
    } else {
      renderRows();
    }
  });
}

/**
 * Show one record's line (an L row clicked in the Events list, LOG-006): open
 * the panel if it is closed, and center the line — or, when the current level
 * or search hides it, the nearest match before it.
 */
export function revealLogSeq(seq: number) {
  if (!d.ui.loaded || !logsPresent()) return;
  windows.reveal('logs-panel');
  // the flash is one animation, not a state: lines re-render as the playhead
  // moves, and a class that stayed would replay it on every render
  st.revealSeq = seq;
  setTimeout(() => { if (st.revealSeq === seq) st.revealSeq = -1; }, 1400);
  const gen = st.gen;
  d.requestLatest(KEY_REVEAL, 'domain-locate', { domain: LOGS, query: { ...st.query, seq } }).then(({ result: m }) => {
    if (gen !== st.gen || m.row < 0) return;
    st.total = m.total;
    updateHeading();
    const L = layout();
    scroller().scrollTop = scrollTopForFirst(L, firstRowFor(L, m.row, 'center'));
    refreshLogsPanel();
  });
}

/** The selected lines as plain text, one per line; null with no selection. */
function selectedText(): string | null {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed) return null;
  const t0 = d.ui.meta?.tMin ?? 0;
  const lines = st.rows.filter((r) => {
    const el = $('logs-rows').querySelector(`[data-row="${r.row}"]`);
    return el && sel.containsNode(el, true);
  });
  return lines.length ? lines.map((r) => formatLogLine(r, t0, d.ui.meta?.unit)).join('\n') : null;
}

function wire() {
  const sc = scroller();
  sc.addEventListener('scroll', () => refreshLogsPanel());
  new ResizeObserver(() => refreshLogsPanel()).observe(sc);

  // scrolling by hand is what turns follow off; a scroll event alone cannot
  // say who scrolled, so the hand's own inputs are what is listened to
  sc.addEventListener('wheel', () => setFollow(false), { passive: true });
  sc.addEventListener('touchmove', () => setFollow(false), { passive: true });
  sc.addEventListener('keydown', (e: KeyboardEvent) => { if (isScrollKey(e.key)) setFollow(false); });
  // the scrollbar: a press on the scroller itself rather than on a line
  sc.addEventListener('pointerdown', (e: PointerEvent) => { if (e.target === sc) setFollow(false); });

  $('logs-rows').addEventListener('click', (e: MouseEvent) => {
    const line = (e.target as HTMLElement).closest?.('.log-line') as HTMLElement | null;
    if (!line) return;
    // finishing a text selection is not a click on a line
    if (window.getSelection?.()?.toString()) return;
    st.revealSeq = -1;
    d.post({ type: 'jump', seq: +line.dataset.seq + 1, select: true });
  });
  // copy whole lines as plain text rather than as the spans' markup
  sc.addEventListener('copy', (e: ClipboardEvent) => {
    const text = selectedText();
    if (text === null || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  });

  $('log-level').onchange = () => {
    st.query = normalizeQuery({ ...st.query, minLevel: +$('log-level').value });
    queryChanged();
  };
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  $('log-search').oninput = () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = normalizeQuery({ ...st.query, text: $('log-search').value });
      if (sameQuery(q, st.query)) return;
      st.query = q;
      queryChanged();
    }, 150);
  };
  $('log-follow').onchange = () => { if (following()) relocate(); };

  // the shell shows the window (its toolbar toggle is in the panel table);
  // the terminal was not kept current while closed, so it catches up on opening
  windows.onOpen('logs-panel', () => {
    st.locatedSeq = NaN;
    updateHeading();
    refreshLogsPanel();
    updateLogsPanel();
  });
}

