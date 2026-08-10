import test from 'node:test';
import assert from 'node:assert/strict';

// request.ts reaches shell/dom.ts, which reads `window` at module load; the
// stub is what lets the pure function be imported at all. Nothing below drives
// the DOM — the panel wiring is a person's to check (D001).
import { installDom } from './dom-stub.ts';

installDom();

const { requestOutcome } = await import('../request.ts');

// The one thing REQ-001 asks for that is easy to get wrong: three outcomes,
// not two. A tree served by ./serve.py has no service in front of it, and the
// form must say that rather than blame the person typing.

test('requestOutcome: a 201 with an id is the accepted case', () => {
  const got = requestOutcome(201, { id: 'abc123' });
  assert.equal(got.ok, true);
  assert.match(got.message, /thank you/i);
});

test('requestOutcome: a 400 shows the service\'s own reason', () => {
  const got = requestOutcome(400, { error: 'the request is empty' });
  assert.deepEqual(got, { ok: false, message: 'the request is empty' });
});

test('requestOutcome: no response at all reads as unreachable, not as rejected', () => {
  const got = requestOutcome(0, null);
  assert.equal(got.ok, false);
  assert.match(got.message, /cannot reach/i);
});

test('requestOutcome: a static server answering the POST reads as unreachable', () => {
  // SimpleHTTPRequestHandler answers an unimplemented POST with 501; other
  // static servers answer 404 or 405. None of them is a rejection.
  for (const status of [404, 405, 501]) {
    const got = requestOutcome(status, null);
    assert.equal(got.ok, false, `status ${status}`);
    assert.match(got.message, /without the request service/i);
  }
});

test('requestOutcome: any other failure names the status rather than guessing', () => {
  const got = requestOutcome(503, { error: 'HEAP_ADMIN_TOKEN is not configured' });
  assert.equal(got.ok, false);
  assert.match(got.message, /503/);
});

test('requestOutcome: a 201 without an id is not treated as success', () => {
  assert.equal(requestOutcome(201, null).ok, false);
});
