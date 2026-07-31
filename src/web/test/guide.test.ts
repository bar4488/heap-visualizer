// The guide's markdown renderer (T024). `render` and `inline` are the two pure
// functions in guide.ts and the only part of that module a suite without a
// browser can reach — `highlight`, `act` and `load` are DOM and timing, which
// D001 says a person covers.
//
// Two things here are load-bearing rather than cosmetic. The action-link
// branch is the mechanism SHELL-009 constrains: prose reaches the app through
// `.g-act` buttons and nothing else, so a link that silently rendered as an
// anchor would be a quiet hole in that rule. And the escaping is what makes it
// safe to put authored markdown through `innerHTML` at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { installDom } from './dom-stub.ts';

installDom();

// guide.ts reads `document` and `devicePixelRatio` through shell/dom.ts at
// import time, and builds its panel-toggle map at module scope, so it is
// imported dynamically after the globals exist.
const { render, inline } = await import('../guide.ts');

const GUIDE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'guide');

// --- block grammar ---------------------------------------------------------

test('headings render at one level below their hash count, clamped at h4', () => {
  assert.equal(render('# Top'), '<h2>Top</h2>');
  assert.equal(render('## Second'), '<h3>Second</h3>');
  assert.equal(render('### Third'), '<h4>Third</h4>');
  // #### and deeper clamp rather than emitting h5/h6: the guide is a section
  // inside a page, not a document with its own outline.
  assert.equal(render('#### Fourth'), '<h4>Fourth</h4>');
});

test('a run of list items becomes one list, closed by the next block', () => {
  assert.equal(render('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
  assert.equal(render('* star'), '<ul><li>star</li></ul>');
  assert.equal(
    render('- one\n\n# After'),
    '<ul><li>one</li></ul>\n<h2>After</h2>',
  );
  // two runs separated by a paragraph are two lists, not one
  assert.equal(
    render('- a\ntext\n- b'),
    '<ul><li>a</li></ul>\n<p>text</p>\n<ul><li>b</li></ul>',
  );
});

test('a fenced block is code, and its contents are not read as markdown', () => {
  assert.equal(
    render('```\n# not a heading\n- not a list\n```'),
    '<pre><code># not a heading\n- not a list</code></pre>',
  );
  // *emphasis* and `code` inside a fence stay literal
  assert.equal(render('```\n*a* `b`\n```'), '<pre><code>*a* `b`</code></pre>');
});

test('an unterminated fence still emits its contents', () => {
  // A page that forgets a closing fence loses its formatting, not its text.
  assert.equal(render('```\nkept'), '<pre><code>kept</code></pre>');
});

test('paragraphs, rules, and blank lines', () => {
  assert.equal(render('one\n\ntwo'), '<p>one</p>\n<p>two</p>');
  assert.equal(render('---'), '<hr>');
  assert.equal(render('-----'), '<hr>');
  assert.equal(render(''), '');
  assert.equal(render('\n\n\n'), '');
});

// --- inline grammar --------------------------------------------------------

test('code spans, strong, and em', () => {
  assert.equal(inline('a `code` b'), 'a <code>code</code> b');
  assert.equal(inline('a **bold** b'), 'a <strong>bold</strong> b');
  assert.equal(inline('a *slant* b'), 'a <em>slant</em> b');
});

test('strong is not read as em', () => {
  // The em pattern requires a non-* character before the delimiter, which is
  // what keeps **a** from becoming <em>*a</em>*.
  assert.equal(inline('**bold**'), '<strong>bold</strong>');
  assert.equal(inline('x **bold** y'), 'x <strong>bold</strong> y');
});

// --- links: the SHELL-009 boundary ----------------------------------------

test('an action link becomes a button carrying its verb, never an anchor', () => {
  for (const spec of ['show:filter-panel', 'do:btn-demo', 'set:row-bytes=4096']) {
    const html = inline(`[go](#${spec})`);
    assert.equal(html, `<button class="g-act" data-act="${spec}">go</button>`);
    assert.ok(!html.includes('<a '), `${spec} rendered as an anchor`);
  }
});

test('a fragment that is not one of the three verbs stays an ordinary link', () => {
  // The guide has no fourth verb. One appearing in prose must not silently
  // become a button that dispatches nothing.
  assert.equal(inline('[x](#load:demo)'), '<a href="#load:demo">x</a>');
  assert.equal(inline('[x](#section)'), '<a href="#section">x</a>');
});

test('relative links stay in-tab; absolute links open away', () => {
  // Scenario traces are relative: they reload this tab via ?trace= autoload,
  // which is how the guide loads one without a code path into the loader.
  assert.equal(
    inline('[s](index.html?trace=guide/traces/sites.heapl&guide=1)'),
    '<a href="index.html?trace=guide/traces/sites.heapl&guide=1">s</a>',
  );
  const ext = inline('[e](https://example.invalid/)');
  assert.ok(ext.includes('target="_blank"'));
  assert.ok(ext.includes('rel="noreferrer"'));
});

// --- escaping --------------------------------------------------------------

test('markup in authored prose is escaped before it reaches innerHTML', () => {
  const html = render('a <script>x</script> & "quoted"');
  assert.ok(!html.includes('<script>'), 'a tag survived escaping');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('&amp;'));
  assert.ok(html.includes('&quot;'));
});

test('a quote in a link cannot close the attribute it lands in', () => {
  // esc() runs over the whole source before inline() builds any attribute, so
  // the href and the data-act value are already quote-free by construction.
  const html = render('[x](#show:a"onerror=alert(1))');
  assert.ok(!/data-act="[^"]*"[^>]*onerror/.test(html), 'attribute was closed');
  assert.ok(html.includes('&quot;'));
});

// --- the shipped pages -----------------------------------------------------

const pages = readdirSync(GUIDE_DIR).filter((f) => f.endsWith('.md'));

test('every shipped guide page renders', () => {
  assert.ok(pages.length > 0, 'no guide pages found');
  for (const page of pages) {
    const src = readFileSync(join(GUIDE_DIR, page), 'utf8');
    assert.doesNotThrow(() => render(src), `${page} failed to render`);
  }
});

test('every action in a shipped page names an id that exists in index.html', () => {
  // T019's third pass found by hand that every scenario link pointed at a path
  // that would 404. This is the mechanical half of that check: an action whose
  // target id is not in the markup can only ever write "no element" to the
  // status line.
  const markup = readFileSync(join(GUIDE_DIR, '..', 'index.html'), 'utf8');
  const ids = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

  const missing: string[] = [];
  for (const page of pages) {
    const src = readFileSync(join(GUIDE_DIR, page), 'utf8');
    for (const m of src.matchAll(/#(?:show|do|set):([A-Za-z0-9_.-]+)/g)) {
      if (!ids.has(m[1])) missing.push(`${page}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every scenario trace a page links to exists on disk', () => {
  const traces = new Set(readdirSync(join(GUIDE_DIR, 'traces')));
  const missing: string[] = [];
  for (const page of pages) {
    const src = readFileSync(join(GUIDE_DIR, page), 'utf8');
    for (const m of src.matchAll(/trace=guide\/traces\/([^)&\s]+)/g)) {
      if (!traces.has(m[1])) missing.push(`${page}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});
