// Shell: the action registry (spec SHELL-011). Every command the top bar's
// menus and the command palette offer is one record here, so the File, View
// and Help menus and the palette cannot disagree about what exists, what it is
// called, whether it is checked, or which shortcut runs it.
//
// This file is pure: no DOM, nothing read at import time. The menus and the
// palette that render it are shell/menus.ts; the keyboard models they follow
// are here so the web suite can drive them without a browser.

export type Action = {
  /** Unique; the palette's and the shortcut table's key. */
  id: string;
  /** The menu label (a function when it depends on state: Connect / Disconnect). */
  label: string | (() => string);
  /** The menu it lives in ('file', 'view', 'help'), or 'palette' for palette-only actions. */
  group: string;
  /** A run of items within its menu; runs are separated from each other. */
  section?: string;
  /** The section's header text in its menu (the View menu's domain groups). */
  heading?: string;
  /** Section order within the menu, lower first; ties keep registration order. */
  rank?: number;
  /** A keyboard shortcut, as `Mod+O` (Mod is ⌘ on a Mac, Ctrl elsewhere) or a bare key. */
  shortcut?: string;
  run: () => void;
  /** Present for a toggle: whether it is on (a View item's window is open). */
  checked?: () => boolean;
  /** Shown but not runnable while false. */
  enabled?: () => boolean;
  /** Left out of menus and the palette while false (a domain the trace lacks). */
  visible?: () => boolean;
  /** The menu item's element id, for an action other code (the guide) drives by id. */
  el?: string;
  /** Tooltip text. */
  hint?: string;
  /** The palette's wording when it differs from the menu's ("Show Logs"). */
  paletteLabel?: () => string;
  /** Extra words the palette matches on. */
  keywords?: string;
};

export type MenuItem = { kind: 'item'; action: Action; label: string; checked: boolean | null; enabled: boolean };
export type MenuEntry =
  | { kind: 'heading'; label: string }
  | { kind: 'separator' }
  | MenuItem;

export type PaletteItem = {
  action: Action;
  label: string;
  /** Where it lives, shown beside it: "File", "View · Heap", "Help". */
  where: string;
  shortcut: string | null;
  checked: boolean | null;
  /** Indices into `label` the query matched, for highlighting. */
  hits: number[];
  score: number;
};

const GROUP_TITLE: Record<string, string> = { file: 'File', view: 'View', help: 'Help', palette: '' };

export const labelOf = (a: Action) => (typeof a.label === 'function' ? a.label() : a.label);
export const isVisible = (a: Action) => (a.visible ? a.visible() : true);
export const isEnabled = (a: Action) => isVisible(a) && (a.enabled ? a.enabled() : true);

export function createRegistry() {
  const actions: Action[] = [];
  const changed = new Set<() => void>();

  function get(id: string) {
    return actions.find((a) => a.id === id) || null;
  }

  return {
    /** Declare an action. An id declared twice is an error, as a panel id is. */
    add(a: Action) {
      if (get(a.id)) throw new Error(`action declared twice: ${a.id}`);
      actions.push(a);
      for (const fn of changed) fn();
      return a;
    },
    get,
    all: () => [...actions],
    /** Run it if it is visible and enabled; false otherwise. */
    run(id: string) {
      const a = get(id);
      if (!a || !isEnabled(a)) return false;
      a.run();
      return true;
    },
    /** Called after every `add`: the menus rebuild their items. */
    onChange(fn: () => void) {
      changed.add(fn);
      return () => { changed.delete(fn); };
    },

    /**
     * One menu's entries, top to bottom: its visible actions by section (rank,
     * then first appearance), a separator between sections, and a section's
     * heading above it. A section with nothing visible is left out whole —
     * that is how a domain the trace lacks drops out of View.
     */
    menu(group: string): MenuEntry[] {
      const sections: { key: string; rank: number; heading?: string; items: Action[] }[] = [];
      for (const a of actions) {
        if (a.group !== group) continue;
        const key = a.section ?? '';
        let s = sections.find((x) => x.key === key);
        if (!s) sections.push(s = { key, rank: a.rank ?? 0, items: [] });
        if (a.heading && !s.heading) s.heading = a.heading;
        if (isVisible(a)) s.items.push(a);
      }
      const order = sections.filter((s) => s.items.length)
        .map((s, i) => ({ s, i }))
        .sort((x, y) => x.s.rank - y.s.rank || x.i - y.i)
        .map(({ s }) => s);
      const out: MenuEntry[] = [];
      order.forEach((s, i) => {
        if (i) out.push({ kind: 'separator' });
        if (s.heading) out.push({ kind: 'heading', label: s.heading });
        for (const a of s.items) {
          out.push({
            kind: 'item', action: a, label: labelOf(a),
            checked: a.checked ? !!a.checked() : null, enabled: isEnabled(a),
          });
        }
      });
      return out;
    },

    /**
     * The palette's list for a query: every visible, enabled action, fuzzy
     * matched on its palette label (and where it lives, and its keywords),
     * best first. An empty query lists everything in registration order.
     */
    palette(query: string, mac = false): PaletteItem[] {
      const out: PaletteItem[] = [];
      actions.forEach((a, i) => {
        if (!isEnabled(a)) return;
        const label = a.paletteLabel ? a.paletteLabel() : labelOf(a);
        const where = [GROUP_TITLE[a.group] ?? a.group, a.heading].filter(Boolean).join(' · ');
        const own = fuzzyMatch(query, label);
        const extra = own ? null : fuzzyMatch(query, `${where} ${a.keywords || ''}`);
        if (!own && !extra) return;
        out.push({
          action: a, label, where,
          shortcut: a.shortcut ? formatShortcut(a.shortcut, mac) : null,
          checked: a.checked ? !!a.checked() : null,
          hits: own ? own.hits : [],
          // a match in the label itself beats one found only in the context
          score: (own ? own.score + 1000 : extra.score) - i * 1e-3,
        });
      });
      return query.trim() ? out.sort((x, y) => y.score - x.score) : out;
    },
  };
}

export type Registry = ReturnType<typeof createRegistry>;

/**
 * Fuzzy subsequence match, case-insensitive: every query character (spaces
 * ignored) must appear in order. Null when they do not; otherwise a score that
 * rewards runs of consecutive characters, matches at word starts and an early
 * first match, and the matched indices.
 */
export function fuzzyMatch(query: string, text: string): { score: number; hits: number[] } | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, hits: [] };
  const t = text.toLowerCase();
  const hits: number[] = [];
  let score = 0;
  let run = 0; // length of the current run of consecutive matches
  let from = 0;
  const wordStart = (j: number) => j === 0 || /[^a-z0-9]/.test(t[j - 1]);
  const rest = (k: number, from: number) => {
    for (let i = k; i < q.length; i++) { from = t.indexOf(q[i], from) + 1; if (!from) return false; }
    return true;
  };
  for (let k = 0; k < q.length; k++) {
    const ch = q[k];
    let at = t.indexOf(ch, from);
    if (at < 0) return null;
    const prev = hits[hits.length - 1];
    // not continuing a run: prefer a later occurrence at a word start, as
    // long as the rest of the query still fits after it
    if (!(prev !== undefined && at === prev + 1) && !wordStart(at)) {
      for (let j = t.indexOf(ch, at + 1); j >= 0; j = t.indexOf(ch, j + 1)) {
        if (wordStart(j) && rest(k + 1, j + 1)) { at = j; break; }
      }
    }
    run = prev !== undefined && at === prev + 1 ? run + 1 : 1;
    score += 6 * (run - 1); // a longer run counts for more
    if (wordStart(at)) score += 6;
    score += 1;
    hits.push(at);
    from = at + 1;
  }
  score -= hits[0] * 0.2;
  score -= (t.length - q.length) * 0.05;
  return { score, hits };
}

/** `Mod+O` as shown to the user: ⌘O on a Mac, Ctrl+O elsewhere. */
export function formatShortcut(spec: string, mac: boolean): string {
  const parts = spec.split('+');
  const key = parts.pop();
  const shown = key.length === 1 ? key.toUpperCase() : key;
  const mods = parts.map((m) => (m === 'Mod' ? (mac ? '⌘' : 'Ctrl') : m === 'Shift' ? (mac ? '⇧' : 'Shift') : m === 'Alt' ? (mac ? '⌥' : 'Alt') : m));
  return mac ? mods.join('') + shown : [...mods, shown].join('+');
}

type KeyLike = { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean };

/**
 * Whether a key event is the shortcut `spec`. Modifiers must match exactly,
 * except that a bare symbol (`?`) ignores Shift, which typing it needs.
 */
export function shortcutMatches(spec: string, e: KeyLike, mac: boolean): boolean {
  const parts = spec.split('+');
  const key = parts.pop();
  const mod = parts.includes('Mod');
  const want = {
    ctrl: mod && !mac, meta: mod && mac,
    shift: parts.includes('Shift'), alt: parts.includes('Alt'),
  };
  if (!!e.ctrlKey !== want.ctrl || !!e.metaKey !== want.meta || !!e.altKey !== want.alt) return false;
  const symbol = key.length === 1 && !/[a-z0-9]/i.test(key);
  if (!symbol && !!e.shiftKey !== want.shift) return false;
  return e.key.toLowerCase() === key.toLowerCase();
}

// ---------------------------------------------------------------------------
// keyboard models

/**
 * The menubar's state: which top-level menu has focus, whether it is open,
 * and which of its items has focus (-1: none, the trigger itself).
 */
export type MenuState = { menu: number; open: boolean; item: number };
export type MenuStep = { state: MenuState; activate?: boolean; close?: boolean; handled: boolean };

/**
 * One key on the menubar (WAI-ARIA menubar pattern). `items[m]` lists, per
 * item of menu m, whether it can take focus (enabled). Returns the next state,
 * whether to run the focused item, and whether the menus closed.
 */
export function menuKey(s: MenuState, key: string, items: boolean[][]): MenuStep {
  const n = items.length;
  const first = (m: number) => items[m].indexOf(true);
  const last = (m: number) => items[m].lastIndexOf(true);
  const step = (m: number, from: number, d: number) => {
    const len = items[m].length;
    for (let k = 1; k <= len; k++) {
      const i = (((from + d * k) % len) + len) % len;
      if (items[m][i]) return i;
    }
    return -1;
  };
  const go = (state: MenuState, extra: Partial<MenuStep> = {}): MenuStep => ({ state, handled: true, ...extra });

  if (!s.open) {
    switch (key) {
      case 'ArrowRight': return go({ menu: (s.menu + 1) % n, open: false, item: -1 });
      case 'ArrowLeft': return go({ menu: (s.menu - 1 + n) % n, open: false, item: -1 });
      case 'ArrowDown': case 'Enter': case ' ': return go({ menu: s.menu, open: true, item: first(s.menu) });
      case 'ArrowUp': return go({ menu: s.menu, open: true, item: last(s.menu) });
      default: return { state: s, handled: false };
    }
  }
  switch (key) {
    case 'ArrowDown': return go({ ...s, item: step(s.menu, s.item, 1) });
    case 'ArrowUp': return go({ ...s, item: step(s.menu, s.item < 0 ? 0 : s.item, -1) });
    case 'Home': return go({ ...s, item: first(s.menu) });
    case 'End': return go({ ...s, item: last(s.menu) });
    case 'ArrowRight': { const m = (s.menu + 1) % n; return go({ menu: m, open: true, item: first(m) }); }
    case 'ArrowLeft': { const m = (s.menu - 1 + n) % n; return go({ menu: m, open: true, item: first(m) }); }
    case 'Enter': case ' ':
      return s.item >= 0
        ? go({ menu: s.menu, open: false, item: -1 }, { activate: true, close: true })
        : go({ ...s, item: first(s.menu) });
    case 'Escape': return go({ menu: s.menu, open: false, item: -1 }, { close: true });
    case 'Tab': return { state: { menu: s.menu, open: false, item: -1 }, close: true, handled: false };
    default: return { state: s, handled: false };
  }
}

/** The palette's list: arrows move (wrapping), page keys jump, Enter runs, Escape closes. */
export function listKey(index: number, key: string, count: number): { index: number; run?: boolean; close?: boolean; handled: boolean } {
  if (key === 'Escape') return { index, close: true, handled: true };
  if (!count) return { index: 0, handled: key === 'Enter' };
  switch (key) {
    case 'ArrowDown': return { index: (index + 1) % count, handled: true };
    case 'ArrowUp': return { index: (index - 1 + count) % count, handled: true };
    case 'PageDown': return { index: Math.min(count - 1, index + 8), handled: true };
    case 'PageUp': return { index: Math.max(0, index - 8), handled: true };
    case 'Enter': return { index, run: true, handled: true };
    default: return { index, handled: false };
  }
}

/** The app's one registry: main.ts fills it, shell/menus.ts renders it. */
export const actions = createRegistry();
