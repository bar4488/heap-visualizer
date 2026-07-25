import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
    toggleFilterPredicate('site == "a" && thread == 4', 'tag == "hot"', '||'),
    'site == "a" && thread == 4 || tag == "hot"',
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
});

test('removes the connector beside the first or middle operand', () => {
  assert.equal(
    toggleFilterPredicate('site == "a" || thread == 2 || tag is missing', 'site == "a"'),
    'thread == 2 || tag is missing',
  );
  assert.equal(
    toggleFilterPredicate('site == "a" && thread == 2 && tag is missing', 'thread == 2'),
    'site == "a" && tag is missing',
  );
});

test('does not treat a predicate inside a tighter-precedence branch as a root operand', () => {
  const source = 'site == "a" || thread == 2 && tag is missing';
  assert.equal(hasTopLevelPredicate(source, 'thread == 2'), false);
  assert.equal(
    toggleFilterPredicate(source, 'thread == 2'),
    '(site == "a" || thread == 2 && tag is missing) && thread == 2',
  );
});

test('quotes filter strings with the DSL JSON-subset escapes', () => {
  assert.equal(quoteFilterString('say "hi" \\ now'), '"say \\"hi\\" \\\\ now"');
});
