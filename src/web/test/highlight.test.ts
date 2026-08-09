import assert from 'node:assert/strict';
import test from 'node:test';

import { CLASSES, highlightHtml, type Run } from '../highlight.ts';

const KEYWORD = CLASSES.indexOf('keyword');
const FIELD = CLASSES.indexOf('field');
const STRING = CLASSES.indexOf('string');
const OPERATOR = CLASSES.indexOf('operator');
const INVALID = CLASSES.indexOf('invalid');
const PLAIN = CLASSES.indexOf('plain');

const run = (cls: number, start: number, end: number): Run => ({ class: cls, start, end });

test('each run becomes a span carrying its class', () => {
  const source = 'alloc.freed and x';
  const html = highlightHtml(source, [
    run(FIELD, 0, 5),
    run(OPERATOR, 5, 6),
    run(FIELD, 6, 11),
    run(PLAIN, 11, 12),
    run(KEYWORD, 12, 15),
  ]);
  assert.ok(html.includes('<span class="hl-field">alloc</span>'));
  assert.ok(html.includes('<span class="hl-operator">.</span>'));
  assert.ok(html.includes('<span class="hl-keyword">and</span>'));
  // a plain run carries no span of its own, and the tail no run covered at
  // all is still there
  assert.ok(html.includes('freed</span> <span'));
  assert.ok(html.endsWith(' x'));
});

/**
 * The overlay sits behind the textarea, so it has to reproduce the source
 * exactly. Dropping any part of it slides the colours off the text.
 */
test('every character survives, covered by a run or not', () => {
  const source = 'a  b';
  assert.equal(highlightHtml(source, [run(FIELD, 0, 1), run(FIELD, 3, 4)]),
    '<span class="hl-field">a</span>  <span class="hl-field">b</span>');
  assert.equal(highlightHtml(source, []), source);
  assert.equal(highlightHtml('', []), '');
});

test('markup in the source is text, not markup', () => {
  const source = 'malloc.fields["a<b>"] == "x & \'y\'"';
  const html = highlightHtml(source, [run(STRING, 14, 20), run(STRING, 25, 33)]);
  assert.ok(!html.includes('<b>'), html);
  assert.ok(html.includes('&lt;b&gt;'));
  assert.ok(html.includes('&amp;'));
  // and a run boundary cannot split an entity into unescaped text
  assert.equal(highlightHtml('<', []), '&lt;');
  assert.equal(highlightHtml('&', [run(PLAIN, 0, 1)]), '&amp;');
});

/**
 * Run offsets come from the Rust lexer and are UTF-8 byte offsets, while
 * JavaScript strings are UTF-16. A site name with an accent in it is ordinary,
 * so getting this wrong would misplace every colour after the first one.
 */
test('runs are sliced by byte offset, not by string index', () => {
  const source = 'malloc.site == "héllo"';
  // "héllo" with quotes is 8 bytes from byte 15; as UTF-16 indices that string
  // would end one short
  const html = highlightHtml(source, [run(STRING, 15, 23)]);
  assert.ok(html.includes('<span class="hl-string">"héllo"</span>'), html);
  assert.ok(!html.includes('"héllo</span>'));

  const emoji = '"😀" in alloc.tags';
  const withEmoji = highlightHtml(emoji, [run(STRING, 0, 6), run(KEYWORD, 7, 9)]);
  assert.ok(withEmoji.includes('<span class="hl-string">"😀"</span>'), withEmoji);
  assert.ok(withEmoji.includes('<span class="hl-keyword">in</span>'), withEmoji);
});

test('a class the module numbers past this list renders plain', () => {
  assert.equal(highlightHtml('x', [run(99, 0, 1)]), 'x');
});

test('an invalid run is marked so a removed spelling reads as a mistake', () => {
  const html = highlightHtml('a && b', [run(INVALID, 2, 4)]);
  assert.ok(html.includes('<span class="hl-invalid">&amp;&amp;</span>'), html);
});

/**
 * A textarea keeps a trailing newline's empty last line; a `<pre>` collapses
 * it, which would shift the whole overlay up by a line while typing.
 */
test('a trailing newline keeps the last line tall', () => {
  assert.equal(highlightHtml('a\n', [run(FIELD, 0, 1)]),
    '<span class="hl-field">a</span>\n ');
  assert.ok(!highlightHtml('a', [run(FIELD, 0, 1)]).endsWith(' '));
});
