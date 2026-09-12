import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyFilterCompletion,
  insertAllocationReference,
  utf16Offset,
  utf8Offset,
} from '../filter-completion.ts';

test('allocation panel references replace the current editor selection', () => {
  assert.deepEqual(insertAllocationReference('before TARGET after', 7, 13, '100'), {
    source: 'before allocation(100). after',
    cursor: 23,
  });
});

test('allocation references preserve ids beyond JavaScript integer precision', () => {
  assert.equal(
    insertAllocationReference('', 0, 0, '9007199254740993').source,
    'allocation(9007199254740993).',
  );
});

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

test('an exact field completion advances to its operator with spacing', () => {
  const source = 'span';
  const completions = { start: 4, end: 4, items: [] };
  const item = {
    label: 'overlaps',
    insertText: ' overlaps ',
    kind: 'operator' as const,
  };

  assert.deepEqual(applyFilterCompletion(source, completions, item), {
    source: 'span overlaps ',
    cursor: 'span overlaps '.length,
  });
});
