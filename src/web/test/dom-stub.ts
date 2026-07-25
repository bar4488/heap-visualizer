// A minimal DOM for `node --test`. Not a browser: it implements exactly the
// surface web/ actually touches — ids, classes, data-* attributes, a small
// selector matcher, and inert geometry.
//
// getElementById auto-creates unknown ids. That is deliberate: a session or
// `.heapa` round-trip test is about the data shape, and having to declare
// every incidental element the code writes a status string into would bury
// the fixture. Tests assert on the elements they seed.

// The stub is deliberately loose: an index signature rather than a field per
// property, because its whole job is to answer whatever the code under test
// happens to poke at.
class ClassList {
  [prop: string]: any;

  constructor(el: any) { this.el = el; this.set = new Set(); }
  add(...c) { c.forEach((x) => this.set.add(x)); }
  remove(...c) { c.forEach((x) => this.set.delete(x)); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) {
    const want = on === undefined ? !this.set.has(c) : !!on;
    if (want) this.set.add(c); else this.set.delete(c);
    return want;
  }
}

let nextEl = 0;

export class El {
  [prop: string]: any;

  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this._uid = ++nextEl;
    this.attrs = new Map();
    this.dataset = {};
    this.style = {};
    this.classList = new ClassList(this);
    this.children = [];
    this.parentElement = null;
    this.hidden = false;
    this.value = '';
    this._checked = false;
    this.textContent = '';
    this.innerHTML = '';
    this.clientWidth = 100;
    this.clientHeight = 100;
    this.scrollTop = 0;
    this._listeners = new Map();
  }

  get id() { return this.attrs.get('id') || ''; }
  set id(v) { this.attrs.set('id', v); }

  get checked() { return this._checked; }

  // radio-group semantics: checking one input unchecks its same-name peers,
  // which is what makes applySession's `fr.checked = true` restore a single
  // fmode rather than leaving two selected
  set checked(v) {
    this._checked = !!v;
    if (!this._checked) return;
    const name = this.attrs.get('name');
    if (!name || this.attrs.get('type') !== 'radio') return;
    let root = this;
    while (root.parentElement) root = root.parentElement;
    for (const peer of root.querySelectorAll(`input[name=${name}]`)) {
      if (peer !== this) peer._checked = false;
    }
  }

  setAttribute(k, v) {
    this.attrs.set(k, String(v));
    if (k.startsWith('data-')) this.dataset[dashToCamel(k.slice(5))] = String(v);
    // real elements seed the property from the attribute; code under test
    // reads `.value`, selectors read the attribute
    if (k === 'value') this.value = String(v);
  }

  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }

  appendChild(c) {
    if (c.parentElement) c.parentElement.removeChild(c);
    c.parentElement = this;
    this.children.push(c);
    return c;
  }

  insertBefore(c, ref) {
    if (c.parentElement) c.parentElement.removeChild(c);
    c.parentElement = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }

  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parentElement = null;
    return c;
  }

  remove() { if (this.parentElement) this.parentElement.removeChild(this); }

  contains(el) {
    for (let p = el; p; p = p.parentElement) if (p === this) return true;
    return false;
  }

  get descendants() {
    const out = [];
    const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }

  matches(sel) { return parseSelector(sel).some((alt) => matchChain(this, alt)); }

  querySelectorAll(sel) { return this.descendants.filter((e) => e.matches(sel)); }

  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }

  closest(sel) {
    for (let p = this; p; p = p.parentElement) if (p.matches(sel)) return p;
    return null;
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  }

  addEventListener(t, fn) {
    if (!this._listeners.has(t)) this._listeners.set(t, []);
    this._listeners.get(t).push(fn);
  }

  removeEventListener(t, fn) {
    const a = this._listeners.get(t) || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }

  // test helper: fire a listener registered with addEventListener
  emit(t, ev = {}) { (this._listeners.get(t) || []).forEach((fn) => fn(ev)); }
}

function dashToCamel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

// --- selector matching -----------------------------------------------------
// Supports the shapes web/ actually uses: comma alternatives, descendant
// combinators, tag / #id / .class / [attr] / [attr=v] / [attr="v"] / :checked.

const selCache = new Map();

function parseSelector(sel) {
  if (selCache.has(sel)) return selCache.get(sel);
  const alts = sel.split(',').map((part) => part.trim().split(/\s+/).map(parseCompound));
  selCache.set(sel, alts);
  return alts;
}

function parseCompound(s) {
  const c = { tag: null, id: null, classes: [], attrs: [], checked: false };
  const re = /([.#]?[\w-]+)|\[([\w-]+)(?:=("?)([^\]"]*)\3)?\]|(:checked)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[5]) { c.checked = true; continue; }
    if (m[2]) { c.attrs.push([m[2], m[4] === undefined ? null : m[4]]); continue; }
    const tok = m[1];
    if (tok.startsWith('#')) c.id = tok.slice(1);
    else if (tok.startsWith('.')) c.classes.push(tok.slice(1));
    else c.tag = tok.toUpperCase();
  }
  return c;
}

function matchCompound(el, c) {
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  if (c.classes.some((k) => !el.classList.contains(k))) return false;
  if (c.checked && !el.checked) return false;
  for (const [k, v] of c.attrs) {
    if (!el.attrs.has(k)) return false;
    if (v !== null && el.attrs.get(k) !== v) return false;
  }
  return true;
}

// right-to-left: the last compound must match `el`, each earlier one some
// ancestor, in order
function matchChain(el, chain) {
  if (!matchCompound(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  let p = el.parentElement;
  while (i >= 0 && p) {
    if (matchCompound(p, chain[i])) i--;
    p = p.parentElement;
  }
  return i < 0;
}

// --- document / globals ----------------------------------------------------

export function makeDocument() {
  const byId = new Map();
  const body = new El('body');
  const doc = {
    body,
    createElement: (tag) => new El(tag),
    getElementById(id) {
      let el = byId.get(id);
      if (!el) { el = new El('div'); el.id = id; byId.set(id, el); body.appendChild(el); }
      return el;
    },
    // register an element under an id without the auto-created default
    _put(id, el) { el.id = id; byId.set(id, el); body.appendChild(el); return el; },
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    querySelector: (sel) => body.querySelector(sel),
    addEventListener() {},
    removeEventListener() {},
  };
  return doc;
}

export function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    get size() { return m.size; },
  };
}

// Installs the globals web/ expects. Call before importing any module under
// test — shell/dom.js reads `document` and `devicePixelRatio` at import time.
export function installDom() {
  const doc = makeDocument();
  // These are fakes standing in for lib.dom's real types, which they do not
  // and should not implement in full — one cast here, rather than a lie about
  // each one's shape.
  const g = globalThis as any;
  g.document = doc;
  g.localStorage = makeLocalStorage();
  g.innerWidth = 1280;
  g.innerHeight = 800;
  g.devicePixelRatio = 1;
  g.window = {
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
  };
  g.ResizeObserver = class { observe() {} disconnect() {} };
  return doc;
}
