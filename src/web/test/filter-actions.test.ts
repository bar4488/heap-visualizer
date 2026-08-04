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
  assert.equal(toggleFilterPredicate('', 'thread == 4'), 'thread == 4');
  assert.equal(
    toggleFilterPredicate('site == "parse"', 'thread == 4'),
    'site == "parse" && thread == 4',
  );
  assert.equal(
    toggleFilterPredicate('site == "parse" && thread == 4', 'thread == 4'),
    'site == "parse"',
  );
});

test('parenthesizes a top-level disjunction before adding a conjunct', () => {
  assert.equal(
    toggleFilterPredicate('site == "a" || site == "b"', 'thread == 4'),
    '(site == "a" || site == "b") && thread == 4',
  );
  assert.equal(
    toggleFilterPredicate('site == "a" && thread == 4', 'tags contains "hot"', '||'),
    'site == "a" && thread == 4 || tags contains "hot"',
  );
});

test('operators inside strings and nesting are not top-level splits', () => {
  const source = 'site == "a && b" && (thread == 1 || thread == 2)';
  assert.equal(hasTopLevelPredicate(source, 'site == "a && b"'), true);
  assert.equal(hasTopLevelPredicate(source, 'thread == 1'), false);
  assert.equal(
    toggleFilterPredicate(source, 'site == "a && b"'),
    '(thread == 1 || thread == 2)',
  );

  const withSet = 'tags == {"a", "b"} && thread == 1';
  assert.equal(hasTopLevelPredicate(withSet, 'tags == {"a", "b"}'), true);
  assert.equal(toggleFilterPredicate(withSet, 'thread == 1'), 'tags == {"a", "b"}');
});

test('removes the connector beside the first or middle operand', () => {
  assert.equal(
    toggleFilterPredicate('site == "a" || thread == 2 || tags == {}', 'site == "a"'),
    'thread == 2 || tags == {}',
  );
  assert.equal(
    toggleFilterPredicate('site == "a" && thread == 2 && tags == {}', 'thread == 2'),
    'site == "a" && tags == {}',
  );
});

test('does not treat a predicate inside a tighter-precedence branch as a root operand', () => {
  const source = 'site == "a" || thread == 2 && tags == {}';
  assert.equal(hasTopLevelPredicate(source, 'thread == 2'), false);
  assert.equal(
    toggleFilterPredicate(source, 'thread == 2'),
    '(site == "a" || thread == 2 && tags == {}) && thread == 2',
  );
});

test('quotes filter strings with the DSL JSON-subset escapes', () => {
  assert.equal(quoteFilterString('say "hi" \\ now'), '"say \\"hi\\" \\\\ now"');
});

test('a custom field is spelled with a dot only when the key allows it', () => {
  assert.equal(customFieldRef('pool'), 'field.pool');
  assert.equal(customFieldRef('_ref2'), 'field._ref2');
  // a key that is not identifier-shaped needs the bracket form
  assert.equal(customFieldRef('allocator-class'), 'field["allocator-class"]');
  assert.equal(customFieldRef('2fast'), 'field["2fast"]');
  assert.equal(customFieldRef(''), 'field[""]');
  // and the key itself is escaped as a DSL literal
  assert.equal(customFieldRef('a"b\\c'), 'field["a\\"b\\\\c"]');
});

test('a custom field value becomes a predicate matching it', () => {
  assert.equal(customFieldPredicate('pool', 'gfx'), 'field.pool == "gfx"');
  assert.equal(customFieldPredicate('refcount', 3), 'field.refcount == 3');
  assert.equal(
    customFieldPredicate('allocator-class', 'slab'),
    'field["allocator-class"] == "slab"',
  );
  // a bool field is its own predicate, and its negation is the operator
  assert.equal(customFieldPredicate('live', true), 'field.live');
  assert.equal(customFieldPredicate('live', false), '!field.live');
  // string values are escaped, not interpolated
  assert.equal(
    customFieldPredicate('note', 'say "hi"\\'),
    'field.note == "say \\"hi\\"\\\\"',
  );
});

test('a custom field with no addressable value offers no predicate', () => {
  // null is missingness, and objects and arrays are not filterable at all
  assert.equal(customFieldPredicate('maybe', null), null);
  assert.equal(customFieldPredicate('nested', { a: 1 }), null);
  assert.equal(customFieldPredicate('list', [1, 2]), null);
});

test('a fractional value gets the float literal that matches it (ANL-012)', () => {
  assert.equal(customFieldPredicate('ratio', 1.5), 'field.ratio == 1.5');
  assert.equal(customFieldPredicate('fill-ratio', 0.986), 'field["fill-ratio"] == 0.986');
  // a small value prints in exponent form, which the language reads as a float
  assert.equal(customFieldPredicate('drift', 1e-7), 'field.drift == 1e-7');
  assert.equal(customFieldPredicate('drift', -2.5), 'field.drift == -2.5');
});

test('a custom field predicate toggles like any other conjunct', () => {
  const predicate = customFieldPredicate('pool', 'gfx');
  assert.equal(toggleFilterPredicate('size > 10', predicate), 'size > 10 && field.pool == "gfx"');
  assert.ok(hasTopLevelPredicate('size > 10 && field.pool == "gfx"', predicate));
});
