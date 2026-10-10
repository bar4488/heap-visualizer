// Interval domain: the Interval window (IVL-UI-005) — one live window that
// follows the interval selection, as the Event window follows a mark. It is
// floating and not persisted; a new selection changes its content and brings
// it to the front, never its place. The body is interval-window.ts; this file
// is its element and its links (seek to a begin or end, select the parent).

import { intervalWindowBody, intervalWindowTitle } from './interval-window.ts';
import { seekSeqFor } from './intervals-model.ts';
import { intervalSelection } from './selection.ts';
import { panelElement, type Shared } from './shared.ts';
import { threadLabel, threadNames } from '../stream/stream-model.ts';
import type { IntervalRow } from './types.ts';

export const WINDOW_TYPE = 'interval-window';

export function createIntervalWindow(sh: Shared) {
  const el = panelElement('interval-window');
  el.querySelector('.ivl-count')?.remove();
  const body = document.createElement('div');
  body.className = 'panel-body detail-body ivl-window';
  el.appendChild(body);

  /** The parent of the shown interval, fetched for its name. */
  let parent: IntervalRow | null = null;

  function render() {
    const r = sh.selRow;
    const t = el.querySelector('.ph-t') as HTMLElement;
    t.textContent = intervalWindowTitle(r);
    if (!r) { body.innerHTML = ''; return; }
    const meta = sh.ctx.ui.meta;
    const names = threadNames(meta?.domains);
    body.innerHTML = intervalWindowBody(r, {
      unit: meta?.unit, t0: meta?.tMin ?? 0,
      thread: (thr, pid) => threadLabel(thr, pid, names) || '–',
      parent,
    });
  }

  body.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest?.('a[data-seek], a[data-ivl]') as HTMLElement | null;
    if (!a) return;
    e.preventDefault();
    if (a.dataset.seek !== undefined) {
      sh.ctx.post({ type: 'jump', seq: +a.dataset.seek });
      return;
    }
    const ivl = +a.dataset.ivl;
    const p = parent && parent.ivl === ivl ? parent : null;
    if (p) sh.ctx.post({ type: 'jump', seq: seekSeqFor(p.seq) });
    sh.ctx.selectInterval?.(intervalSelection(ivl));
  });

  return {
    el,
    /** Show the selected interval (sh.selRow); open the window beside `at` when it is closed. */
    show(at?: { x: number; y: number }) {
      parent = null;
      render();
      const r = sh.selRow;
      if (!r) { if (sh.ctx.layout.isOpen(WINDOW_TYPE)) sh.ctx.layout.close?.(WINDOW_TYPE); return; }
      sh.ctx.layout.reveal(WINDOW_TYPE, '', at ? { near: at } : {});
      if (r.parent !== null && r.parent !== undefined) {
        const want = r.ivl;
        void sh.ctx.request('domain-query', { domain: 'intervals', query: { ivl: r.parent, from: 0, count: 1 } }).then((m) => {
          if (sh.selRow?.ivl !== want) return;
          parent = m.available && m.result?.rows[0] ? m.result.rows[0] : null;
          render();
        });
      }
    },
    /** A new trace: nothing selected, the window closed. */
    reset() {
      parent = null;
      render();
      if (sh.ctx.layout.isOpen(WINDOW_TYPE)) sh.ctx.layout.close?.(WINDOW_TYPE);
    },
  };
}
