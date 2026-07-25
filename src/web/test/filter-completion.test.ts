import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyFilterCompletion,
  utf16Offset,
  utf8Offset,
} from '../filter-completion.ts';

test('filter completion offsets cross the UTF-8 and UTF-16 boundary', () => {
  const source = 'site == "hé😀"';
  for (const utf16 of [0, 9, 10, 11, 13, source.length]) {
    assert.equal(utf16Offset(source, utf8Offset(source, utf16)), utf16);
  }

  // A core span should always be on a character boundary. If a malformed
  // reply is not, stay before that character rather than splitting UTF-16.
  assert.equal(utf16Offset('é', 1), 0);
});

test('filter completion replaces one byte-spanned token', () => {
  const source = 'site == "hé" && size > 1';
  const quote = source.indexOf('"');
  const start = utf8Offset(source, quote);
  const end = utf8Offset(source, source.indexOf('"', quote + 1) + 1);
  const completions = { start, end, items: [] };
  const item = {
    label: 'parser "fast"',
    insertText: '"parser \\"fast\\""',
    kind: 'value' as const,
  };

  assert.deepEqual(applyFilterCompletion(source, completions, item), {
    source: 'site == "parser \\"fast\\"" && size > 1',
    cursor: 'site == "parser \\"fast\\""'.length,
  });
});
