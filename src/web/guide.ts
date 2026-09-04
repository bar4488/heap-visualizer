// The guide drawer: a document beside the app, deliberately outside the panel
// system (spec SHELL-009).
//
// Two rules shape this file, and both are the point of the prototype (T019):
//
//  1. **It is not a panel.** No record in heap/panels.ts, no window chrome, no
//     dock/float, no session geometry. It is its own drawer at the left edge of
//     the workspace, so none of SHELL-002/003/004 applies to it and none of the
//     questions those raise (per-trace persistence of reading position, height
//     shared with Events) has to be answered.
//
//  2. **It reaches the app only by driving real controls.** There is no backend
//     connection and no touching of UI state. An action link
//     finds a real element by id and clicks it, or sets its value and
//     dispatches the same event the UI already listens for. That is what keeps
//     the guide from becoming a second undocumented API onto app state that
//     drifts every time main.ts is refactored: if a control is renamed, the
//     guide's action fails loudly against a missing id instead of quietly
//     driving stale internals.
//
// Content is plain markdown under src/web/guide/, copied to dist/guide/ by
// build.sh and fetched at open time. A reader opening one of those files raw
// gets the whole text; only the live behavior is lost. The renderer below is
// deliberately small — headings, paragraphs, lists, code, emphasis, links,
// rules, tables are not supported until a page wants one.

import { $, $$ } from './shell/dom.ts';
import type { El } from './shell/dom.ts';
import { esc } from './fmt.ts';
import { heapPanels } from './heap/panels.ts';

// Panel id -> the toolbar button that opens it, read from the panel table
// rather than from a second list of ids here (spec SHELL-003). This is the one
// thing the guide needs to know about panels: how to point at one that is
// closed, by clicking the real toggle instead of un-hiding the element behind
// its back.
const PANEL_TOGGLE = new Map(heapPanels().map((p) => [p.id, p.toggle]));

// Section files, in reading order. Each is fetched from dist/guide/.
const SECTIONS = [
  { file: 'the-format.md', title: 'Trace format' },
  { file: 'the-map.md', title: 'Address map' },
  { file: 'time.md', title: 'Time and navigation' },
  { file: 'selecting.md', title: 'Selection' },
  { file: 'filters.md', title: 'Query language' },
  { file: 'tags-and-marks.md', title: 'Analysis state' },
];

const HIGHLIGHT_MS = 2200;

let loaded = false;
let highlightTimer = 0;

/**
 * Inline markdown, applied to already-escaped text: `code`, **strong**, *em*,
 * and links. Action links (`#show:` / `#do:` / `#set:`) become buttons rather
 * than anchors — they act on this page instead of navigating.
 *
 * Exported for the web suite (T024); nothing else imports it.
 */
export function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
      if (/^#(show|do|set):/.test(href)) {
        // href is escaped text; it reaches the DOM as an attribute value and
        // is only ever read back and matched against real element ids.
        return `<button class="g-act" data-act="${href.slice(1)}">${label}</button>`;
      }
      // A relative link is a scenario trace: `?trace=…` autoload (TOOL-002) in
      // this tab, which is how the guide loads one without a code path of its
      // own into the loader. Absolute links leave the app, so they open away.
      // A link straight at a `.heapl` is the file itself rather than a
      // scenario to open: mark it `download`, or the browser navigates the tab
      // to 20 KB of raw JSONL and the reader loses the app.
      const external = /^[a-z]+:/.test(href);
      if (!external && /\.heapl$/.test(href)) return `<a href="${href}" download>${label}</a>`;
      return `<a href="${href}"${external ? ' target="_blank" rel="noreferrer"' : ''}>${label}</a>`;
    });
}

/**
 * Markdown-lite: the block grammar the guide pages actually use.
 *
 * Exported for the web suite (T024); nothing else imports it.
 */
export function render(src: string): string {
  const out: string[] = [];
  let list: string[] | null = null;
  let code: string[] | null = null;
  let paragraph: string[] = [];

  const flushList = () => {
    if (list) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    list = null;
  };
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };

  for (const raw of esc(src).split('\n')) {
    const line = raw.trimEnd();

    if (line.startsWith('```')) {
      flushParagraph();
      flushList();
      if (code) { out.push(`<pre><code>${code.join('\n')}</code></pre>`); code = null; } else code = [];
      continue;
    }
    if (code) { code.push(raw); continue; }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length + 1, 4);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) { flushParagraph(); (list ||= []).push(item[1]); continue; }

    if (!line) { flushParagraph(); flushList(); continue; }
    if (/^---+$/.test(line)) { flushParagraph(); flushList(); out.push('<hr>'); continue; }
    if (list) { list[list.length - 1] += ` ${line.trimStart()}`; continue; }
    paragraph.push(line.trimStart());
  }
  flushParagraph();
  flushList();
  if (code) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
  return out.join('\n');
}

/**
 * Ring the named element, bringing it into view only if it is out of it. The
 * reader keeps using the real app while reading, so the treatment stays local
 * to the target: no dimming of the rest, and no scrolling the reader loses
 * their place to.
 */
function highlight(id: string) {
  const el = $(id);
  if (!el) { note(`guide: no element "${id}"`); return; }
  for (const prev of $$('.g-target')) prev.classList.remove('g-target');
  clearTimeout(highlightTimer);

  // A target inside a closed panel — or a closed panel itself — is revealed by
  // clicking that panel's real toolbar toggle, never by un-hiding the element
  // behind the toggle's back. Anything still hidden (a toolbar button that
  // needs a loaded trace) is reported, not forced.
  const panel = el.closest('.panel');
  const toggle = panel && panel.hidden && PANEL_TOGGLE.get(panel.id);
  if (toggle) $(toggle).click();
  if (el.hidden) { note(`guide: "${id}" is not available yet`); return; }

  el.classList.add('g-target');
  // `scrollIntoView` scrolls every scrollable ancestor, and a docked panel's
  // chain reaches the workspace — enough to shift the reader's place in the
  // prose. Scroll the one container that needs it, and only when the target is
  // actually out of view. Never with `behavior: 'smooth'`: the animation
  // outlives this call, so the scroll position could not be restored after it.
  const scroller = scrollParent(el);
  if (scroller) {
    const box = el.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (box.top < view.top) scroller.scrollTop -= view.top - box.top;
    else if (box.bottom > view.bottom) scroller.scrollTop += box.bottom - view.bottom;
  }
  highlightTimer = window.setTimeout(() => el.classList.remove('g-target'), HIGHLIGHT_MS);
}

/**
 * The nearest ancestor that scrolls vertically, stopping at the guide: nothing
 * an action does may scroll the prose the reader is in.
 */
function scrollParent(el: El): El {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    if (p.id === 'guide') return null;
    const overflow = getComputedStyle(p).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

function note(text: string) {
  $('st-info').textContent = text;
}

/**
 * Run one action from prose. Every branch ends at a real control — `.click()`,
 * or a value assignment plus the event its own handler is bound to.
 */
function act(spec: string) {
  // An app handler may focus a control it just revealed, and focusing scrolls
  // ancestors. Nothing an action does is allowed to move the reader's place in
  // the prose, so the guide's own scroll is pinned across the whole call.
  const body = $('guide-body');
  const keep = body.scrollTop;
  try {
    run(spec);
  } finally {
    if (body.scrollTop !== keep) body.scrollTop = keep;
  }
}

function run(spec: string) {
  const [verb, rest] = [spec.slice(0, spec.indexOf(':')), spec.slice(spec.indexOf(':') + 1)];

  if (verb === 'show') { highlight(rest); return; }

  if (verb === 'do') {
    const el = $(rest);
    if (!el) { note(`guide: no control "${rest}"`); return; }
    if (el.hidden || el.disabled) { note(`guide: "${rest}" is not available yet`); return; }
    el.click();
    highlight(rest);
    return;
  }

  // set:<id>=<value> — assign and fire what the UI listens for. Checkboxes
  // take true/false, everything else the literal text.
  const eq = rest.indexOf('=');
  const id = rest.slice(0, eq);
  const value = rest.slice(eq + 1);
  const el = $(id);
  if (!el) { note(`guide: no control "${id}"`); return; }
  if (el.type === 'checkbox') el.checked = value === 'true';
  else el.value = value;
  el.dispatchEvent(new Event(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', { bubbles: true }));
  // Text inputs whose handler is on 'change' (row bytes, collapse) settle on
  // blur in normal use; fire both rather than guess which one a control uses.
  if (el.tagName === 'INPUT' && el.type !== 'checkbox') el.dispatchEvent(new Event('change', { bubbles: true }));
  highlight(id);
}

async function load() {
  // Set before the first await: opening and closing quickly must not start a
  // second round of fetches. A section that fails renders its own failure, so
  // there is nothing to retry by re-entering here.
  loaded = true;
  const body = $('guide-body');
  const parts: string[] = [];
  for (const section of SECTIONS) {
    try {
      const resp = await fetch(`guide/${section.file}`, { cache: 'no-cache' });
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      parts.push(`<section class="g-section">${render(await resp.text())}</section>`);
    } catch (e) {
      parts.push(`<section class="g-section"><p class="g-fail">${
        esc(section.title)} failed to load: ${esc((e as Error).message)}</p></section>`);
    }
  }
  body.innerHTML = parts.join('\n');
}

export function toggleGuide(open = $('guide').hidden) {
  $('guide').hidden = !open;
  $('btn-guide').classList.toggle('active', open);
  if (open && !loaded) void load();
}

export function initGuide() {
  $('btn-guide').onclick = () => toggleGuide();
  // A scenario link navigates to `?trace=…&guide=1`, so the reader lands back
  // in the guide with that trace loading. The parameter is the whole of the
  // guide's persistence: nothing is stored anywhere.
  if (new URLSearchParams(location.search).get('guide')) toggleGuide(true);
  $('guide-close').onclick = () => toggleGuide(false);
  $('guide-body').addEventListener('click', (ev: any) => {
    const btn = ev.target.closest('.g-act');
    if (btn) act(btn.dataset.act);
  });

  // Width drag, the one piece of drawer behavior worth having here. Panels get
  // this from shell/drawers.ts, which this surface deliberately does not use.
  const grip = $('guide-resize');
  grip.addEventListener('pointerdown', (ev: PointerEvent) => {
    grip.setPointerCapture(ev.pointerId);
    const startX = ev.clientX;
    const startW = $('guide').getBoundingClientRect().width;
    const move = (e: PointerEvent) => {
      $('guide').style.width = `${Math.max(280, Math.min(720, startW + e.clientX - startX))}px`;
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
}
