/**
 * Syntax highlighting for the filter editor.
 *
 * The editor stays a `<textarea>` with a `<pre>` behind it holding the same
 * text in coloured spans. Selection, undo, IME and paste keep working because
 * the real input is still a textarea; the overlay only has to agree with it on
 * font metrics and scroll offset.
 *
 * The grammar has one owner: `classify` calls into the same Rust lexer the
 * parser uses, compiled to a small standalone WASM module the main thread
 * loads. This file only turns its answer into markup — which is why
 * `highlightHtml` is pure and tested without a browser or a wasm build.
 */

/**
 * Run classes, in the order `filter-dsl`'s `Class` enum declares them. The
 * numbers are the contract between the two, and `loadHighlighter` checks the
 * module agrees rather than trusting this list.
 */
export const CLASSES = [
  'plain',
  'keyword',
  'field',
  'function',
  'string',
  'number',
  'operator',
  'bracket',
  'invalid',
] as const;

export type Run = { class: number; start: number; end: number };

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * The overlay markup for `source`, given the runs the lexer produced.
 *
 * **Run offsets are UTF-8 byte offsets** — the lexer's — while JavaScript
 * strings are UTF-16, so the source is sliced as bytes and decoded back. Byte
 * offsets used as string indices would shift every span after the first
 * non-ASCII character, and a site name with an accent in it is ordinary.
 *
 * Text no run covers is emitted plain rather than dropped: the overlay has to
 * reproduce the source exactly or the colours drift out of line with the
 * textarea above them. A trailing newline gets one more space so the last line
 * keeps its height.
 */
export function highlightHtml(source: string, runs: Run[]): string {
  const bytes = encoder.encode(source);
  const slice = (from: number, to: number) => esc(decoder.decode(bytes.slice(from, to)));
  let html = '';
  let at = 0;
  for (const run of runs) {
    if (run.start > at) html += slice(at, run.start);
    const name = CLASSES[run.class] ?? 'plain';
    const text = slice(run.start, run.end);
    html += name === 'plain' ? text : `<span class="hl-${name}">${text}</span>`;
    at = Math.max(at, run.end);
  }
  if (at < bytes.length) html += slice(at, bytes.length);
  return html + (source.endsWith('\n') ? ' ' : '');
}

type Lexer = {
  memory: WebAssembly.Memory;
  hl_source: () => number;
  hl_run: (len: number) => number;
  hl_runs: () => number;
  hl_class_count: () => number;
};

let lexer: Lexer | null = null;

/**
 * Load the highlighting module. Failure is not fatal: `classify` then returns
 * nothing and the editor shows plain text, because highlighting is
 * presentation and must never gate checking or Apply.
 */
export async function loadHighlighter(url = 'filter_lexer.wasm'): Promise<boolean> {
  try {
    const { instance } = await WebAssembly.instantiateStreaming(fetch(url), {});
    const exports = instance.exports as unknown as Lexer;
    if (exports.hl_class_count() !== CLASSES.length) {
      // the module and this file disagree about the class numbering, so the
      // colours would be wrong rather than absent — refuse instead
      console.warn('filter highlighter: class list is out of date');
      return false;
    }
    lexer = exports;
    return true;
  } catch (error) {
    console.warn('filter highlighter unavailable', error);
    return false;
  }
}

/** The runs for `source`, or none when the module is not loaded. */
export function classify(source: string): Run[] {
  if (!lexer) return [];
  const bytes = encoder.encode(source);
  const into = lexer.hl_source();
  const buffer = new Uint8Array(lexer.memory.buffer);
  // the module's buffer is MAX_SOURCE_BYTES; a longer draft is not lexed,
  // which is the same source the parser rejects outright
  if (into + bytes.length > buffer.length) return [];
  buffer.set(bytes, into);
  const count = lexer.hl_run(bytes.length);
  // the view is taken after the call: `hl_run` can grow the module's memory,
  // which detaches any buffer captured before it
  const words = new Uint32Array(lexer.memory.buffer, lexer.hl_runs(), count * 3);
  const runs: Run[] = [];
  for (let i = 0; i < count; i++) {
    runs.push({ class: words[i * 3], start: words[i * 3 + 1], end: words[i * 3 + 2] });
  }
  return runs;
}

/** Paint `source` into the overlay behind the textarea. */
export function paintHighlight(overlay: HTMLElement, source: string): void {
  overlay.innerHTML = highlightHtml(source, classify(source));
}
