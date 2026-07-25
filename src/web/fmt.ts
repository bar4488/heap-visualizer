// Shared helpers for BOTH JS layers: main.ts (panels, tooltips, chrome) and
// worker.ts (in-allocation labels, view clamping). One definition replaces
// the old mirrored copies and their change-both-together comments.
//
// clampView in particular must stay bit-identical between the two sides:
// the main thread's optimistic local zoom has to agree with the worker's
// authoritative clamp.

export function fmtBytes(b) {
  if (b < 1024) return `${Math.round(b)} B`;
  const u = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return `${b >= 100 ? b.toFixed(0) : b.toFixed(1)} ${u[i]}`;
}

export function fmtHexSize(b) {
  return `0x${Math.max(0, Math.round(Number(b) || 0)).toString(16)}`;
}

// `mode` is 'hex' | 'human', passed in because the two sides source it
// differently (main.ts reads the DOM select, the worker its settings state).
export function fmtAllocSize(b, mode) {
  return mode === 'hex' ? fmtHexSize(b) : fmtBytes(b);
}

export function fmtNum(x) {
  return Number(x).toLocaleString('en-US');
}

// Returns 0 for an empty input ("no value"), null for one that does not
// parse — callers show the failure (red border) instead of silently treating
// a typo as "unbounded". Exponent notation (1e6) is accepted, matching the
// jump box.
export function parseSize(s) {
  s = (s || '').trim().toLowerCase();
  if (!s) return 0;
  const m = s.match(/^(0x[\da-f]+|[\d.]+(?:e[+-]?\d+)?)\s*([kmgt]?)i?b?$/);
  if (!m) return null;
  const mult = { '': 1, k: 1024, m: 1 << 20, g: 1 << 30, t: 2 ** 40 }[m[2]];
  const value = m[1].startsWith('0x') ? parseInt(m[1], 16) : parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * mult);
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function clampView(view, min, max, minSpan) {
  let { lo, hi } = view;
  if (hi - lo < minSpan) hi = lo + minSpan;
  const span = hi - lo;
  if (span >= max - min) return { lo: min, hi: Math.max(max, min + minSpan) };
  if (lo < min) { lo = min; hi = min + span; }
  if (hi > max) { hi = max; lo = max - span; }
  return { lo, hi };
}
