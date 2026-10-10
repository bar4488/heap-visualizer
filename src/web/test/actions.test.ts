// The action registry behind the top bar's menus and the command palette
// (spec SHELL-011): grouping, checked state, domain groups that drop out, the
// palette's fuzzy filter, and the menubar's and palette's keyboard models.
// All pure: shell/actions.ts touches no DOM.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRegistry, fuzzyMatch, formatShortcut, listKey, menuKey, shortcutMatches,
  type MenuEntry,
} from '../shell/actions.ts';

const shape = (entries: MenuEntry[]) => entries.map((e) => (
  e.kind === 'item' ? `${e.checked === null ? '' : e.checked ? '[x] ' : '[ ] '}${e.label}${e.enabled ? '' : ' (off)'}`
    : e.kind === 'heading' ? `# ${e.label}` : '---'));

function viewRegistry(state: { open: Set<string>; intervals: boolean; loaded: boolean }) {
  const reg = createRegistry();
  const panel = (id: string, label: string, section: string, extra = {}) => reg.add({
    id: `panel.${id}`, label, group: 'view', section,
    heading: section === 'workspace' ? undefined : section, rank: section === 'workspace' ? 1 : 0,
    checked: () => state.open.has(id), run: () => { if (!state.open.delete(id)) state.open.add(id); },
    ...extra,
  });
  // registration order as main.ts has it: the table (strips first), then a module
  panel('strip-t', 'Time strip', 'workspace');
  panel('layout', 'Layout', 'Heap');
  panel('filter', 'Filter', 'Heap');
  panel('marks', 'Marks', 'Heap', { enabled: () => state.loaded });
  panel('events', 'Events', 'Stream');
  panel('tracks', 'Tracks', 'Intervals', { visible: () => state.intervals });
  panel('stacks', 'Stacks', 'Intervals', { visible: () => state.intervals });
  reg.add({ id: 'view.reset', label: 'Reset layout', group: 'view', section: 'workspace', rank: 1, run() {} });
  reg.add({ id: 'file.open', label: 'Open trace…', group: 'file', shortcut: 'Mod+O', run() {} });
  return reg;
}

test('a menu groups by section with headings, the workspace run last', () => {
  const state = { open: new Set(['layout', 'strip-t']), intervals: true, loaded: true };
  const reg = viewRegistry(state);
  assert.deepEqual(shape(reg.menu('view')), [
    '# Heap', '[x] Layout', '[ ] Filter', '[ ] Marks',
    '---', '# Stream', '[ ] Events',
    '---', '# Intervals', '[ ] Tracks', '[ ] Stacks',
    '---', '[x] Time strip', 'Reset layout',
  ]);
  assert.deepEqual(shape(reg.menu('file')), ['Open trace…']);
});

test('checked state is read when the menu is built; running toggles it', () => {
  const state = { open: new Set<string>(), intervals: false, loaded: true };
  const reg = viewRegistry(state);
  assert.ok(shape(reg.menu('view')).includes('[ ] Filter'));
  assert.equal(reg.run('panel.filter'), true);
  assert.ok(shape(reg.menu('view')).includes('[x] Filter'));
});

test('a domain the trace lacks drops out whole; a disabled item stays, greyed', () => {
  const state = { open: new Set<string>(), intervals: false, loaded: false };
  const reg = viewRegistry(state);
  const view = shape(reg.menu('view'));
  assert.ok(!view.includes('# Intervals'), 'no heading over an empty group');
  assert.ok(!view.some((x) => x.includes('Tracks')));
  assert.ok(view.includes('[ ] Marks (off)'));
  assert.equal(reg.run('panel.marks'), false, 'a disabled action does not run');
  assert.equal(reg.run('panel.tracks'), false, 'nor does a hidden one');
  // the palette offers neither
  const ids = reg.palette('').map((i) => i.action.id);
  assert.ok(!ids.includes('panel.marks') && !ids.includes('panel.tracks'));
  assert.throws(() => reg.add({ id: 'view.reset', label: 'x', group: 'view', run() {} }), /declared twice/);
});

test('fuzzy match: subsequence, case-insensitive, word starts and runs rank higher', () => {
  assert.equal(fuzzyMatch('xyz', 'Show Logs'), null);
  assert.deepEqual(fuzzyMatch('sl', 'Show Logs').hits, [0, 5], 'word starts preferred over the first l');
  assert.ok(fuzzyMatch('log', 'Show Logs').score > fuzzyMatch('log', 'Load analysis… go').score);
  assert.deepEqual(fuzzyMatch('', 'anything'), { score: 0, hits: [] });
  // a later word start is only taken when the rest of the query still fits
  assert.deepEqual(fuzzyMatch('ab', 'xa yb a').hits, [1, 4]);
});

test('the palette ranks label matches first and labels toggles by state', () => {
  const reg = createRegistry();
  let open = true;
  reg.add({ id: 'panel.logs', label: 'Logs', group: 'view', heading: 'Logs', run() {}, checked: () => open,
    paletteLabel: () => `${open ? 'Hide' : 'Show'} Logs` });
  reg.add({ id: 'file.load', label: 'Load analysis…', group: 'file', run() {} });
  reg.add({ id: 'view.reset', label: 'Reset layout', group: 'view', run() {}, keywords: 'default' });
  reg.add({ id: 'file.open', label: 'Open trace…', group: 'file', shortcut: 'Mod+O', run() {} });

  const hits = reg.palette('logs');
  assert.equal(hits[0].label, 'Hide Logs');
  assert.equal(hits[0].where, 'View · Logs');
  assert.equal(hits[0].checked, true);
  open = false;
  assert.equal(reg.palette('logs')[0].label, 'Show Logs');
  // keywords and the menu name match too, below label matches
  assert.deepEqual(reg.palette('default').map((i) => i.action.id), ['view.reset']);
  assert.equal(reg.palette('open').find((i) => i.action.id === 'file.open').shortcut, 'Ctrl+O');
  assert.equal(reg.palette('open', true).find((i) => i.action.id === 'file.open').shortcut, '⌘O');
  assert.equal(reg.palette('').length, 4, 'an empty query lists everything');
});

test('shortcuts: Mod is Ctrl or ⌘, modifiers exact, a symbol ignores Shift', () => {
  assert.equal(shortcutMatches('Mod+K', { key: 'k', ctrlKey: true }, false), true);
  assert.equal(shortcutMatches('Mod+K', { key: 'k', metaKey: true }, false), false);
  assert.equal(shortcutMatches('Mod+K', { key: 'k', metaKey: true }, true), true);
  assert.equal(shortcutMatches('Mod+K', { key: 'k', ctrlKey: true, shiftKey: true }, false), false);
  assert.equal(shortcutMatches('Mod+O', { key: 'o' }, false), false);
  assert.equal(shortcutMatches('?', { key: '?', shiftKey: true }, false), true);
  assert.equal(shortcutMatches('?', { key: '?', ctrlKey: true }, false), false);
  assert.equal(formatShortcut('Mod+S', false), 'Ctrl+S');
  assert.equal(formatShortcut('Mod+S', true), '⌘S');
});

test('menubar keyboard model: arrows, wrap, skip disabled, Enter, Escape, Tab', () => {
  // File: 3 items, the middle one disabled; View: 2; Help: 1
  const items = [[true, false, true], [true, true], [true]];
  const closed = { menu: 0, open: false, item: -1 };
  let r = menuKey(closed, 'ArrowRight', items);
  assert.deepEqual(r.state, { menu: 1, open: false, item: -1 });
  assert.deepEqual(menuKey(closed, 'ArrowLeft', items).state.menu, 2, 'wraps');
  r = menuKey(closed, 'ArrowDown', items);
  assert.deepEqual(r.state, { menu: 0, open: true, item: 0 });
  r = menuKey(r.state, 'ArrowDown', items);
  assert.equal(r.state.item, 2, 'the disabled item is skipped');
  r = menuKey(r.state, 'ArrowDown', items);
  assert.equal(r.state.item, 0, 'wraps');
  assert.equal(menuKey(r.state, 'ArrowUp', items).state.item, 2);
  assert.equal(menuKey(closed, 'ArrowUp', items).state.item, 2, 'up opens on the last item');
  // left/right on an open menu switch menus, open, first item
  assert.deepEqual(menuKey(r.state, 'ArrowRight', items).state, { menu: 1, open: true, item: 0 });
  assert.deepEqual(menuKey(r.state, 'ArrowLeft', items).state, { menu: 2, open: true, item: 0 });
  // Enter runs the focused item and closes; Escape just closes
  const enter = menuKey({ menu: 0, open: true, item: 2 }, 'Enter', items);
  assert.equal(enter.activate, true);
  assert.equal(enter.close, true);
  assert.equal(enter.state.open, false);
  const esc = menuKey({ menu: 1, open: true, item: 1 }, 'Escape', items);
  assert.equal(esc.activate, undefined);
  assert.deepEqual(esc.state, { menu: 1, open: false, item: -1 });
  // a menu opened by mouse has no focused item yet: Down focuses the first
  assert.equal(menuKey({ menu: 1, open: true, item: -1 }, 'ArrowDown', items).state.item, 0);
  // Tab closes but is not swallowed; other keys pass through
  const tab = menuKey({ menu: 0, open: true, item: 0 }, 'Tab', items);
  assert.equal(tab.close, true);
  assert.equal(tab.handled, false);
  assert.equal(menuKey(closed, 'x', items).handled, false);
  assert.equal(menuKey(closed, 'Escape', items).handled, false, 'Escape on a closed bar is not the menu\'s');
});

test('palette list keyboard model', () => {
  assert.deepEqual(listKey(0, 'ArrowDown', 3), { index: 1, handled: true });
  assert.deepEqual(listKey(2, 'ArrowDown', 3), { index: 0, handled: true });
  assert.deepEqual(listKey(0, 'ArrowUp', 3), { index: 2, handled: true });
  assert.deepEqual(listKey(1, 'PageDown', 20), { index: 9, handled: true });
  assert.deepEqual(listKey(1, 'PageUp', 20), { index: 0, handled: true });
  assert.deepEqual(listKey(1, 'Enter', 3), { index: 1, run: true, handled: true });
  assert.equal(listKey(1, 'Escape', 3).close, true);
  assert.equal(listKey(0, 'a', 3).handled, false, 'typing goes to the input');
  assert.equal(listKey(0, 'Enter', 0).run, undefined, 'nothing to run in an empty list');
});
