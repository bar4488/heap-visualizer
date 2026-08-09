import assert from 'node:assert/strict';
import test from 'node:test';

import {
  customFieldPredicate,
  customFieldRef,
  hasTopLevelPredicate,
  quoteFilterString,
  toggleFilterPredicate,
} from '../filter-actions.ts';

test('adds and removes a top-level conjunct', () => {
  assert.equal(toggleFilterPredicate('', 'malloc.thread == 4'), 'malloc.thread == 4');
  assert.equal(
    toggleFilterPredicate('malloc.site == "parse"', 'malloc.thread == 4'),
    'malloc.site == "parse" and malloc.thread == 4',
  );
  assert.equal(
    toggleFilterPredicate('malloc.site == "parse" and malloc.thread == 4', 'malloc.thread == 4'),
    'malloc.site == "parse"',
  );
});

test('parenthesizes a top-level disjunction before adding a conjunct', () => {
  assert.equal(
    toggleFilterPredicate('malloc.site == "a" or malloc.site == "b"', 'malloc.thread == 4'),
    '(malloc.site == "a" or malloc.site == "b") and malloc.thread == 4',
  );
  assert.equal(
    toggleFilterPredicate('malloc.site == "a" and malloc.thread == 4', '"hot" in alloc.tags', 'or'),
    'malloc.site == "a" and malloc.thread == 4 or "hot" in alloc.tags',
  );
});

test('operators inside strings and nesting are not top-level splits', () => {
  const source = 'malloc.site == "a and b" and (malloc.thread == 1 or malloc.thread == 2)';
  assert.equal(hasTopLevelPredicate(source, 'malloc.site == "a and b"'), true);
  assert.equal(hasTopLevelPredicate(source, 'malloc.thread == 1'), false);
  assert.equal(
    toggleFilterPredicate(source, 'malloc.site == "a and b"'),
    '(malloc.thread == 1 or malloc.thread == 2)',
  );

  const withSet = 'alloc.tags == {"a", "b"} and malloc.thread == 1';
  assert.equal(hasTopLevelPredicate(withSet, 'alloc.tags == {"a", "b"}'), true);
  assert.equal(
    toggleFilterPredicate(withSet, 'malloc.thread == 1'),
    'alloc.tags == {"a", "b"}',
  );
});

/**
 * The operators are words now, so splitting has to respect word boundaries —
 * a symbol operator could never hide inside an identifier or a field key.
 */
test('an operator spelling inside a name is not an operator', () => {
  const source = 'malloc.fields.android == 1';
  assert.equal(hasTopLevelPredicate(source, source), true);
  assert.equal(
    toggleFilterPredicate(source, 'malloc.fields.origin == 2'),
    'malloc.fields.android == 1 and malloc.fields.origin == 2',
  );

  // and the same for a key that only ends with one
  const ending = 'malloc.fields["brand"] == "x"';
  assert.equal(hasTopLevelPredicate(ending, ending), true);
});

test('removes the connector beside the first or middle operand', () => {
  assert.equal(
    toggleFilterPredicate(
      'malloc.site == "a" or malloc.thread == 2 or alloc.tags == {}',
      'malloc.site == "a"',
    ),
    'malloc.thread == 2 or alloc.tags == {}',
  );
  assert.equal(
    toggleFilterPredicate(
      'malloc.site == "a" and malloc.thread == 2 and alloc.tags == {}',
      'malloc.thread == 2',
    ),
    'malloc.site == "a" and alloc.tags == {}',
  );
});

test('does not treat a predicate inside a tighter-precedence branch as a root operand', () => {
  const source = 'malloc.site == "a" or malloc.thread == 2 and alloc.tags == {}';
  assert.equal(hasTopLevelPredicate(source, 'malloc.thread == 2'), false);
  assert.equal(
    toggleFilterPredicate(source, 'malloc.thread == 2'),
    '(malloc.site == "a" or malloc.thread == 2 and alloc.tags == {}) and malloc.thread == 2',
  );
});

test('quotes filter strings with the DSL JSON-subset escapes', () => {
  assert.equal(quoteFilterString('say "hi" \\ now'), '"say \\"hi\\" \\\\ now"');
});

test('a custom field is spelled with a dot only when the key allows it', () => {
  assert.equal(customFieldRef('pool'), 'malloc.fields.pool');
  assert.equal(customFieldRef('_ref2'), 'malloc.fields._ref2');
  // a key that is not identifier-shaped needs the bracket form
  assert.equal(customFieldRef('allocator-class'), 'malloc.fields["allocator-class"]');
  assert.equal(customFieldRef('2fast'), 'malloc.fields["2fast"]');
  assert.equal(customFieldRef(''), 'malloc.fields[""]');
  // and the key itself is escaped as a DSL literal
  assert.equal(customFieldRef('a"b\\c'), 'malloc.fields["a\\"b\\\\c"]');
  // the freeing record's fields hang off the object for that record
  assert.equal(customFieldRef('reason', true), 'free.fields.reason');
});

test('a custom field value becomes a predicate matching it', () => {
  assert.equal(customFieldPredicate('pool', 'gfx'), 'malloc.fields.pool == "gfx"');
  assert.equal(customFieldPredicate('refcount', 3), 'malloc.fields.refcount == 3');
  assert.equal(
    customFieldPredicate('allocator-class', 'slab'),
    'malloc.fields["allocator-class"] == "slab"',
  );
  // a bool field is its own predicate, and its negation is the operator
  assert.equal(customFieldPredicate('live', true), 'malloc.fields.live');
  assert.equal(customFieldPredicate('live', false), 'not malloc.fields.live');
  // string values are escaped, not interpolated
  assert.equal(
    customFieldPredicate('note', 'say "hi"\\'),
    'malloc.fields.note == "say \\"hi\\"\\\\"',
  );
});

test('a custom field with no addressable value offers no predicate', () => {
  // null is missingness, and objects and arrays are not filterable at all
  assert.equal(customFieldPredicate('maybe', null), null);
  assert.equal(customFieldPredicate('nested', { a: 1 }), null);
  assert.equal(customFieldPredicate('list', [1, 2]), null);
});

test('a fractional value gets the float literal that matches it (ANL-012)', () => {
  assert.equal(customFieldPredicate('ratio', 1.5), 'malloc.fields.ratio == 1.5');
  assert.equal(
    customFieldPredicate('fill-ratio', 0.986),
    'malloc.fields["fill-ratio"] == 0.986',
  );
  // a small value prints in exponent form, which the language reads as a float
  assert.equal(customFieldPredicate('drift', 1e-7), 'malloc.fields.drift == 1e-7');
});

test('a custom field predicate toggles like any other conjunct', () => {
  const predicate = customFieldPredicate('pool', 'gfx');
  assert.equal(
    toggleFilterPredicate('alloc.size > 10', predicate),
    'alloc.size > 10 and malloc.fields.pool == "gfx"',
  );
  assert.ok(
    hasTopLevelPredicate('alloc.size > 10 and malloc.fields.pool == "gfx"', predicate),
  );
});
