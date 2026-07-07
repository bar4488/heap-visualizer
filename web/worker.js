// heap-visualizer worker: owns the WASM engine and all OffscreenCanvas rendering.
// The main thread only sends input events and receives state/query results.

let E = null;            // wasm exports
const td = new TextDecoder();
const te = new TextEncoder();

const canvases = { addr: null, tlt: null, tls: null }; // OffscreenCanvas
const ctxs = { addr: null, tlt: null, tls: null };
let dpr = 1;

const S = {
  loaded: false,
  n: 0,
  tMin: 0,
  tMax: 0,
  scroll: 0,             // device px into the virtual address-line
  rowPx: 24,
  gapPx: 14,
  tlT: { lo: 0, hi: 1 }, // temporal view range (t)
  tlS: { lo: 0, hi: 1 }, // sequential view range (seq)
  addrMarks: [],         // [{lo, hi}] address marks, set by the main thread
  names: new Map(),      // creator event -> user name, for in-alloc labels
  addrLabels: true,      // draw row start addresses along the left edge
  locked: false,         // locked viewport: stepping never auto-scrolls
  playing: false,
  playMode: 't',         // 't' | 'seq'
  playRate: 0,           // t-units/s or events/s
  playPos: 0,            // float accumulator (t or seq)
  lastTick: 0,
  dirty: { addr: true, tlt: true, tls: true },
  lastState: '',
};

const binCache = { 0: { key: '' }, 1: { key: '' } };
let tagGen = 0; // bumped whenever tags/tag colors change, to bust bin caches

function tagsChanged() {
  tagGen++;
  S.dirty.addr = S.dirty.tlt = S.dirty.tls = true;
  E.hp_tag_counts_json();
  postMessage({ type: 'tag-counts', counts: retJson() });
}

// ---------------------------------------------------------------------------
// wasm helpers
// ---------------------------------------------------------------------------

function retPair() {
  const r = new Uint32Array(E.memory.buffer, E.hp_ret(), 8);
  return [r[0], r[1]];
}
function retStr() {
  const [p, l] = retPair();
  return td.decode(new Uint8Array(E.memory.buffer, p, l));
}
function retJson() {
  return JSON.parse(retStr());
}
function writeBuf(bytes) {
  const ptr = E.hp_buf_ptr(bytes.length);
  new Uint8Array(E.memory.buffer, ptr, bytes.length).set(bytes);
  return bytes.length;
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

async function loadTrace(buffer) {
  E.hp_parse_begin();
  const CH = 8 << 20;
  const total = buffer.byteLength;
  let done = 0;
  for (let off = 0; off < total; off += CH) {
    const len = Math.min(CH, total - off);
    const ptr = E.hp_buf_ptr(CH);
    new Uint8Array(E.memory.buffer, ptr, len).set(new Uint8Array(buffer, off, len));
    E.hp_parse_chunk(len);
    done += len;
    postMessage({ type: 'progress', pct: Math.round((done / total) * 100) });
  }
  const n = E.hp_parse_end();
  E.hp_meta_json();
  const meta = retJson();
  E.hp_warnings_json();
  const warnings = retJson();

  S.loaded = true;
  S.n = n;
  S.tMin = meta.tMin;
  S.tMax = meta.tMax;
  S.tlT = { lo: meta.tMin, hi: Math.max(meta.tMax, meta.tMin + 1) };
  S.tlS = { lo: 0, hi: Math.max(n, 1) };
  S.scroll = 0;
  S.playing = false;
  S.addrMarks = [];
  binCache[0].key = '';
  binCache[1].key = '';
  applyRowPx();

  // start at the end of the trace: "what was live at exit"
  E.hp_seek_seq(n);
  allDirty();
  postMessage({ type: 'loaded', meta, warnings, n });
}

function applyRowPx() {
  E.hp_set_row_px(Math.round(S.rowPx), Math.round(S.gapPx));
}

// --- scroll anchoring: keep the same address pinned at the top of the
// viewport when the playhead (and therefore the collapsed-row layout) changes.

function captureAnchor() {
  if (!S.loaded) return null;
  E.hp_scroll_anchor(S.scroll);
  const r = new Uint32Array(E.memory.buffer, E.hp_ret(), 8);
  if (!r[3]) return null;
  return { lo: r[0], hi: r[1], off: r[2] | 0 };
}

function restoreAnchor(anchor) {
  if (!anchor) return;
  const y = E.hp_scroll_for_addr(anchor.lo, anchor.hi, anchor.off);
  if (y >= 0 && Math.abs(y - S.scroll) > 0.5) {
    S.scroll = y;
    // include the fresh virtual height so the main thread can grow the
    // scroll range before applying the position (otherwise the browser
    // clamps scrollTop against the stale spacer)
    S.lastVirtualH = E.hp_layout();
    postMessage({ type: 'scrollTo', y: y / dpr, virtualH: S.lastVirtualH, anchored: true });
  }
}

function seekAnchored(seq) {
  const anchor = captureAnchor();
  // pin the anchor row so it survives the seek even if everything in it is
  // freed — the user stays exactly where they were looking
  if (anchor) E.hp_set_anchor_pin(anchor.lo, anchor.hi);
  E.hp_seek_seq(seq);
  restoreAnchor(anchor);
}

function allDirty() {
  S.dirty.addr = S.dirty.tlt = S.dirty.tls = true;
}

// Detail-panel info for the allocation an event touches; null when the
// event resolves to no creator (e.g. a free of an unknown id).
function allocInfo(event) {
  if (!event || event.e === undefined || !canvases.addr) return null;
  E.hp_alloc_info(event.e, canvases.addr.width, S.scroll);
  return retJson();
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function renderAddr() {
  const cv = canvases.addr;
  if (!cv || !S.loaded) return;
  const w = cv.width, h = cv.height;
  if (w === 0 || h === 0) return;

  const virtualH = E.hp_layout();
  S.scroll = Math.max(0, Math.min(S.scroll, Math.max(0, virtualH - h)));

  E.hp_render_addr(w, h, S.scroll);
  const [p, l] = retPair();
  const img = new ImageData(new Uint8ClampedArray(E.memory.buffer, p, l), w, h);
  ctxs.addr.putImageData(img, 0, 0);

  // labels (drawn as text on top of the raster)
  E.hp_labels_json();
  const labels = retJson();
  const ctx = ctxs.addr;
  ctx.textBaseline = 'middle';
  for (const lb of labels) {
    if (lb.k === 2) {
      // in-allocation label, centered: "name · size" if it fits, else the
      // name, else the hex size, else nothing
      const fs = Math.min(10 * dpr, S.rowPx - 3);
      if (fs >= 6) {
        ctx.font = `${Math.round(fs)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        const avail = lb.w - 5 * dpr;
        const name = S.names.get(lb.e);
        const candidates = name ? [`${name} · ${lb.text}`, name, lb.text] : [lb.text];
        for (const text of candidates) {
          const tw = ctx.measureText(text).width;
          if (tw <= avail) {
            ctx.fillStyle = 'rgba(8,14,18,0.92)';
            ctx.fillText(text, lb.x + (lb.w - tw) / 2, lb.y + S.rowPx / 2 + dpr);
            break;
          }
        }
      }
    } else if (lb.k === 0) {
      if (S.addrLabels) {
        ctx.font = `${Math.round(10 * dpr)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        const text = lb.addr;
        const tw = ctx.measureText(text).width;
        const y = lb.y + S.rowPx / 2;
        ctx.fillStyle = 'rgba(13,17,23,0.55)';
        ctx.fillRect(2 * dpr, y - 6 * dpr, tw + 8 * dpr, 12 * dpr);
        ctx.fillStyle = 'rgba(160,171,183,0.95)';
        ctx.fillText(text, 6 * dpr, y + dpr);
      }
    } else {
      ctx.font = `${Math.round(9 * dpr)}px ui-monospace, monospace`;
      const text = `${fmtBytes(lb.bytes)} skipped`;
      const tw = ctx.measureText(text).width;
      const x = (w - tw) / 2;
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(x - 6 * dpr, lb.y - 5 * dpr, tw + 12 * dpr, 10 * dpr);
      ctx.fillStyle = 'rgba(110,118,129,0.9)';
      ctx.fillText(text, x, lb.y + dpr);
    }
  }

  // move link / free flash geometry for the overlay
  E.hp_move_link(w, S.scroll);
  S.lastMoveLink = retJson();
  S.lastVirtualH = virtualH;
}

function renderTl(kind) {
  const cv = kind === 0 ? canvases.tlt : canvases.tls;
  const ctx = kind === 0 ? ctxs.tlt : ctxs.tls;
  if (!cv || !S.loaded) return;
  const w = cv.width, h = cv.height;
  if (w === 0 || h === 0) return;
  const view = kind === 0 ? S.tlT : S.tlS;
  const key = `${w}x${h}:${view.lo}:${view.hi}:${S.n}:${tagGen}`;
  const cache = binCache[kind];
  if (cache.key !== key) {
    E.hp_tl_render(kind, w, h, view.lo, view.hi);
    const [p, l] = retPair();
    cache.img = new ImageData(new Uint8ClampedArray(new Uint8Array(E.memory.buffer, p, l)), w, h);
    cache.key = key;
  }
  ctx.putImageData(cache.img, 0, 0);

  // playhead
  const val = kind === 0 ? E.hp_cur_t() : E.hp_cur();
  const x = ((val - view.lo) / (view.hi - view.lo)) * w;
  if (x >= -2 && x <= w + 2) {
    ctx.fillStyle = 'rgba(230,237,243,0.08)';
    ctx.fillRect(0, 0, Math.max(0, x), h);
    ctx.fillStyle = '#e6edf3';
    ctx.fillRect(Math.round(x) - Math.round(dpr / 2), 0, Math.max(1, Math.round(1.5 * dpr)), h);
    // grab triangle
    ctx.beginPath();
    ctx.moveTo(x - 4 * dpr, 0);
    ctx.lineTo(x + 4 * dpr, 0);
    ctx.lineTo(x, 5 * dpr);
    ctx.fill();
  }
}

function postState() {
  const anchor = captureAnchor();
  const h = canvases.addr ? canvases.addr.height : 0;
  const addrMarkYs = S.addrMarks.map((m) => {
    const y = E.hp_scroll_for_addr(m.lo, m.hi, 0);
    if (y < 0) return null;
    const inView = y - S.scroll;
    return inView >= -4 && inView <= h + 4 ? inView / dpr : null;
  });
  postMessage({
    type: 'state',
    anchor: anchor ? '0x' + ((anchor.hi * 0x100000000) + anchor.lo).toString(16) : null,
    addrMarkYs,
    seq: E.hp_cur(),
    n: S.n,
    t: E.hp_cur_t(),
    liveCount: E.hp_live_count(),
    liveBytes: E.hp_live_bytes(),
    virtualH: S.lastVirtualH || 0,
    scroll: S.scroll,
    playing: S.playing,
    tlT: S.tlT,
    tlS: S.tlS,
    moveLink: S.lastMoveLink || null,
  });
}

function fmtBytes(b) {
  if (b < 1024) return `${Math.round(b)} B`;
  const u = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return `${b >= 100 ? b.toFixed(0) : b.toFixed(1)} ${u[i]}`;
}

// ---------------------------------------------------------------------------
// playback + frame loop
// ---------------------------------------------------------------------------

function advance(now) {
  if (!S.lastTick) S.lastTick = now;
  const dt = Math.min(0.25, (now - S.lastTick) / 1000);
  S.lastTick = now;
  if (dt <= 0) return;
  S.playPos += S.playRate * dt;
  let seq;
  if (S.playMode === 't') {
    seq = E.hp_seq_for_t(S.playPos);
    if (S.playPos >= S.tMax) { seq = S.n; stopPlay(); }
  } else {
    seq = Math.floor(S.playPos);
    if (seq >= S.n) { seq = S.n; stopPlay(); }
  }
  if (seq !== E.hp_cur()) {
    seekAnchored(seq);
    allDirty();
  } else {
    // playhead may still move in temporal view between events
    S.dirty.tlt = true;
  }
}

function stopPlay() {
  S.playing = false;
  allDirty();
}

function startPlay(mode, rate) {
  S.playMode = mode;
  S.playRate = rate;
  const cur = E.hp_cur();
  // restart from the beginning if we're at the end
  if (cur >= S.n) {
    E.hp_seek_seq(0);
  }
  S.playPos = mode === 't' ? E.hp_cur_t() : E.hp_cur();
  S.lastTick = 0;
  S.playing = true;
  allDirty();
}

const raf = self.requestAnimationFrame
  ? (f) => self.requestAnimationFrame(f)
  : (f) => setTimeout(() => f(performance.now()), 16);

function frame(now) {
  if (S.loaded) {
    if (S.playing) advance(now);
    let did = false;
    if (S.dirty.addr) { S.dirty.addr = false; renderAddr(); did = true; }
    if (S.dirty.tlt) { S.dirty.tlt = false; renderTl(0); did = true; }
    if (S.dirty.tls) { S.dirty.tls = false; renderTl(1); did = true; }
    if (did) postState();
  }
  raf(frame);
}

// ---------------------------------------------------------------------------
// message handling
// ---------------------------------------------------------------------------

function clampView(view, min, max, minSpan) {
  let { lo, hi } = view;
  if (hi - lo < minSpan) hi = lo + minSpan;
  const span = hi - lo;
  if (span >= max - min) return { lo: min, hi: Math.max(max, min + minSpan) };
  if (lo < min) { lo = min; hi = min + span; }
  if (hi > max) { hi = max; lo = max - span; }
  return { lo, hi };
}

onmessage = async (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'init': {
      dpr = m.dpr || 1;
      canvases.addr = m.addr;
      canvases.tlt = m.tlt;
      canvases.tls = m.tls;
      for (const k of ['addr', 'tlt', 'tls']) {
        ctxs[k] = canvases[k].getContext('2d');
      }
      const resp = await fetch(m.wasmURL, { cache: 'no-cache' });
      const bytes = await resp.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, {});
      E = instance.exports;
      postMessage({ type: 'ready' });
      raf(frame);
      break;
    }
    case 'load':
      try {
        await loadTrace(m.buffer);
      } catch (err) {
        postMessage({ type: 'error', message: String(err && err.message || err) });
      }
      break;
    case 'resize': {
      const cv = canvases[m.which];
      if (cv) {
        dpr = m.dpr || dpr;
        cv.width = Math.max(1, Math.round(m.w));
        cv.height = Math.max(1, Math.round(m.h));
        if (m.which === 'addr') S.dirty.addr = true;
        else if (m.which === 'tlt') { binCache[0].key = ''; S.dirty.tlt = true; }
        else { binCache[1].key = ''; S.dirty.tls = true; }
      }
      break;
    }
    case 'seek': {
      if (!S.loaded) break;
      let seq = m.seq;
      if (m.t !== undefined) seq = E.hp_seq_for_t(m.t);
      seq = Math.max(0, Math.min(S.n, Math.round(seq)));
      seekAnchored(seq);
      S.playPos = S.playMode === 't' ? E.hp_cur_t() : seq;
      allDirty();
      break;
    }
    case 'play':
      startPlay(m.mode, m.rate);
      break;
    case 'pause':
      stopPlay();
      break;
    case 'step': {
      if (!S.loaded) break;
      stopPlay();
      const target = Math.max(0, Math.min(S.n, E.hp_cur() + m.delta));
      if (S.locked) {
        // keep the viewport anchored to the same address instead of scrolling
        seekAnchored(target);
      } else {
        E.hp_seek_seq(target);
      }
      S.playPos = S.playMode === 't' ? E.hp_cur_t() : target;
      const evIdx = m.delta > 0 ? target - 1 : Math.min(target, S.n - 1);
      if (evIdx >= 0 && canvases.addr) {
        E.hp_event_json(evIdx);
        const event = retJson();
        // select the allocation the event touches (F selects what it frees)
        if (event && event.e !== undefined) E.hp_set_selected(event.e);
        if (!S.locked) {
          // center the address-line on that allocation
          const y = E.hp_scroll_for_event(evIdx, canvases.addr.height);
          if (y >= 0) {
            S.scroll = y;
            postMessage({ type: 'scrollTo', y: y / dpr });
          }
          // when zoomed horizontally, also pan it into view
          const pan = E.hp_center_x_for_event(evIdx);
          postMessage({ type: 'xview', pan });
        }
        postMessage({ type: 'stepped', event, info: allocInfo(event) });
      }
      allDirty();
      break;
    }
    case 'jump': {
      if (!S.loaded) break;
      stopPlay();
      let seq = m.seq;
      if (m.t !== undefined) seq = E.hp_seq_for_t(m.t);
      seq = Math.max(0, Math.min(S.n, Math.round(seq)));
      E.hp_seek_seq(seq);
      S.playPos = S.playMode === 't' ? E.hp_cur_t() : seq;
      const evIdx = Math.min(Math.max(0, seq - 1), S.n - 1);
      if (canvases.addr) {
        const y = E.hp_scroll_for_event(evIdx, canvases.addr.height);
        if (y >= 0) {
          S.scroll = y;
          postMessage({ type: 'scrollTo', y: y / dpr });
        }
        const pan = E.hp_center_x_for_event(evIdx);
        postMessage({ type: 'xview', pan });
      }
      if (m.select && evIdx >= 0) {
        E.hp_event_json(evIdx);
        const event = retJson();
        if (event && event.e !== undefined) E.hp_set_selected(event.e);
        postMessage({ type: 'stepped', event, info: allocInfo(event) });
      }
      allDirty();
      break;
    }
    case 'scroll':
      S.scroll = Math.max(0, m.y * dpr);
      S.dirty.addr = true;
      break;
    case 'addr-at': {
      if (!S.loaded || !canvases.addr) break;
      E.hp_addr_at(canvases.addr.width, Math.round(m.x * dpr), m.y * dpr, S.scroll);
      const r = new Uint32Array(E.memory.buffer, E.hp_ret(), 8);
      const addr = r[3] ? '0x' + ((BigInt(r[1]) << 32n) | BigInt(r[0])).toString(16) : null;
      postMessage({ type: 'addr-at', reqId: m.reqId, addr });
      break;
    }
    case 'names':
      S.names = new Map(m.names);
      S.dirty.addr = true;
      break;
    case 'addr-marks': {
      S.addrMarks = m.marks;
      if (E) {
        // pin the marked rows so they stay laid out (and scrollable to)
        // even when nothing is live there
        const buf = new Uint8Array(m.marks.length * 8);
        const dv = new DataView(buf.buffer);
        m.marks.forEach((mk, i) => {
          dv.setUint32(i * 8, mk.lo, true);
          dv.setUint32(i * 8 + 4, mk.hi, true);
        });
        writeBuf(buf);
        E.hp_set_pins(m.marks.length);
      }
      S.dirty.addr = true;
      break;
    }
    case 'goto-addr': {
      if (!S.loaded || !canvases.addr) break;
      const y = E.hp_scroll_for_addr(m.lo, m.hi, 0);
      if (y >= 0) {
        const centered = Math.max(0, y - canvases.addr.height / 2);
        S.scroll = centered;
        S.lastVirtualH = E.hp_layout();
        postMessage({ type: 'scrollTo', y: centered / dpr, virtualH: S.lastVirtualH });
        postMessage({ type: 'addr-flash', y: (y - centered) / dpr });
        S.dirty.addr = true;
      }
      // if a live allocation covers this address at the current playhead,
      // select it (same as clicking it on the map)
      const e = E.hp_live_at_addr(m.lo, m.hi);
      if (e >= 0) {
        E.hp_set_selected(e);
        S.dirty.addr = true;
        postMessage({ type: 'addr-selected', info: allocInfo({ e }) });
      }
      break;
    }
    case 'tlview': {
      if (!S.loaded) break;
      const raw = { lo: m.lo, hi: m.hi };
      if (m.kind === 0) {
        S.tlT = clampView(raw, S.tMin, Math.max(S.tMax, S.tMin + 1), 1e-9);
        S.dirty.tlt = true;
      } else {
        S.tlS = clampView(raw, 0, Math.max(S.n, 1), 4);
        S.dirty.tls = true;
      }
      break;
    }
    case 'set': {
      if (!S.loaded && !['rowPx', 'locked', 'sizeLabels', 'addrLabels'].includes(m.key)) break;
      switch (m.key) {
        case 'rowBytes': {
          const anchor = captureAnchor();
          E.hp_set_row_bytes(m.value);
          restoreAnchor(anchor);
          S.dirty.addr = true;
          break;
        }
        case 'collapseMin': {
          const anchor = captureAnchor();
          if (m.mode === 'bytes') E.hp_set_collapse_min_bytes(m.value);
          else E.hp_set_collapse_min(m.value);
          restoreAnchor(anchor);
          S.dirty.addr = true;
          break;
        }
        case 'rowPx':
          S.rowPx = m.value * dpr;
          S.gapPx = Math.max(8, Math.round(S.rowPx * 0.6));
          if (E) applyRowPx();
          S.dirty.addr = true;
          break;
        case 'locked':
          S.locked = !!m.value;
          break;
        case 'sizeLabels':
          if (E) E.hp_set_size_labels(m.value ? 1 : 0);
          S.dirty.addr = true;
          break;
        case 'addrLabels':
          S.addrLabels = !!m.value;
          S.dirty.addr = true;
          break;
        case 'showAll': {
          const anchor = captureAnchor();
          E.hp_set_show_all(m.value ? 1 : 0);
          restoreAnchor(anchor);
          S.dirty.addr = true;
          break;
        }
        case 'xview':
          E.hp_set_xview(m.value.zoom, m.value.pan);
          S.dirty.addr = true;
          break;
        case 'colorMode':
          E.hp_set_color_mode(m.value);
          S.dirty.addr = true;
          break;
        case 'selected':
          E.hp_set_selected(m.value === null ? 0xffffffff : m.value);
          S.dirty.addr = true;
          break;
        case 'filter': {
          const len = writeBuf(te.encode(JSON.stringify(m.value)));
          E.hp_set_filter(len);
          S.dirty.addr = true;
          break;
        }
        case 'crop':
          E.hp_set_crop(m.value ? Math.round(m.value.lo) : -1, m.value ? Math.round(m.value.hi) : -1);
          S.dirty.addr = true;
          break;
      }
      break;
    }
    // domain conversion: given a [lo,hi] range in the `kind` domain (0 = time,
    // 1 = seq), return the equivalent range in the other domain — shared by
    // crop (time -> seq) and the time/events strip mirroring (either way)
    case 'convert': {
      if (!S.loaded) { postMessage({ type: 'convert-result', reqId: m.reqId, lo: m.lo, hi: m.hi }); break; }
      let lo, hi;
      if (m.kind === 0) {
        lo = E.hp_seq_for_t(m.lo);
        hi = E.hp_seq_for_t(m.hi);
      } else {
        lo = E.hp_t_for_seq(Math.max(0, Math.round(m.lo)));
        hi = E.hp_t_for_seq(Math.max(0, Math.round(m.hi)));
      }
      postMessage({ type: 'convert-result', reqId: m.reqId, lo, hi });
      break;
    }
    case 'tag-event':
      if (!S.loaded) break;
      E.hp_tag_event(m.e, m.tag);
      tagsChanged();
      break;
    case 'tag-range': {
      if (!S.loaded) break;
      const byFree = m.byFree ? 1 : 0;
      const count = m.kind === 0
        ? E.hp_tag_t_range(m.lo, m.hi, m.tag, byFree)
        : E.hp_tag_seq_range(Math.max(0, Math.round(m.lo)), Math.max(0, Math.round(m.hi)), m.tag, byFree);
      postMessage({ type: 'tagged', count, tag: m.tag });
      tagsChanged();
      break;
    }
    case 'tags-dump': {
      if (!S.loaded) break;
      E.hp_tags_dump_json();
      postMessage({ type: 'tags-dump', reqId: m.reqId, tags: retJson() });
      break;
    }
    case 'tag-events': {
      if (!S.loaded) break;
      const arr = new Uint32Array(m.events.length);
      arr.set(m.events);
      writeBuf(new Uint8Array(arr.buffer));
      E.hp_tag_events(m.events.length, m.tag);
      tagsChanged();
      break;
    }
    case 'retag':
      if (!S.loaded) break;
      E.hp_retag(m.from, m.to);
      tagsChanged();
      break;
    case 'tags-clear':
      if (!S.loaded) break;
      E.hp_tags_clear();
      tagsChanged();
      break;
    case 'tag-colors': {
      if (!S.loaded) break;
      const buf = new Uint8Array(m.colors.length * 4);
      const dv = new DataView(buf.buffer);
      m.colors.forEach((rgb, i) => dv.setUint32(i * 4, rgb, true));
      writeBuf(buf);
      E.hp_set_tag_colors(m.colors.length);
      tagGen++;
      S.dirty.addr = S.dirty.tlt = S.dirty.tls = true;
      break;
    }
    case 'alloc-color':
      if (!S.loaded) break;
      if (m.rgb === null) E.hp_clear_alloc_color(m.e);
      else E.hp_set_alloc_color(m.e, m.rgb);
      S.dirty.addr = true;
      break;
    case 'pick': {
      if (!S.loaded || !canvases.addr) break;
      E.hp_pick(canvases.addr.width, Math.round(m.x * dpr), m.y * dpr, S.scroll);
      postMessage({ type: 'pick-result', reqId: m.reqId, info: retJson(), forClick: m.forClick });
      break;
    }
    case 'events': {
      if (!S.loaded) break;
      E.hp_events_json(m.from, m.count);
      postMessage({ type: 'events', reqId: m.reqId, from: m.from, events: retJson() });
      break;
    }
    case 'flash-event': {
      // re-click on the current event in the list: scroll/pan it into view
      // and flash its exact location (tiny allocations become findable)
      if (!S.loaded || !canvases.addr) break;
      const evIdx = Math.max(0, Math.min(S.n - 1, m.seq));
      const y = E.hp_scroll_for_event(evIdx, canvases.addr.height);
      if (y >= 0 && Math.abs(y - S.scroll) > 1) {
        S.scroll = y;
        postMessage({ type: 'scrollTo', y: y / dpr });
        S.dirty.addr = true;
      }
      const pan = E.hp_center_x_for_event(evIdx);
      postMessage({ type: 'xview', pan });
      E.hp_event_rects(evIdx, canvases.addr.width, S.scroll);
      postMessage({ type: 'flash-rects', rects: retJson() });
      break;
    }
    case 'tlhover': {
      if (!S.loaded) break;
      const view = m.kind === 0 ? S.tlT : S.tlS;
      const cv = m.kind === 0 ? canvases.tlt : canvases.tls;
      E.hp_tl_hover(m.kind, cv.width, Math.min(cv.width - 1, Math.round(m.x * dpr)), view.lo, view.hi);
      postMessage({ type: 'tlhover-result', reqId: m.reqId, kind: m.kind, info: retJson() });
      break;
    }
  }
};
