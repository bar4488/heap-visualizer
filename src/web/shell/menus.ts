// Shell: the top bar's menus, the command palette and the shortcut list, all
// rendered from one action registry (shell/actions.ts, spec SHELL-011).
//
// Nothing here knows what an action does. The menubar follows the WAI-ARIA
// menubar pattern (`menuKey` in actions.ts is its keyboard model): arrow
// keys, Enter and Escape; once one menu is open, hovering another trigger
// switches to it, as in an IDE; a click outside closes it.
//
// Menu items are real buttons that keep their element ids across renders: the
// guide drives a View item (`btn-filter`) or a File item (`btn-demo`) by id,
// exactly as it drove the toolbar button that used to carry the id.

import { $, $1 } from './dom.ts';
import type { El } from './dom.ts';
import {
  formatShortcut, isEnabled, labelOf, listKey, menuKey, shortcutMatches,
  type Action, type MenuState, type Registry,
} from './actions.ts';

export type MenuDef = { group: string; label: string };

const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function isEditable(target: any) {
  const tag = target?.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || !!target?.isContentEditable;
}

function el(tag: string, cls = '', text = ''): El {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/**
 * Build the menubar in `bar` from `menus`, and the palette and shortcut list
 * beside it. Returns the palette's opener (the View menu's "Command palette…"
 * action runs it) and the shortcut list's.
 */
export function initMenus(reg: Registry, bar: El, menus: MenuDef[]) {
  const triggers: El[] = [];
  const popups: El[] = [];
  const itemEls = new Map<string, El>(); // action id -> its button, kept across renders
  let state: MenuState = { menu: 0, open: false, item: -1 };
  let entries: { action: Action; el: El }[][] = menus.map(() => []);
  let returnFocus: El = null;
  let hoverOpened = -1; // a menu just opened by hovering its trigger
  let byKeyboard = false; // the menus were opened from the keyboard
  const parking = el('div');
  parking.hidden = true;
  document.body.appendChild(parking);

  bar.setAttribute('role', 'menubar');
  menus.forEach((m, i) => {
    const t = el('button', 'menu-trigger', m.label);
    t.id = `menu-${m.group}`;
    t.setAttribute('role', 'menuitem');
    t.setAttribute('aria-haspopup', 'menu');
    t.setAttribute('aria-expanded', 'false');
    t.setAttribute('aria-controls', `menu-${m.group}-list`);
    t.tabIndex = i === 0 ? 0 : -1;
    bar.appendChild(t);
    triggers.push(t);

    const p = el('div', 'menu-popup');
    p.id = `menu-${m.group}-list`;
    p.setAttribute('role', 'menu');
    p.setAttribute('aria-label', m.label);
    p.tabIndex = -1; // opened by mouse, the menu itself takes the keys
    p.hidden = true;
    document.body.appendChild(p);
    popups.push(p);

    // click toggles; pointerdown is kept from moving focus away from where
    // the user was, so closing the menu by mouse leaves focus there
    t.addEventListener('pointerdown', (e: PointerEvent) => { if (e.button === 0) e.preventDefault(); });
    t.addEventListener('click', () => {
      // the pointer reached this trigger and opened its menu on the way:
      // the click that follows keeps it open rather than closing it
      if (hoverOpened === i) { hoverOpened = -1; return; }
      if (state.open && state.menu === i) close(false);
      else open(i, -1, false);
    });
    t.addEventListener('pointerenter', () => {
      if (state.open && state.menu !== i) { open(i, -1, false); hoverOpened = i; }
    });
    t.addEventListener('pointerleave', () => { if (hoverOpened === i) hoverOpened = -1; });
    t.addEventListener('keydown', (e: KeyboardEvent) => onKey(e));
    p.addEventListener('keydown', (e: KeyboardEvent) => onKey(e));
  });

  function itemFor(a: Action): El {
    let b = itemEls.get(a.id);
    if (!b) {
      b = el('button', 'menu-item');
      b.id = a.el || `act-${a.id.replace(/[^a-z0-9-]/gi, '-')}`;
      b.tabIndex = -1;
      b.append(el('span', 'mi-check'), el('span', 'mi-label'), el('span', 'mi-key'));
      // Enter/Space on a focused item are the keyboard model's, so a click is
      // a pointer or a programmatic `.click()` (the guide)
      b.addEventListener('click', () => activate(a));
      b.addEventListener('pointerenter', () => {
        const m = entries.findIndex((list) => list.some((x) => x.action === a));
        const i = m < 0 ? -1 : entries[m].findIndex((x) => x.action === a);
        if (state.open && m === state.menu && isEnabled(a)) focusItem(i);
      });
      itemEls.set(a.id, b);
    }
    return b;
  }

  /** (Re)build one menu's items from the registry: labels, checks, disabled. */
  function render(m: number) {
    const p = popups[m];
    const list: { action: Action; el: El }[] = [];
    p.replaceChildren();
    let group: El = p;
    for (const e of reg.menu(menus[m].group)) {
      if (e.kind === 'separator') { const s = el('div', 'menu-sep'); s.setAttribute('role', 'separator'); p.appendChild(s); group = p; continue; }
      if (e.kind === 'heading') {
        group = el('div', 'menu-group');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', e.label);
        const h = el('div', 'menu-heading', e.label);
        h.setAttribute('aria-hidden', 'true');
        group.appendChild(h);
        p.appendChild(group);
        continue;
      }
      const b = itemFor(e.action);
      b.setAttribute('role', e.checked === null ? 'menuitem' : 'menuitemcheckbox');
      if (e.checked === null) b.removeAttribute('aria-checked');
      else b.setAttribute('aria-checked', String(e.checked));
      b.disabled = !e.enabled;
      b.setAttribute('aria-disabled', String(!e.enabled));
      b.querySelector('.mi-label').textContent = e.label;
      b.querySelector('.mi-key').textContent = e.action.shortcut ? formatShortcut(e.action.shortcut, mac) : '';
      b.title = e.action.hint || '';
      group.appendChild(b);
      list.push({ action: e.action, el: b });
    }
    // an action whose item is not in the menu right now (a domain the trace
    // lacks) keeps a disabled element, parked, so an id lookup still finds it
    for (const a of reg.all()) {
      if (a.group !== menus[m].group || list.some((x) => x.action === a)) continue;
      const b = itemFor(a);
      b.disabled = true;
      parking.appendChild(b);
    }
    entries[m] = list;
  }
  const renderAll = () => menus.forEach((_, m) => render(m));
  reg.onChange(renderAll);
  renderAll();

  function place(m: number) {
    const r = triggers[m].getBoundingClientRect();
    const p = popups[m];
    p.style.top = `${Math.round(r.bottom + 2)}px`;
    p.style.left = `${Math.round(Math.max(4, Math.min(r.left, innerWidth - p.offsetWidth - 4)))}px`;
  }

  function focusItem(i: number) {
    state = { ...state, item: i };
    const target = i >= 0 ? entries[state.menu][i]?.el : triggers[state.menu];
    target?.focus({ preventScroll: true });
  }

  function open(m: number, item: number, keyboard: boolean) {
    if (!state.open) {
      byKeyboard = keyboard;
      const active = document.activeElement;
      returnFocus = active && !bar.contains(active) && active !== document.body ? active : null;
    }
    if (state.open && state.menu !== m) hide(state.menu);
    render(m);
    popups[m].hidden = false;
    triggers[m].setAttribute('aria-expanded', 'true');
    triggers[m].classList.add('open');
    place(m);
    state = { menu: m, open: true, item: -1 };
    triggers.forEach((t, i) => { t.tabIndex = i === m ? 0 : -1; });
    if (keyboard || item >= 0) focusItem(item);
    else popups[m].focus?.({ preventScroll: true });
  }

  function hide(m: number) {
    popups[m].hidden = true;
    triggers[m].setAttribute('aria-expanded', 'false');
    triggers[m].classList.remove('open');
  }

  /**
   * Close the open menu. By keyboard (Escape) focus goes back to its trigger;
   * otherwise to wherever it was before the menu opened, so the playback keys
   * keep working after a menu was used with the mouse.
   */
  function close(toTrigger: boolean) {
    if (!state.open) return;
    const m = state.menu;
    const inside = popups[m].contains(document.activeElement) || bar.contains(document.activeElement);
    hide(m);
    state = { menu: m, open: false, item: -1 };
    if (toTrigger) triggers[m].focus({ preventScroll: true });
    else if (inside) {
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      else (document.activeElement as El)?.blur?.();
    }
    returnFocus = null;
  }

  function activate(a: Action) {
    if (!isEnabled(a)) return;
    close(false);
    a.run();
  }

  function onKey(e: KeyboardEvent) {
    const items = entries.map((list) => list.map((x) => isEnabled(x.action)));
    const from = triggers.indexOf(document.activeElement);
    const s = from >= 0 && !state.open ? { menu: from, open: false, item: -1 } : state;
    const r = menuKey(s, e.key, items);
    if (!r.handled) {
      if (r.close) close(false);
      return;
    }
    e.preventDefault();
    e.stopPropagation(); // the playback keys and window Escape are not the menu's
    if (r.activate) {
      const a = entries[s.menu][s.item]?.action;
      close(false);
      if (a && isEnabled(a)) a.run();
      return;
    }
    // Escape: back to the trigger when the menus were entered by keyboard,
    // else to wherever focus was before (so the playback keys work again)
    if (r.close) { close(byKeyboard); return; }
    if (r.state.open) {
      if (!state.open || state.menu !== r.state.menu) open(r.state.menu, r.state.item, true);
      else focusItem(r.state.item);
    } else {
      state = r.state;
      triggers.forEach((t, i) => { t.tabIndex = i === r.state.menu ? 0 : -1; });
      triggers[r.state.menu].focus({ preventScroll: true });
    }
  }

  document.addEventListener('pointerdown', (e: PointerEvent) => {
    if (!state.open) return;
    const t = e.target as El;
    if (popups[state.menu].contains(t) || bar.contains(t)) return;
    close(false);
  }, true);
  addEventListener('resize', () => { if (state.open) close(false); });

  const palette = initPalette(reg);
  const shortcuts = initShortcutList(reg);

  // Shortcuts: never while typing, and only the registry's own (the playback
  // keys are main.ts's, on bare keys none of these use).
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.defaultPrevented || isEditable(e.target)) return;
    for (const a of reg.all()) {
      if (!a.shortcut || !shortcutMatches(a.shortcut, e, mac)) continue;
      e.preventDefault();
      e.stopImmediatePropagation();
      close(false);
      if (isEnabled(a)) a.run();
      return;
    }
  }, true);

  return { openPalette: palette.open, openShortcuts: shortcuts.open, close: () => close(false) };
}

// ---------------------------------------------------------------------------
// the command palette

function initPalette(reg: Registry) {
  const overlay = $('palette');
  const input = $('palette-input');
  const list = $('palette-list');
  let items = reg.palette('', mac);
  let sel = 0;
  let back: El = null;

  function paint() {
    list.replaceChildren();
    items.forEach((it, i) => {
      const row = el('div', 'pal-item');
      row.id = `pal-${i}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === sel));
      if (it.checked !== null) row.setAttribute('aria-checked', String(it.checked));
      const label = el('span', 'pal-label');
      const hit = new Set(it.hits);
      [...it.label].forEach((ch, k) => {
        if (hit.has(k)) label.appendChild(el('b', '', ch));
        else label.appendChild(document.createTextNode(ch));
      });
      row.append(el('span', 'mi-check'), label, el('span', 'pal-where', it.where), el('span', 'mi-key', it.shortcut || ''));
      row.addEventListener('pointerdown', (e: PointerEvent) => e.preventDefault());
      row.addEventListener('click', () => { sel = i; runSelected(); });
      row.addEventListener('pointermove', () => { if (sel !== i) { sel = i; mark(); } });
      list.appendChild(row);
    });
    if (!items.length) list.appendChild(el('div', 'pal-empty', 'No matching command'));
    mark();
  }

  function mark() {
    [...list.children].forEach((row: El, i) => row.setAttribute?.('aria-selected', String(i === sel)));
    const row = $(`pal-${sel}`);
    if (row) {
      input.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView?.({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  function open() {
    if (!overlay.hidden) { input.select(); return; }
    const active = document.activeElement;
    back = active && active !== document.body ? active : null;
    overlay.hidden = false;
    input.value = '';
    sel = 0;
    items = reg.palette('', mac);
    paint();
    input.focus();
  }

  function close(restore = true) {
    if (overlay.hidden) return;
    overlay.hidden = true;
    if (restore && back?.isConnected) back.focus({ preventScroll: true });
    else if (restore) input.blur();
    back = null;
  }

  function runSelected() {
    const it = items[sel];
    if (!it) return;
    close(true);
    if (isEnabled(it.action)) it.action.run();
  }

  input.addEventListener('input', () => { sel = 0; items = reg.palette(input.value, mac); paint(); });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    const r = listKey(sel, e.key, items.length);
    if (!r.handled) return;
    e.preventDefault();
    e.stopPropagation();
    if (r.close) { close(true); return; }
    sel = r.index;
    if (r.run) runSelected();
    else mark();
  });
  overlay.addEventListener('pointerdown', (e: PointerEvent) => { if (e.target === overlay) close(true); });
  // focus taken elsewhere (a window that focuses itself as it opens) leaves
  // no way to type into the palette: it closes rather than linger
  input.addEventListener('blur', () => { if (!overlay.hidden) close(false); });
  return { open };
}

// ---------------------------------------------------------------------------
// the shortcut list (Help → Keyboard shortcuts)

/** The playback and view keys main.ts handles itself (spec NAV-007). */
const FIXED_KEYS: [string, string][] = [
  ['Space', 'Play / pause'],
  ['← / →', 'Step one event (Shift: ×100)'],
  ['Home / End', 'Seek to the start / end'],
  ['M', 'Mark the current position'],
  ['L', 'Lock the viewport'],
  ['G', 'Search: jump to seq, time, address, mark, name'],
  ['Esc', 'Clear the selection, close a window or overlay'],
];

function initShortcutList(reg: Registry) {
  const overlay = $('shortcuts');
  const body = $('shortcuts-list');
  let back: El = null;
  const row = (k: string, what: string) => {
    const r = el('div', 'sc-row');
    r.append(el('kbd', '', k), el('span', '', what));
    return r;
  };
  function open() {
    body.replaceChildren();
    for (const [k, what] of FIXED_KEYS) body.appendChild(row(k, what));
    for (const a of reg.all()) if (a.shortcut) body.appendChild(row(formatShortcut(a.shortcut, mac), labelOf(a).replace(/…$/, '')));
    const active = document.activeElement;
    back = active && active !== document.body ? active : null;
    overlay.hidden = false;
    $1('button', overlay)?.focus();
  }
  function close() {
    overlay.hidden = true;
    if (back?.isConnected) back.focus({ preventScroll: true });
    back = null;
  }
  $('shortcuts-close').onclick = close;
  overlay.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  });
  overlay.addEventListener('pointerdown', (e: PointerEvent) => { if (e.target === overlay) close(); });
  return { open };
}
