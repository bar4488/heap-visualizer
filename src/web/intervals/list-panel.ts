// Interval domain: the Intervals panel (IVL-UI-004) — every call, span and run
// slice as a virtualized table from `domain-query`, filtered by category,
// track, text and minimum duration, in start order either way. The list is
// virtualized as the Logs terminal is (the same capped spacer and row window,
// from logs-model.ts), fetched one window at a time under one requestLatest
// key. Clicking a row seeks to the interval's begin and selects it
// (IVL-UI-005); the selected interval's row is highlighted.

import { esc } from '../fmt.ts';
import { firstRow, fmtRelTime, logLayout, rowWindow } from '../logs/logs-model.ts';
import {
  DEFAULT_LIST_QUERY, cpuKey, fmtDur, listParams, normalizeListQuery, orderTracks, pageFor, parseDur, rowPosition,
  sameListQuery, sameSelection, seekSeqFor, shownLabel, threadKey, threadLabel, trackText, type ListQuery,
} from './intervals-model.ts';
import { intervalSelection, isSelected } from './selection.ts';
import { panelElement, present, shown, type Shared } from './shared.ts';
import type { IntervalRow } from './types.ts';

const TYPE = 'intervals-list';
const KEY = 'intervals-list-rows';

const CAT_LABEL = { call: 'call', span: 'span', sched: 'cpu' };

export function createListPanel(sh: Shared) {
  const el = panelElement('intervals-list-panel');
  el.insertAdjacentHTML('beforeend', `
    <div class="ivl-bar">
      <select class="ivl-cat" title="Category">
        <option value="">all</option><option value="call">calls</option><option value="span">spans</option><option value="sched">cpu slices</option>
      </select>
      <select class="ivl-track" title="Thread or CPU"><option value="">all tracks</option></select>
      <input class="ivl-text" type="search" placeholder="name / span id" autocomplete="off" spellcheck="false"
        title="Case-insensitive substring of the name or the span id">
      <input class="ivl-mindur" placeholder="min dur" size="8" autocomplete="off" spellcheck="false"
        title="Minimum duration: 250us, 1.5ms, 2s, or a number in trace units. An open interval lasts to the trace end.">
    </div>
    <div class="ivl-cols"><button class="ivl-sort" title="Sort by start">start ▲</button><span class="c-dur">dur</span><span class="c-cat">kind</span><span class="c-trk">track</span><span>name</span></div>
    <div class="ivl-lscroll" tabindex="0"><div class="ivl-spacer"></div><div class="ivl-rows"></div><div class="ivl-empty" hidden></div></div>`);
  const q$ = (s: string) => el.querySelector(s) as any;
  const sc = q$('.ivl-lscroll');
  const rowsEl = q$('.ivl-rows');

  const st = {
    query: DEFAULT_LIST_QUERY as ListQuery,
    gen: 0,
    total: -1,
    rows: [] as IntervalRow[],
  };

  const unit = () => sh.ctx.ui.meta?.unit;
  const layout = () => logLayout(Math.max(0, st.total), sc.clientHeight);

  function heading() {
    const all = sh.trace.total;
    q$('.ivl-count').textContent = present(sh) && st.total >= 0 && all >= 0 ? shownLabel(st.total, all) : '';
    q$('.ivl-sort').textContent = `start ${st.query.desc ? '▼' : '▲'}`;
    const empty = q$('.ivl-empty');
    let msg = '';
    if (sh.ctx.ui.loaded && sh.trace.total === 0) msg = 'this trace has no intervals';
    else if (st.total === 0) msg = 'no intervals match';
    empty.textContent = msg;
    empty.hidden = !msg;
  }

  function queryChanged(resetScroll = true) {
    st.gen++;
    if (resetScroll) st.total = -1;
    st.rows = [];
    rowsEl.innerHTML = '';
    if (resetScroll) sc.scrollTop = 0;
    heading();
    refresh();
  }

  function refresh() {
    if (!shown(sh, TYPE) || !present(sh)) return;
    const L = layout();
    q$('.ivl-spacer').style.height = `${L.spacerH}px`;
    const first = st.total < 0 ? 0 : firstRow(L, sc.scrollTop);
    const win = st.total < 0 ? { from: 0, count: L.visN } : rowWindow(L, first);
    // until the total is known, ask the first page in begin order to learn it
    const page = st.total < 0 ? { ...win, reverse: false } : pageFor(st.query, st.total, win.from, win.count);
    rowsEl.style.top = `${sc.scrollTop}px`;
    const gen = st.gen;
    sh.ctx.requestLatest(KEY, 'domain-query', {
      domain: 'intervals', query: { ...listParams(st.query), from: page.from, count: Math.max(1, page.count) },
    }).then((m) => {
      if (gen !== st.gen) return;
      const r = m.available ? m.result : null;
      const total = r ? r.total : 0;
      if (total !== st.total) {
        // the match count is (re)learned: lay out once more with it
        st.total = total;
        heading();
        refresh();
        return;
      }
      st.rows = r ? (page.reverse ? r.rows.slice().reverse() : r.rows) : [];
      render();
    });
  }

  function render() {
    const applied = sh.playhead?.seq ?? 0;
    const t0 = sh.ctx.ui.meta?.tMin ?? 0;
    rowsEl.innerHTML = st.rows.map((r) => {
      const pos = rowPosition(r, applied);
      const name = r.category === 'span' && r.span ? `${r.name ?? ''} [${r.span}]` : (r.name ?? '?');
      const indent = r.category === 'call' ? Math.min(r.depth, 20) : 0;
      const sel = isSelected(sh.sel, r.ivl) ? ' sel' : '';
      return `<div class="ivl-lrow ${pos} c-${r.category}${sel}" data-seq="${r.seq}" data-ivl="${r.ivl}">`
        + `<span class="c-t">${fmtRelTime(r.t - t0, unit())}</span>`
        + `<span class="c-dur">${r.open ? '≥' : ''}${fmtDur(r.dur, unit())}</span>`
        + `<span class="c-cat">${CAT_LABEL[r.category] ?? r.category}</span>`
        + `<span class="c-trk">${esc(trackText(r))}</span>`
        + `<span class="c-name">${'· '.repeat(indent)}${esc(name)}</span></div>`;
    }).join('');
  }

  function fillTracks() {
    const sel = q$('.ivl-track');
    const keep = sel.value;
    const { threads, cpus } = orderTracks(sh.trace.tracks.threads, sh.trace.tracks.cpus);
    sel.innerHTML = '<option value="">all tracks</option>'
      + threads.map((t) => `<option value="${threadKey(t)}">${esc(threadLabel(t))}</option>`).join('')
      + cpus.map((c) => `<option value="${cpuKey(c.cpu)}">cpu ${c.cpu}</option>`).join('');
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
  }

  function setQuery(patch: Partial<ListQuery>) {
    const q = normalizeListQuery({ ...st.query, ...patch });
    if (sameListQuery(q, st.query)) return;
    const sameRows = sameSelection(q, st.query);
    st.query = q;
    if (sameRows) { st.gen++; sc.scrollTop = 0; heading(); refresh(); } // only the order flipped
    else queryChanged();
  }

  q$('.ivl-cat').onchange = () => setQuery({ category: q$('.ivl-cat').value });
  q$('.ivl-track').onchange = () => setQuery({ track: q$('.ivl-track').value });
  q$('.ivl-sort').onclick = () => setQuery({ desc: !st.query.desc });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (fn: () => void) => () => { if (timer) clearTimeout(timer); timer = setTimeout(fn, 150); };
  q$('.ivl-text').oninput = debounced(() => setQuery({ text: q$('.ivl-text').value }));
  q$('.ivl-mindur').oninput = debounced(() => {
    const box = q$('.ivl-mindur');
    const v = parseDur(box.value, unit());
    box.classList.toggle('bad', v === null);
    if (v !== null) setQuery({ minDur: v });
  });
  sc.addEventListener('scroll', () => refresh());
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => refresh()).observe(sc);
  rowsEl.addEventListener('click', (e: MouseEvent) => {
    const row = (e.target as HTMLElement).closest?.('.ivl-lrow') as HTMLElement | null;
    if (!row || window.getSelection?.()?.toString()) return;
    sh.ctx.post({ type: 'jump', seq: seekSeqFor(+row.dataset.seq) });
    sh.ctx.selectInterval?.(intervalSelection(+row.dataset.ivl, { x: e.clientX, y: e.clientY }));
  });

  let lastApplied = NaN;
  return {
    el,
    refresh() { heading(); refresh(); },
    reset() {
      st.query = DEFAULT_LIST_QUERY;
      q$('.ivl-cat').value = '';
      q$('.ivl-text').value = '';
      q$('.ivl-mindur').value = '';
      q$('.ivl-mindur').classList.remove('bad');
      fillTracks();
      queryChanged();
    },
    traceReady() { fillTracks(); queryChanged(); },
    selected() { if (shown(sh, TYPE)) render(); },
    playhead() {
      // re-mark open/past/future; the rows themselves do not change
      const a = sh.playhead?.seq ?? 0;
      if (a === lastApplied || !shown(sh, TYPE)) return;
      lastApplied = a;
      render();
    },
  };
}
