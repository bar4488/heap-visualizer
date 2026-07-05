//! heap-visualizer core: WASM-side engine. Exposed to JS through a plain C ABI —
//! buffers move through `hp_buf_*`, multi-value returns go through the
//! 8-slot u32 return area at `hp_ret()`, and structured results are JSON
//! strings (ptr/len in ret[0]/ret[1]).

pub mod json;
pub mod parse;
pub mod render;
pub mod state;
pub mod store;
pub mod timeline;

use std::cell::UnsafeCell;

use json::push_json_str;
use parse::Parser;
use render::{Cfg, Filter, Frame};
use state::View;
use store::*;

struct Global<T>(UnsafeCell<T>);
// SAFETY: wasm32-unknown-unknown is single-threaded; native tests use the
// safe accessors below only from one thread.
unsafe impl<T> Sync for Global<T> {}

struct App {
    parser: Option<Parser>,
    store: Store,
    view: View,
    cfg: Cfg,
    frame: Frame,
    tl_px: Vec<u8>,
    buf: Vec<u8>,    // input buffer (file chunks, filter JSON)
    out: String,     // reused JSON output
    labels: String,  // labels from the last address render
}

impl App {
    fn new() -> Self {
        App {
            parser: None,
            store: Store::default(),
            view: View::new(),
            cfg: Cfg::new(),
            frame: Frame::new(),
            tl_px: Vec::new(),
            buf: Vec::new(),
            out: String::new(),
            labels: String::new(),
        }
    }
}

static APP: Global<Option<App>> = Global(UnsafeCell::new(None));
static RET: Global<[u32; 8]> = Global(UnsafeCell::new([0; 8]));

fn app() -> &'static mut App {
    unsafe {
        let slot = &mut *APP.0.get();
        if slot.is_none() {
            *slot = Some(App::new());
        }
        slot.as_mut().unwrap()
    }
}

fn ret() -> &'static mut [u32; 8] {
    unsafe { &mut *RET.0.get() }
}

fn ret_str(s: &str) {
    let r = ret();
    r[0] = s.as_ptr() as u32;
    r[1] = s.len() as u32;
}

#[no_mangle]
pub extern "C" fn hp_ret() -> *const u32 {
    ret().as_ptr()
}

// ---------------------------------------------------------------------------
// input buffer
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn hp_buf_ptr(cap: u32) -> *mut u8 {
    let a = app();
    if a.buf.len() < cap as usize {
        a.buf.resize(cap as usize, 0);
    }
    a.buf.as_mut_ptr()
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn hp_parse_begin() {
    let a = app();
    a.parser = Some(Parser::new());
    a.store = Store::default();
    a.view = View::new();
    a.cfg.selected = NONE_U32;
    a.cfg.filter = Filter::default();
    a.cfg.x_zoom = 1.0;
    a.cfg.x_pan = 0.0;
}

#[no_mangle]
pub extern "C" fn hp_parse_chunk(len: u32) {
    let a = app();
    if let Some(p) = a.parser.as_mut() {
        let data = &a.buf[..len as usize];
        p.chunk(data);
    }
}

#[no_mangle]
pub extern "C" fn hp_parse_end() -> u32 {
    let a = app();
    if let Some(mut p) = a.parser.take() {
        p.finish();
        a.store = p.store;
        a.view.reset(&a.store);
    }
    a.store.len()
}

// ---------------------------------------------------------------------------
// metadata / warnings
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn hp_meta_json() {
    let a = app();
    let s = &a.store;
    let o = &mut a.out;
    o.clear();
    o.push('{');
    o.push_str(&format!(
        "\"n\":{},\"tMin\":{},\"tMax\":{},\"nMalloc\":{},\"nFree\":{},\"nRealloc\":{}",
        s.len(),
        s.t_min as f64,
        s.t_max as f64,
        s.n_malloc,
        s.n_free,
        s.n_realloc
    ));
    o.push_str(&format!(
        ",\"addrMin\":\"0x{:x}\",\"addrMax\":\"0x{:x}\",\"peakLive\":{},\"totalAlloc\":{}",
        if s.addr_min == u64::MAX { 0 } else { s.addr_min },
        s.addr_max,
        s.peak_live_bytes as f64,
        s.total_alloc_bytes as f64
    ));
    o.push_str(",\"unit\":");
    push_json_str(o, &s.unit);
    o.push_str(",\"title\":");
    push_json_str(o, &s.title);
    o.push_str(&format!(
        ",\"hasHeader\":{},\"rowBytesHint\":{},\"rowBytes\":{}",
        s.has_header,
        s.hdr_row_bytes as f64,
        a.view.row_bytes as f64
    ));
    o.push_str(",\"sites\":[");
    for (i, name) in s.sites.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        o.push_str("{\"name\":");
        push_json_str(o, name);
        o.push_str(&format!(",\"count\":{}}}", s.site_count[i]));
    }
    o.push_str("],\"thrs\":[");
    for (i, thr) in s.thrs.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        o.push_str(&format!("{{\"thr\":{},\"count\":{}}}", thr, s.thr_count[i]));
    }
    o.push_str("],\"warnTotal\":");
    let total: u32 = s.warn_counts.iter().sum();
    o.push_str(&format!("{}", total));
    o.push_str(",\"warnCounts\":[");
    for (i, c) in s.warn_counts.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        o.push_str(&format!("{}", c));
    }
    o.push_str("]}");
    ret_str(o);
}

#[no_mangle]
pub extern "C" fn hp_warnings_json() {
    let a = app();
    let s = &a.store;
    let o = &mut a.out;
    o.clear();
    o.push('[');
    for (i, w) in s.warnings.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        o.push_str(&format!("{{\"seq\":{},\"code\":{},\"msg\":", w.seq, w.code));
        push_json_str(o, warn_name(w.code));
        o.push_str(&format!(",\"detail\":{}}}", w.detail as f64));
    }
    o.push(']');
    ret_str(o);
}

// ---------------------------------------------------------------------------
// playhead
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn hp_seek_seq(seq: u32) {
    let a = app();
    a.view.seek(&a.store, seq);
}

#[no_mangle]
pub extern "C" fn hp_seek_t(t: f64) {
    let a = app();
    let seq = a.store.seq_for_t(t.max(0.0) as u64);
    a.view.seek(&a.store, seq);
}

#[no_mangle]
pub extern "C" fn hp_cur() -> u32 {
    app().view.cur
}

#[no_mangle]
pub extern "C" fn hp_cur_t() -> f64 {
    let a = app();
    a.store.t_at(a.view.cur) as f64
}

#[no_mangle]
pub extern "C" fn hp_live_count() -> u32 {
    app().view.live_count
}

#[no_mangle]
pub extern "C" fn hp_live_bytes() -> f64 {
    app().view.live_bytes as f64
}

#[no_mangle]
pub extern "C" fn hp_seq_for_t(t: f64) -> u32 {
    app().store.seq_for_t(t.max(0.0) as u64)
}

#[no_mangle]
pub extern "C" fn hp_t_for_seq(seq: u32) -> f64 {
    let a = app();
    a.store.t_at(seq.min(a.store.len())) as f64
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn hp_set_row_bytes(w: f64) {
    let a = app();
    a.view.set_row_bytes(&a.store, w.max(16.0) as u64);
}

#[no_mangle]
pub extern "C" fn hp_row_bytes() -> f64 {
    app().view.row_bytes as f64
}

#[no_mangle]
pub extern "C" fn hp_set_collapse_min(n: u32) {
    app().view.set_collapse_min(n as u64);
}

#[no_mangle]
pub extern "C" fn hp_set_collapse_min_bytes(bytes: f64) {
    app().view.set_collapse_min_bytes(bytes.max(1.0) as u64);
}

#[no_mangle]
pub extern "C" fn hp_set_row_px(row_px: u32, gap_px: u32) {
    let a = app();
    a.cfg.row_px = row_px.clamp(2, 64);
    a.cfg.gap_px = gap_px.clamp(2, 32);
}

#[no_mangle]
pub extern "C" fn hp_set_color_mode(mode: u32) {
    app().cfg.color_mode = mode as u8;
}

#[no_mangle]
pub extern "C" fn hp_set_selected(e: u32) {
    app().cfg.selected = e;
}

/// Horizontal zoom/pan on the byte axis of each row. `zoom` >= 1 (1 = the
/// whole row fits the width); `pan` is a fraction of the row [0, 1 - 1/zoom].
#[no_mangle]
pub extern "C" fn hp_set_xview(zoom: f64, pan: f64) {
    let a = app();
    a.cfg.x_zoom = if zoom.is_finite() { zoom.max(1.0) } else { 1.0 };
    let max_pan = 1.0 - 1.0 / a.cfg.x_zoom;
    a.cfg.x_pan = if pan.is_finite() { pan.clamp(0.0, max_pan) } else { 0.0 };
}

/// Pan the horizontal view so the allocation touched by event `e` is centered
/// (no-op when not zoomed). Returns the resulting pan fraction.
#[no_mangle]
pub extern "C" fn hp_center_x_for_event(e: u32) -> f64 {
    let a = app();
    let s = &a.store;
    if e >= s.len() || a.cfg.x_zoom <= 1.0 {
        return a.cfg.x_pan;
    }
    let ei = e as usize;
    let creator = if s.op[ei] == OP_F { s.target[ei] } else { e };
    if creator == NONE_U32 {
        return a.cfg.x_pan;
    }
    let rb = a.view.row_bytes;
    let off = s.addr[creator as usize].saturating_sub(a.view.base) % rb;
    let vis = 1.0 / a.cfg.x_zoom;
    a.cfg.x_pan = (off as f64 / rb as f64 - vis / 2.0).clamp(0.0, 1.0 - vis);
    a.cfg.x_pan
}

/// Show/hide the hex size labels drawn inside allocations.
#[no_mangle]
pub extern "C" fn hp_set_size_labels(on: u32) {
    app().cfg.size_labels = on != 0;
}

/// Toggle the stable "all rows" layout: every row any allocation ever
/// touches stays laid out regardless of the playhead.
#[no_mangle]
pub extern "C" fn hp_set_show_all(on: u32) {
    let a = app();
    a.view.set_show_all(&a.store, on != 0);
}

/// Pin the scroll anchor (the address at the top of the viewport) so its row
/// survives seeks even when everything in it is freed.
#[no_mangle]
pub extern "C" fn hp_set_anchor_pin(lo: u32, hi: u32) {
    let addr = (hi as u64) << 32 | lo as u64;
    app().view.set_anchor_pin(Some(addr));
}

/// Pinned addresses, written into the input buffer as consecutive u64 LE
/// values. Their rows stay laid out even when empty (see View::pins).
#[no_mangle]
pub extern "C" fn hp_set_pins(count: u32) {
    let a = app();
    let mut pins = Vec::with_capacity(count as usize);
    for i in 0..count as usize {
        let b = &a.buf[i * 8..i * 8 + 8];
        pins.push(u64::from_le_bytes(b.try_into().unwrap()));
    }
    a.view.set_pins(pins);
}

/// Filter spec is written into the input buffer as JSON:
/// {"mode":1,"sites":[0,3],"thrs":[1],"sizeMin":0,"sizeMax":0}
#[no_mangle]
pub extern "C" fn hp_set_filter(len: u32) {
    let a = app();
    let data: Vec<u8> = a.buf[..len as usize].to_vec();
    let mut f = Filter::default();
    let mut sc = json::Scan::new(&data);
    if sc.eat(b'{') {
        loop {
            let span = match sc.string_span() {
                Some(s) => s,
                None => break,
            };
            if !sc.eat(b':') {
                break;
            }
            let key = &data[span.0..span.1];
            match key {
                b"mode" => {
                    f.mode = sc.integer().unwrap_or(0) as u8;
                }
                b"sizeMin" => {
                    f.size_min = sc.integer().unwrap_or(0).max(0) as u64;
                }
                b"sizeMax" => {
                    f.size_max = sc.integer().unwrap_or(0).max(0) as u64;
                }
                b"sites" | b"thrs" | b"tags" => {
                    let words = if key == b"sites" {
                        &mut f.sites
                    } else if key == b"thrs" {
                        &mut f.thrs
                    } else {
                        &mut f.tags
                    };
                    sc.ws();
                    if sc.peek() == b'[' {
                        sc.i += 1;
                        loop {
                            sc.ws();
                            if sc.peek() == b']' {
                                sc.i += 1;
                                break;
                            }
                            if let Some(v) = sc.integer() {
                                let v = v.max(0) as u32;
                                let w = (v / 64) as usize;
                                if words.len() <= w {
                                    words.resize(w + 1, 0);
                                }
                                words[w] |= 1u64 << (v % 64);
                            } else {
                                break;
                            }
                            sc.ws();
                            if sc.peek() == b',' {
                                sc.i += 1;
                            }
                        }
                    } else {
                        // "null" means no constraint
                        let _ = sc.skip_value();
                    }
                }
                _ => {
                    let _ = sc.skip_value();
                }
            }
            sc.ws();
            if sc.peek() == b',' {
                sc.i += 1;
            } else {
                break;
            }
        }
    }
    a.cfg.filter = f;
}

// ---------------------------------------------------------------------------
// tagging
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn hp_tag_event(e: u32, tag: u32) {
    let a = app();
    if (e as usize) < a.store.tag.len() {
        a.store.tag[e as usize] = tag.min(255) as u8;
    }
}

/// Tag allocations touched by events in the seq range [lo, hi). With
/// `by_free == 0` that is every allocation *created* in the range (M/R);
/// with `by_free != 0` it is every allocation *freed* in the range (the
/// creator each F/R kills). When a filter is active (dim or hide), only
/// allocations it matches are tagged — the filter defines the working set.
/// Returns the number tagged.
#[no_mangle]
pub extern "C" fn hp_tag_seq_range(lo: u32, hi: u32, tag: u32, by_free: u32) -> u32 {
    tag_seq_range(app(), lo, hi, tag, by_free)
}

fn tag_seq_range(a: &mut App, lo: u32, hi: u32, tag: u32, by_free: u32) -> u32 {
    let tag = tag.min(255) as u8;
    let mut to_tag: Vec<u32> = {
        let s = &a.store;
        let f = &a.cfg.filter;
        let filtered = f.mode != render::FILTER_OFF;
        (lo..hi.min(s.len()))
            .filter_map(|e| {
                let op = s.op[e as usize];
                if by_free != 0 {
                    if (op == OP_F || op == OP_R) && s.target[e as usize] != NONE_U32 {
                        Some(s.target[e as usize])
                    } else {
                        None
                    }
                } else if op == OP_M || op == OP_R {
                    Some(e)
                } else {
                    None
                }
            })
            .filter(|&c| !filtered || f.pass(s, c))
            .collect()
    };
    to_tag.dedup();
    let n = to_tag.len() as u32;
    for e in to_tag {
        a.store.tag[e as usize] = tag;
    }
    n
}

/// Tag every allocation created (or freed, see `by_free`) in the time range
/// [lo, hi]. Returns count.
#[no_mangle]
pub extern "C" fn hp_tag_t_range(lo: f64, hi: f64, tag: u32, by_free: u32) -> u32 {
    let (b0, b1) = {
        let s = &app().store;
        (
            s.lower_bound_t(lo.max(0.0).ceil() as u64),
            s.seq_for_t(hi.max(0.0).floor() as u64),
        )
    };
    hp_tag_seq_range(b0, b1, tag, by_free)
}

/// Tag colors are written into the input buffer as consecutive u32 LE rgb
/// values (0xRRGGBB), one per tag id starting at 1.
#[no_mangle]
pub extern "C" fn hp_set_tag_colors(count: u32) {
    let a = app();
    a.cfg.tag_colors.clear();
    for i in 0..count as usize {
        let b = &a.buf[i * 4..i * 4 + 4];
        let rgb = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        a.cfg.tag_colors.push([
            ((rgb >> 16) & 0xff) as u8,
            ((rgb >> 8) & 0xff) as u8,
            (rgb & 0xff) as u8,
        ]);
    }
}

/// Per-allocation color override (any color mode).
#[no_mangle]
pub extern "C" fn hp_set_alloc_color(e: u32, rgb: u32) {
    app().cfg.overrides.insert(
        e,
        [
            ((rgb >> 16) & 0xff) as u8,
            ((rgb >> 8) & 0xff) as u8,
            (rgb & 0xff) as u8,
        ],
    );
}

#[no_mangle]
pub extern "C" fn hp_clear_alloc_color(e: u32) {
    app().cfg.overrides.remove(&e);
}

/// Bulk-apply a tag: the input buffer holds `count` u32 LE creator-event
/// indices. Invalid indices are ignored. Used by analysis-file import.
#[no_mangle]
pub extern "C" fn hp_tag_events(count: u32, tag: u32) -> u32 {
    let a = app();
    let s = &mut a.store;
    let tag = tag.min(255) as u8;
    let n = s.len();
    let mut applied = 0;
    for i in 0..count as usize {
        let b = &a.buf[i * 4..i * 4 + 4];
        let e = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        if e < n {
            let op = s.op[e as usize];
            if op == OP_M || op == OP_R {
                s.tag[e as usize] = tag;
                applied += 1;
            }
        }
    }
    applied
}

/// Remove every tag assignment (analysis import starts from a clean slate;
/// unlike range tagging this ignores the active filter).
#[no_mangle]
pub extern "C" fn hp_tags_clear() {
    for t in app().store.tag.iter_mut() {
        *t = 0;
    }
}

/// Replace every occurrence of tag `from` with `to` (delete = retag to 0,
/// and shift higher ids down when a tag is removed from the list).
#[no_mangle]
pub extern "C" fn hp_retag(from: u32, to: u32) -> u32 {
    let a = app();
    let (from, to) = (from.min(255) as u8, to.min(255) as u8);
    let mut n = 0;
    for t in a.store.tag.iter_mut() {
        if *t == from {
            *t = to;
            n += 1;
        }
    }
    n
}

/// All tag assignments, for analysis export: {"1":[e,e,...],"2":[...]}.
#[no_mangle]
pub extern "C" fn hp_tags_dump_json() {
    let a = app();
    let s = &a.store;
    let mut lists: Vec<Vec<u32>> = vec![Vec::new(); 256];
    for e in 0..s.len() {
        let t = s.tag[e as usize];
        if t != 0 {
            lists[t as usize].push(e);
        }
    }
    let o = &mut a.out;
    o.clear();
    o.push('{');
    let mut first = true;
    for (t, list) in lists.iter().enumerate() {
        if list.is_empty() {
            continue;
        }
        if !first {
            o.push(',');
        }
        first = false;
        o.push_str(&format!("\"{}\":[", t));
        for (i, e) in list.iter().enumerate() {
            if i > 0 {
                o.push(',');
            }
            o.push_str(&format!("{}", e));
        }
        o.push(']');
    }
    o.push('}');
    ret_str(o);
}

/// Count of tagged creator events per tag id: [{"tag":1,"count":42},...]
/// (tag 0 reports the untagged creator count).
#[no_mangle]
pub extern "C" fn hp_tag_counts_json() {
    let a = app();
    let s = &a.store;
    let mut counts = [0u32; 256];
    for e in 0..s.len() as usize {
        if s.op[e] == OP_M || s.op[e] == OP_R {
            counts[s.tag[e] as usize] += 1;
        }
    }
    let o = &mut a.out;
    o.clear();
    o.push('[');
    let mut first = true;
    for (i, &c) in counts.iter().enumerate() {
        if c == 0 && i != 0 {
            continue;
        }
        if !first {
            o.push(',');
        }
        first = false;
        o.push_str(&format!("{{\"tag\":{},\"count\":{}}}", i, c));
    }
    o.push(']');
    ret_str(o);
}

// ---------------------------------------------------------------------------
// address-line rendering & queries
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn hp_layout() -> f64 {
    let a = app();
    a.view.ensure_rows();
    a.view.virtual_height(a.cfg.row_px, a.cfg.gap_px) as f64
}

#[no_mangle]
pub extern "C" fn hp_render_addr(w: u32, h: u32, scroll: f64) {
    let a = app();
    let out = render::render_addr(&a.store, &mut a.view, &a.cfg, &mut a.frame, w, h, scroll);
    a.labels = out.labels;
    let r = ret();
    r[0] = a.frame.px.as_ptr() as u32;
    r[1] = a.frame.px.len() as u32;
}

#[no_mangle]
pub extern "C" fn hp_labels_json() {
    let a = app();
    ret_str(&a.labels);
}

#[no_mangle]
pub extern "C" fn hp_pick(w: u32, x: u32, y: f64, scroll: f64) {
    let a = app();
    a.out = render::pick(&a.store, &mut a.view, &a.cfg, w, x, y, scroll);
    ret_str(&a.out);
}

#[no_mangle]
pub extern "C" fn hp_move_link(w: u32, scroll: f64) {
    let a = app();
    a.out = render::move_link(&a.store, &mut a.view, &a.cfg, w, scroll);
    ret_str(&a.out);
}

/// Rects covering the allocation event `e` touches (for the event-list flash).
#[no_mangle]
pub extern "C" fn hp_event_rects(e: u32, w: u32, scroll: f64) {
    let a = app();
    a.out = render::event_rects(&a.store, &mut a.view, &a.cfg, w, e, scroll);
    ret_str(&a.out);
}

/// Detail-panel info for the allocation created at event `e` (same JSON shape
/// as hp_pick); null if `e` is not a creator (M/R) event.
#[no_mangle]
pub extern "C" fn hp_alloc_info(e: u32, w: u32, scroll: f64) {
    let a = app();
    let is_creator = {
        let s = &a.store;
        e < s.len() && (s.op[e as usize] == OP_M || s.op[e as usize] == OP_R)
    };
    if !is_creator {
        a.out.clear();
        a.out.push_str("null");
    } else {
        let addr = a.store.addr[e as usize];
        a.out = render::alloc_info(&a.store, &mut a.view, &a.cfg, w, addr, e, scroll);
    }
    ret_str(&a.out);
}

/// Address under canvas pixel (x, y) given scroll, whether or not a live
/// allocation covers it. ret[0]/ret[1] = addr (u64 lo/hi), ret[3] = found
/// (0 when the pixel is in a gap marker or outside the layout).
#[no_mangle]
pub extern "C" fn hp_addr_at(w: u32, x: u32, y: f64, scroll: f64) {
    let a = app();
    let v = &mut a.view;
    v.ensure_rows();
    let r = ret();
    r[3] = 0;
    if w == 0 || v.rows.is_empty() {
        return;
    }
    let yv = (y + scroll).max(0.0) as u64;
    if let Some(i) = v.row_at_y(yv, a.cfg.row_px, a.cfg.gap_px) {
        let row_start = v.base + v.rows[i] * v.row_bytes;
        let (scale, pan) = a.cfg.x_map(w, v.row_bytes);
        let off = (pan + x as f64 / scale) as u64;
        let addr = row_start + off.min(v.row_bytes - 1);
        r[0] = addr as u32;
        r[1] = (addr >> 32) as u32;
        r[3] = 1;
    }
}

/// Capture the scroll anchor for the current layout. Writes to the return
/// area: ret[0]/ret[1] = anchor address (u64 lo/hi), ret[2] = pixel offset
/// (i32 bits), ret[3] = 1 if an anchor exists.
#[no_mangle]
pub extern "C" fn hp_scroll_anchor(scroll: f64) {
    let a = app();
    let r = ret();
    match a.view.anchor_at(scroll, a.cfg.row_px, a.cfg.gap_px) {
        Some((addr, off)) => {
            r[0] = addr as u32;
            r[1] = (addr >> 32) as u32;
            r[2] = off as u32;
            r[3] = 1;
        }
        None => {
            r[3] = 0;
        }
    }
}

/// Scroll offset that restores a previously captured anchor under the
/// current layout; -1 if nothing is laid out.
#[no_mangle]
pub extern "C" fn hp_scroll_for_addr(addr_lo: u32, addr_hi: u32, offset: i32) -> f64 {
    let a = app();
    let addr = (addr_hi as u64) << 32 | addr_lo as u64;
    a.view
        .scroll_for_addr(addr, offset, a.cfg.row_px, a.cfg.gap_px)
}

#[no_mangle]
pub extern "C" fn hp_scroll_for_event(e: u32, h: u32) -> f64 {
    let a = app();
    render::scroll_for_event(&a.store, &mut a.view, &a.cfg, h, e)
}

/// One event as JSON, appended to `o`. `e` also carries the creator event
/// index (the allocation the event touches — for F that is its target), so
/// the viewer can select/highlight it.
fn push_event_json(o: &mut String, s: &Store, e: u32) {
    if e >= s.len() {
        o.push_str("null");
        return;
    }
    let ei = e as usize;
    // an F row carries no geometry of its own: report the allocation it kills
    let gi = if s.op[ei] == OP_F && s.target[ei] != NONE_U32 {
        s.target[ei] as usize
    } else {
        ei
    };
    o.push_str(&format!(
        "{{\"seq\":{},\"op\":{},\"t\":{},\"id\":{},\"e\":{},\"addr\":\"0x{:x}\",\"size\":{}",
        e, s.op[ei], s.t[ei] as f64, s.id[ei], gi, s.addr[gi], s.size[gi]
    ));
    if s.op[ei] == OP_R {
        o.push_str(&format!(
            ",\"oldAddr\":\"0x{:x}\",\"oldSize\":{}",
            s.old_addr[ei], s.old_size[ei]
        ));
    }
    o.push_str(",\"site\":");
    let si = if s.site[gi] != NONE_U32 { gi } else { ei };
    if s.site[si] != NONE_U32 {
        push_json_str(o, &s.sites[s.site[si] as usize]);
    } else {
        o.push_str("null");
    }
    o.push('}');
}

/// Details of one event (for the step readout / warning jumps).
#[no_mangle]
pub extern "C" fn hp_event_json(e: u32) {
    let a = app();
    let s = &a.store;
    let o = &mut a.out;
    o.clear();
    push_event_json(o, s, e);
    ret_str(o);
}

/// A slice of events [from, from + count) for the event-list panel.
#[no_mangle]
pub extern "C" fn hp_events_json(from: u32, count: u32) {
    let a = app();
    let s = &a.store;
    let o = &mut a.out;
    o.clear();
    o.push('[');
    let hi = from.saturating_add(count.min(2000)).min(s.len());
    for e in from..hi {
        if e > from {
            o.push(',');
        }
        push_event_json(o, s, e);
    }
    o.push(']');
    ret_str(o);
}

// ---------------------------------------------------------------------------
// timelines
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn hp_tl_render(kind: u32, w: u32, h: u32, lo: f64, hi: f64) {
    let a = app();
    timeline::render(&a.store, &a.cfg, kind, w, h, lo, hi, &mut a.tl_px);
    let r = ret();
    r[0] = a.tl_px.as_ptr() as u32;
    r[1] = a.tl_px.len() as u32;
}

#[no_mangle]
pub extern "C" fn hp_tl_hover(kind: u32, w: u32, x: u32, lo: f64, hi: f64) {
    let a = app();
    a.out = timeline::hover(&a.store, kind, w, x, lo, hi);
    ret_str(&a.out);
}

// ---------------------------------------------------------------------------
// tests (native)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn load(input: &str) -> App {
        let mut a = App::new();
        let mut p = Parser::new();
        // feed in awkward chunk sizes to exercise the carry path
        let b = input.as_bytes();
        let mut i = 0;
        while i < b.len() {
            let end = (i + 7).min(b.len());
            p.chunk(&b[i..end]);
            i = end;
        }
        p.finish();
        a.store = p.store;
        a.view.reset(&a.store);
        a
    }

    const SAMPLE: &str = r#"{"op":"H","v":1,"unit":"ns","row_bytes":4096,"title":"test"}
# a comment

{"seq":0,"t":100,"op":"M","id":1,"addr":"0x1000","size":64,"thr":0,"site":"a"}
{"seq":1,"t":200,"op":"M","id":2,"addr":"0x2000","size":128,"thr":1,"site":"b"}
{"seq":2,"t":200,"op":"F","id":1}
{"seq":3,"t":300,"op":"R","id":3,"old_id":2,"addr":"0x3000","size":256}
{"seq":4,"t":400,"op":"F","id":3}
"#;

    #[test]
    fn parse_basic() {
        let a = load(SAMPLE);
        let s = &a.store;
        assert_eq!(s.len(), 5);
        assert_eq!(s.n_malloc, 2);
        assert_eq!(s.n_free, 2);
        assert_eq!(s.n_realloc, 1);
        assert!(s.has_header);
        assert_eq!(s.title, "test");
        assert_eq!(s.t_min, 100);
        assert_eq!(s.t_max, 400);
        // free of id 1 resolves to event 0
        assert_eq!(s.target[2], 0);
        assert_eq!(s.death[0], 2);
        // realloc kills event 1, creates event 3, freed by event 4
        assert_eq!(s.target[3], 1);
        assert_eq!(s.death[1], 3);
        assert_eq!(s.death[3], 4);
        assert_eq!(s.old_addr[3], 0x2000);
        let total: u32 = s.warn_counts.iter().sum();
        assert_eq!(total, 0);
    }

    #[test]
    fn seek_live_sets() {
        let mut a = load(SAMPLE);
        let s = &a.store;
        a.view.seek(s, 2);
        assert_eq!(a.view.live_count, 2);
        assert_eq!(a.view.live_bytes, 192);
        a.view.seek(s, 3); // free id 1
        assert_eq!(a.view.live_count, 1);
        assert_eq!(a.view.live_bytes, 128);
        a.view.seek(s, 4); // realloc
        assert_eq!(a.view.live_count, 1);
        assert_eq!(a.view.live_bytes, 256);
        a.view.seek(s, 5);
        assert_eq!(a.view.live_count, 0);
        // backward
        a.view.seek(s, 2);
        assert_eq!(a.view.live_count, 2);
        assert_eq!(a.view.live_bytes, 192);
        a.view.seek(s, 0);
        assert_eq!(a.view.live_count, 0);
        assert_eq!(a.view.live_bytes, 0);
    }

    #[test]
    fn t_mapping() {
        let a = load(SAMPLE);
        let s = &a.store;
        assert_eq!(s.seq_for_t(99), 0);
        assert_eq!(s.seq_for_t(100), 1);
        assert_eq!(s.seq_for_t(200), 3); // ties: both events at t=200 applied
        assert_eq!(s.seq_for_t(1000), 5);
    }

    #[test]
    fn warnings_flagged() {
        let bad = r#"{"op":"M","id":1,"addr":"0x1000","size":64,"t":100}
{"op":"F","id":9,"t":150}
{"op":"F","id":1,"t":200}
{"op":"F","id":1,"t":90}
not json at all
{"op":"M","id":2,"addr":"0x1010","size":0,"t":300}
{"op":"M","id":3,"addr":"0x1010","size":32,"t":300}
"#;
        let a = load(bad);
        let s = &a.store;
        assert_eq!(s.warn_counts[W_UNKNOWN_ID as usize], 1);
        assert_eq!(s.warn_counts[W_DOUBLE_FREE as usize], 1);
        assert_eq!(s.warn_counts[W_T_DECREASE as usize], 1);
        assert_eq!(s.warn_counts[W_MALFORMED as usize], 1);
        assert_eq!(s.warn_counts[W_BAD_SIZE as usize], 1);
        assert_eq!(s.warn_counts[W_OVERLAP as usize], 1);
    }

    #[test]
    fn free_null_ignored() {
        let input = r#"{"op":"M","id":1,"addr":"0x1000","size":64,"t":100}
{"op":"F","id":0,"t":150}
"#;
        let a = load(input);
        assert_eq!(a.store.len(), 1);
    }

    #[test]
    fn snapshot_seek_matches_replay() {
        // build a synthetic ~50k event stream and compare snapshot seeks
        // against a fresh forward replay
        let mut input = String::new();
        let mut id = 1u64;
        let mut live: Vec<(u64, u64)> = Vec::new(); // (id, addr)
        let mut t = 0u64;
        for i in 0..50000u64 {
            t += 3;
            if i % 3 == 2 && !live.is_empty() {
                let (fid, _) = live.remove((i as usize * 7) % live.len());
                input.push_str(&format!("{{\"op\":\"F\",\"id\":{},\"t\":{}}}\n", fid, t));
            } else {
                let addr = 0x10000 + (i % 1000) * 0x100;
                input.push_str(&format!(
                    "{{\"op\":\"M\",\"id\":{},\"addr\":\"0x{:x}\",\"size\":{},\"t\":{}}}\n",
                    id,
                    addr,
                    16 + i % 64,
                    t
                ));
                live.push((id, addr));
                id += 1;
            }
        }
        let mut a = load(&input);
        assert!(!a.store.snaps.is_empty());
        for &target in &[49999u32, 20000, 33333, 5, 0, 47000] {
            a.view.seek(&a.store, target);
            let mut fresh = View::new();
            fresh.reset(&a.store);
            let mut f2 = View::new();
            f2.reset(&a.store);
            f2.seek(&a.store, target); // fresh always: forward incremental from 0
            // compare against a pure forward replay by stepping
            for e in 0..target {
                let _ = e;
            }
            assert_eq!(a.view.cur, target);
            assert_eq!(a.view.live_count, f2.live_count, "target {}", target);
            assert_eq!(a.view.live_bytes, f2.live_bytes, "target {}", target);
            assert_eq!(
                a.view.live.iter().collect::<Vec<_>>(),
                f2.live.iter().collect::<Vec<_>>(),
                "target {}",
                target
            );
        }
    }

    #[test]
    fn collapse_min_keeps_short_runs() {
        // occupied rows 0, 3, 10 (base 0x1000, 4 KiB rows)
        let input = r#"{"op":"M","id":1,"addr":"0x1000","size":64,"t":10}
{"op":"M","id":2,"addr":"0x4000","size":64,"t":20}
{"op":"M","id":3,"addr":"0xb000","size":64,"t":30}
"#;
        let mut a = load(input);
        a.view.seek(&a.store, 3);
        a.view.set_collapse_min(5);
        a.view.ensure_rows();
        // run of 2 (rows 1,2) stays as filler rows; run of 6 (rows 4..=9) collapses
        assert_eq!(a.view.rows, vec![0, 1, 2, 3, 10]);
        assert_eq!(a.view.gaps_before, vec![0, 0, 0, 0, 1]);
        // collapse everything (threshold 1): only occupied rows remain
        a.view.set_collapse_min(1);
        a.view.ensure_rows();
        assert_eq!(a.view.rows, vec![0, 3, 10]);
        assert_eq!(a.view.gaps_before, vec![0, 1, 2]);
        // byte-based threshold: 0x5000 over 0x1000 rows = 5 rows
        a.view.set_collapse_min_bytes(0x5000);
        assert_eq!(a.view.effective_collapse_min(), 5);
        a.view.ensure_rows();
        assert_eq!(a.view.rows, vec![0, 1, 2, 3, 10]);
        // and it tracks row_bytes: at 0x800 rows the same bytes = 10 rows
        a.view.set_row_bytes(&a.store, 0x800);
        assert_eq!(a.view.effective_collapse_min(), 10);
    }

    #[test]
    fn scroll_anchor_stable_across_seek() {
        // three occupied rows; freeing the lowest collapses the row above
        // the anchor, which must not move the anchored address
        let input = r#"{"op":"M","id":1,"addr":"0x1000","size":64,"t":10}
{"op":"M","id":2,"addr":"0x9000","size":64,"t":20}
{"op":"M","id":3,"addr":"0x20000","size":64,"t":30}
{"op":"F","id":1,"t":40}
"#;
        let mut a = load(input);
        let (row_px, gap_px) = (a.cfg.row_px, a.cfg.gap_px);
        a.view.seek(&a.store, 3);
        // top of viewport at the 0x9000 row (display index 1, one gap before)
        let y_before = (row_px + gap_px) as f64;
        let (addr, off) = a.view.anchor_at(y_before, row_px, gap_px).unwrap();
        assert_eq!(addr, 0x9000);
        assert_eq!(off, 0);
        // seek past the free of 0x1000: its row collapses away
        a.view.seek(&a.store, 4);
        let y_after = a.view.scroll_for_addr(addr, off, row_px, gap_px);
        assert_eq!(y_after, 0.0); // 0x9000 is now the first row
        // and the anchor row still resolves to the same address
        let (addr2, _) = a.view.anchor_at(y_after, row_px, gap_px).unwrap();
        assert_eq!(addr2, 0x9000);
    }

    #[test]
    fn tagging() {
        let mut a = load(SAMPLE);
        // events: 0 M, 1 M, 2 F, 3 R, 4 F — creators are 0, 1, 3
        let n = {
            let s = &mut a.store;
            let mut n = 0;
            for e in 0..s.len() {
                let op = s.op[e as usize];
                if (op == OP_M || op == OP_R) && e < 4 {
                    s.tag[e as usize] = 2;
                    n += 1;
                }
            }
            n
        };
        assert_eq!(n, 3);
        assert_eq!(a.store.tag, vec![2, 2, 0, 2, 0]);
        // tag color mode renders tagged colors
        a.view.seek(&a.store, 4);
        a.cfg.color_mode = render::MODE_TAG;
        let _ = render::render_addr(&a.store, &mut a.view, &a.cfg, &mut a.frame, 200, 100, 0.0);
        let cat = render::CAT[1]; // tag 2 -> palette index 1
        let has_tag_color = a
            .frame
            .px
            .chunks(4)
            .any(|c| c[0] == cat[0] && c[1] == cat[1] && c[2] == cat[2]);
        assert!(has_tag_color);
    }

    #[test]
    fn tag_range_respects_filter() {
        // sites: a (events 0), b (event 1); realloc keeps site b (event 3)
        let mut a = load(SAMPLE);
        // filter: only site "b" (index 1), hide mode
        a.cfg.filter.mode = render::FILTER_HIDE;
        a.cfg.filter.sites = vec![1u64 << 1];
        let to_tag: Vec<u32> = {
            let s = &a.store;
            let f = &a.cfg.filter;
            (0..s.len())
                .filter(|&e| {
                    let op = s.op[e as usize];
                    (op == OP_M || op == OP_R) && f.pass(s, e)
                })
                .collect()
        };
        for &e in &to_tag {
            a.store.tag[e as usize] = 1;
        }
        // creators: 0 (site a → filtered out), 1 (site b → tagged),
        // 3 (realloc without a site field → unconstrained, passes)
        assert_eq!(to_tag, vec![1, 3]);
        assert_eq!(a.store.tag, vec![0, 1, 0, 1, 0]);
    }

    #[test]
    fn tag_freed_range() {
        let mut a = load(SAMPLE);
        // events: 0 M(id1), 1 M(id2), 2 F(id1), 3 R(id3 kills id2), 4 F(id3)
        // frees in [2, 4): F#2 kills creator 0, R#3 kills creator 1
        let n = tag_seq_range(&mut a, 2, 4, 1, 1);
        assert_eq!(n, 2);
        assert_eq!(a.store.tag, vec![1, 1, 0, 0, 0]);
        // freed in [4, 5): F#4 kills the realloc creator (event 3)
        let n = tag_seq_range(&mut a, 4, 5, 2, 1);
        assert_eq!(n, 1);
        assert_eq!(a.store.tag, vec![1, 1, 0, 2, 0]);
        // by_free = 0 keeps the old "creators in range" behavior
        let n = tag_seq_range(&mut a, 0, 5, 3, 0);
        assert_eq!(n, 3);
        assert_eq!(a.store.tag, vec![3, 3, 0, 3, 0]);
    }

    #[test]
    fn pinned_rows_stay_laid_out() {
        let mut a = load(SAMPLE);
        // at the end of the trace everything is freed: no rows at all
        a.view.seek(&a.store, 5);
        a.view.ensure_rows();
        assert!(a.view.rows.is_empty());
        // pin an address: its row is laid out even though nothing is live
        a.view.set_pins(vec![0x3000]);
        a.view.ensure_rows();
        assert_eq!(a.view.rows, vec![2]); // (0x3000 - base 0x1000) / 0x1000
        let y = a.view.scroll_for_addr(0x3000, 0, 12, 7);
        assert_eq!(y, 0.0);
        // live rows merge with (and dedup against) pins
        a.view.seek(&a.store, 2); // 0x1000 and 0x2000 live
        a.view.set_pins(vec![0x2000, 0x3000]);
        a.view.ensure_rows();
        assert_eq!(a.view.rows, vec![0, 1, 2]);
    }

    #[test]
    fn show_all_rows_stable() {
        let mut a = load(SAMPLE);
        // at the end everything is freed: normally no rows at all
        a.view.seek(&a.store, 5);
        a.view.ensure_rows();
        assert!(a.view.rows.is_empty());
        // show_all lays out every row ever touched: 0x1000, 0x2000, 0x3000
        a.view.set_show_all(&a.store, true);
        a.view.ensure_rows();
        assert_eq!(a.view.rows, vec![0, 1, 2]);
        // and the layout is identical at any playhead position
        a.view.seek(&a.store, 1);
        a.view.ensure_rows();
        assert_eq!(a.view.rows, vec![0, 1, 2]);
        // switching back returns to the live-set layout
        a.view.set_show_all(&a.store, false);
        a.view.ensure_rows();
        assert_eq!(a.view.rows, vec![0]);
    }

    #[test]
    fn anchor_pin_survives_free() {
        let mut a = load(SAMPLE);
        a.view.seek(&a.store, 2);
        // anchor at the 0x2000 row, then free everything
        a.view.set_anchor_pin(Some(0x2000));
        a.view.seek(&a.store, 5);
        a.view.ensure_rows();
        assert_eq!(a.view.rows, vec![1]); // pinned row survives
        let y = a.view.scroll_for_addr(0x2000, 0, 12, 7);
        assert_eq!(y, 0.0);
    }

    #[test]
    fn x_zoom_pick() {
        let mut a = load(SAMPLE);
        a.view.seek(&a.store, 2);
        // zoom 16x, pan 0: row 0 (0x1000..0x2000) shows only 0x1000..0x1100
        a.cfg.x_zoom = 16.0;
        a.cfg.x_pan = 0.0;
        // the 64-byte alloc at 0x1000 now spans the first quarter of the width
        let p = render::pick(&a.store, &mut a.view, &a.cfg, 400, 50, 0.0, 0.0);
        assert!(p.contains("\"id\":1"), "pick got {}", p);
        // past the alloc (byte offset 128) there is nothing
        let p = render::pick(&a.store, &mut a.view, &a.cfg, 400, 200, 0.0, 0.0);
        assert_eq!(p, "null");
        // pan past the alloc entirely: nothing under x=0 anymore
        a.cfg.x_pan = 0.5;
        let p = render::pick(&a.store, &mut a.view, &a.cfg, 400, 0, 0.0, 0.0);
        assert_eq!(p, "null");
    }

    #[test]
    fn size_label_on_middle_row() {
        // a 3-row allocation (0x1000..0x4000 over 0x1000-byte rows): the
        // label goes on the middle row, not the first
        let input = r#"{"op":"M","id":1,"addr":"0x1000","size":12288,"t":10}"#;
        let mut a = load(input);
        a.view.seek(&a.store, 1);
        let out = render::render_addr(&a.store, &mut a.view, &a.cfg, &mut a.frame, 400, 300, 0.0);
        // rows are contiguous: row_y(1) = row_px = 12
        assert!(out.labels.contains("\"k\":2,\"x\":0,\"y\":12"), "labels: {}", out.labels);
        // a 4-row allocation rounds to the top middle: row index 1 again
        let input = r#"{"op":"M","id":1,"addr":"0x1000","size":16384,"t":10}"#;
        let mut a = load(input);
        a.view.seek(&a.store, 1);
        let out = render::render_addr(&a.store, &mut a.view, &a.cfg, &mut a.frame, 400, 300, 0.0);
        assert!(out.labels.contains("\"k\":2,\"x\":0,\"y\":12"), "labels: {}", out.labels);
    }

    #[test]
    fn move_link_highlights_malloc() {
        let mut a = load(SAMPLE);
        a.view.seek(&a.store, 1); // just applied M id=1
        let ml = render::move_link(&a.store, &mut a.view, &a.cfg, 400, 0.0);
        assert!(ml.contains("\"op\":0"), "got {}", ml);
        assert!(ml.contains("\"new\":[{"), "got {}", ml);
    }

    #[test]
    fn render_smoke() {
        let mut a = load(SAMPLE);
        a.view.seek(&a.store, 2);
        let out = render::render_addr(
            &a.store,
            &mut a.view,
            &a.cfg,
            &mut a.frame,
            400,
            300,
            0.0,
        );
        assert!(out.labels.starts_with('['));
        assert_eq!(a.frame.px.len(), 400 * 300 * 4);
        // some green pixels present
        let has_fill = a
            .frame
            .px
            .chunks(4)
            .any(|c| c[1] > 0x80 && c[0] < 0x80);
        assert!(has_fill);
        // pick at the first allocation: row for 0x1000, x=0
        let p = render::pick(&a.store, &mut a.view, &a.cfg, 400, 0, 0.0, 0.0);
        assert!(p.contains("\"id\":1"), "pick got {}", p);
        // timeline render smoke
        let mut px = Vec::new();
        timeline::render(&a.store, &a.cfg, 1, 100, 40, 0.0, 5.0, &mut px);
        assert_eq!(px.len(), 100 * 40 * 4);
    }
}
