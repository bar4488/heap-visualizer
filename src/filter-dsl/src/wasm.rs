//! The C ABI the browser's main thread calls for syntax highlighting.
//!
//! This is a **second, tiny WASM module**, separate from the engine in the
//! worker. Highlighting has to answer on every keystroke, synchronously, and
//! the engine lives on the other side of a message port — so the choice was
//! this, a debounced round trip that leaves fresh text unstyled, or a
//! hand-written tokenizer in TypeScript that would give the grammar two owners
//! ([E019] §Syntax highlighting). This crate is dependency-free, so the module
//! it produces is small.
//!
//! The shape mirrors the core's: source goes into a fixed input buffer, and
//! results come back as a flat `u32` array the caller reads through a typed
//! view. Nothing is allocated per call after the first.
//!
//! [E019]: ../../../docs/explorations/E019-a-python-shaped-filter-language.md

use crate::{highlight, Class, MAX_SOURCE_BYTES};

/// Source in, one byte per byte. The editor refuses longer sources anyway —
/// `parse` rejects past this length — so a fixed buffer is enough.
static mut SOURCE: [u8; MAX_SOURCE_BYTES] = [0; MAX_SOURCE_BYTES];

/// Runs out, as `[class, start, end]` triples. One token per byte is the worst
/// case, and each token is one triple.
static mut RUNS: Vec<u32> = Vec::new();

/// Where to write the source before calling `hl_run`.
#[no_mangle]
pub extern "C" fn hl_source() -> *mut u8 {
    &raw mut SOURCE as *mut u8
}

/// Classify `len` bytes of the input buffer. Returns the number of runs.
///
/// Invalid UTF-8 classifies as nothing rather than trapping: the editor's text
/// is always valid, and a panic here would take down the page.
#[no_mangle]
pub extern "C" fn hl_run(len: u32) -> u32 {
    let len = (len as usize).min(MAX_SOURCE_BYTES);
    // SAFETY: wasm32-unknown-unknown is single-threaded, and these statics are
    // touched only by the exports in this file, one call at a time.
    let runs = unsafe { &mut *&raw mut RUNS };
    runs.clear();
    let bytes = unsafe { core::slice::from_raw_parts(&raw const SOURCE as *const u8, len) };
    let source = core::str::from_utf8(bytes);
    let Ok(source) = source else {
        return 0;
    };
    for run in highlight(source) {
        runs.push(run.class as u32);
        runs.push(run.span.start as u32);
        runs.push(run.span.end as u32);
    }
    (runs.len() / 3) as u32
}

/// Where the runs `hl_run` produced start. Valid until the next `hl_run`.
#[no_mangle]
pub extern "C" fn hl_runs() -> *const u32 {
    // SAFETY: as above; the pointer is read before any further call.
    unsafe { (*&raw const RUNS).as_ptr() }
}

/// The class values, so the caller can assert it agrees with this enum rather
/// than hard-coding numbers that could drift.
#[no_mangle]
pub extern "C" fn hl_class_count() -> u32 {
    Class::Invalid as u32 + 1
}
