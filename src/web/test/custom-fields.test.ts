import assert from 'node:assert/strict';
import test from 'node:test';

import { customFieldsSection } from '../heap/custom-fields.ts';

test('an allocation with no custom fields gets no section', () => {
  assert.equal(customFieldsSection(undefined), '');
  assert.equal(customFieldsSection(null), '');
  assert.equal(customFieldsSection({}), '');
});

test('values are styled by their type', () => {
  const html = customFieldsSection({
    pool: 'gfx', refcount: 3, live: true, owner: null,
  });
  assert.ok(html.includes('trace fields'));
  assert.ok(html.includes('<span class="cf-value cf-string">&quot;gfx&quot;</span>'));
  assert.ok(html.includes('<span class="cf-value cf-number">3</span>'));
  // bool and null are dim rather than accented, and are shown as written
  assert.ok(html.includes('<span class="cf-value dim">true</span>'));
  assert.ok(html.includes('<span class="cf-value dim">null</span>'));
});

test('a field the language can address carries its predicate', () => {
  const html = customFieldsSection({ pool: 'gfx', 'allocator-class': 'slab' });
  assert.ok(html.includes('data-predicate="field.pool == &quot;gfx&quot;"'));
  // a key that is not identifier-shaped uses the bracket form
  assert.ok(html.includes(
    'data-predicate="field[&quot;allocator-class&quot;] == &quot;slab&quot;"',
  ));
});

test('a field the language cannot address carries no action', () => {
  const html = customFieldsSection({ debug: { site: 'a' }, list: [1, 2], owner: null });
  assert.ok(!html.includes('data-predicate'));
  assert.equal((html.match(/cf-none/g) || []).length, 3);
  // the value is still shown, as compact JSON
  assert.ok(html.includes('{&quot;site&quot;:&quot;a&quot;}'));
  assert.ok(html.includes('[1,2]'));
});

test('keys and values are escaped for HTML and for the DSL', () => {
  const html = customFieldsSection({ 'a<b>': 'say "hi" \\ <b>' });
  // no raw markup survives from either the key or the value
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('a&lt;b&gt;'));
  // the predicate carries DSL escapes, then HTML escapes on top
  assert.ok(html.includes(
    'data-predicate="field[&quot;a&lt;b&gt;&quot;] == &quot;say \\&quot;hi\\&quot; \\\\ &lt;b&gt;&quot;"',
  ));
});

test('a fractional number is shown and filterable (ANL-012)', () => {
  // the language reads `1.5` as the same double the trace's own text did, so
  // the predicate matches the record it was written from
  const html = customFieldsSection({ ratio: 1.5 });
  assert.ok(html.includes('<span class="cf-value cf-number">1.5</span>'));
  assert.ok(html.includes('data-predicate="field.ratio == 1.5"'));
});
