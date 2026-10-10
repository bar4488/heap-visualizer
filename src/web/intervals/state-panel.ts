// Interval domain: the Stacks panel (IVL-UI-002) — what is open at the
// playhead, from `domain-state`: each thread's call stack (outermost at the
// top, innermost at the bottom), the open spans as a parent tree, and what
// every CPU is running. Asked once per playhead move, coalesced under one
// requestLatest key, so playback never builds a backlog. Clicking a frame,
// span or slice seeks to its begin and selects it (IVL-UI-005); the selected
// interval is highlighted while it is open at the playhead.

import { esc } from '../fmt.ts';
import { orderStateThreads, seekSeqFor, spanTree, threadLabel } from './intervals-model.ts';
import { intervalSelection, isSelected } from './selection.ts';
import { panelElement, present, shown, type Shared } from './shared.ts';
import type { IntervalState } from './types.ts';

const TYPE = 'intervals-state';
const KEY = 'intervals-state';

export function createStatePanel(sh: Shared) {
  const el = panelElement('intervals-state-panel');
  const body = document.createElement('div');
  body.className = 'ivl-state';
  el.appendChild(body);

  let askedSeq = NaN;
  let last: IntervalState | null = null;

  const sel = (ivl: number | undefined) => (isSelected(sh.sel, ivl) ? ' sel' : '');

  function render() {
    if (!present(sh)) {
      body.innerHTML = `<div class="ivl-empty">${sh.ctx.ui.loaded && sh.trace.total === 0 ? 'this trace has no intervals' : ''}</div>`;
      return;
    }
    const s = last;
    if (!s) { body.innerHTML = ''; return; }
    const out: string[] = [];
    const threads = orderStateThreads(s.threads);
    out.push(`<div class="ivl-sec">Calls <span class="dim">${threads.length} thread${threads.length === 1 ? '' : 's'}</span></div>`);
    if (!threads.length) out.push('<div class="ivl-none">no open calls</div>');
    for (const t of threads) {
      out.push(`<div class="ivl-th"><div class="ivl-th-name">${esc(threadLabel(t))}</div>`);
      t.stack.forEach((f, i) => {
        const inner = i === t.stack.length - 1;
        out.push(`<div class="ivl-frame${inner ? ' inner' : ''}${sel(f.ivl)}" data-seq="${f.seq}" data-ivl="${f.ivl}" style="padding-left:${8 + Math.min(i, 40) * 10}px" title="begun at seq ${f.seq}">`
          + `${esc(f.name ?? '?')} <span class="dim">#${f.seq}</span></div>`);
      });
      out.push('</div>');
    }
    const tree = spanTree(s.spans);
    out.push(`<div class="ivl-sec">Spans <span class="dim">${tree.length} open</span></div>`);
    if (!tree.length) out.push('<div class="ivl-none">no open spans</div>');
    for (const n of tree) {
      const sp = n.span;
      const orphan = n.orphan ? ` <span class="dim" title="its parent has closed">↖ ${esc(sp.parentSpan ?? sp.parent)}</span>` : '';
      out.push(`<div class="ivl-frame ivl-spanrow${sel(sp.ivl)}" data-seq="${sp.seq}" data-ivl="${sp.ivl}" style="padding-left:${8 + Math.min(n.indent, 40) * 10}px">`
        + `${esc(sp.name ?? sp.span ?? '?')} <span class="dim">${sp.span !== null && sp.span !== undefined ? `[${esc(sp.span)}] ` : ''}#${sp.seq}</span>${orphan}</div>`);
    }
    if (s.cpus.length) {
      out.push('<div class="ivl-sec">CPUs</div><table class="ivl-cpus"><tbody>');
      for (const c of s.cpus.slice().sort((a, b) => a.cpu - b.cpu)) {
        const what = c.state === 'running'
          ? esc(threadLabel({ thr: c.thr, pid: c.pid, name: c.name }))
          : `<span class="dim">${c.state}</span>`;
        const since = c.since !== undefined ? `<span class="dim">since #${c.since}</span>` : '';
        const seq = c.since !== undefined ? ` data-seq="${c.since}"` : '';
        const ivl = c.ivl !== undefined ? ` data-ivl="${c.ivl}"` : '';
        out.push(`<tr class="ivl-cpu ${c.state}${sel(c.ivl)}"${seq}${ivl}><td>cpu ${c.cpu}</td><td>${what}</td><td>${since}</td></tr>`);
      }
      out.push('</tbody></table>');
    }
    body.innerHTML = out.join('');
  }

  function ask() {
    if (!shown(sh, TYPE) || !present(sh) || !sh.playhead) return;
    const seq = sh.playhead.seq;
    if (seq === askedSeq) return;
    askedSeq = seq;
    const gen = sh.trace.gen;
    sh.ctx.requestLatest(KEY, 'domain-state', { domain: 'intervals', seq }).then((m) => {
      if (gen !== sh.trace.gen) return;
      last = m.available ? m.result : null;
      render();
    });
  }

  // a tab brought to the front (or an edge expanded) resizes the body from
  // zero: catch up then, since nothing was asked while it was out of sight
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => ask()).observe(body);

  body.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest?.('[data-seq]') as HTMLElement | null;
    if (!row) return;
    sh.ctx.post({ type: 'jump', seq: seekSeqFor(+row.dataset.seq) });
    if (row.dataset.ivl !== undefined) sh.ctx.selectInterval?.(intervalSelection(+row.dataset.ivl, { x: e.clientX, y: e.clientY }));
  });

  return {
    el,
    refresh() { askedSeq = NaN; render(); ask(); },
    reset() { askedSeq = NaN; last = null; render(); },
    traceReady() { askedSeq = NaN; render(); ask(); },
    playhead() { ask(); },
    selected() { if (shown(sh, TYPE)) render(); },
  };
}
