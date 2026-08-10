"""The request service's suite: the store fold, the bounds, and the auth cases.

    python3 -m unittest discover -s src/server

Stdlib `unittest`, and it drives the real handler over a real socket on port 0
rather than a stub — the routing, the status codes and the token check are the
whole feature, and a stub of `BaseHTTPRequestHandler` would be a stub of what
is being tested. It needs no `dist/`: the static branch is `SimpleHTTPRequest-
Handler`'s own and is not what these assert.
"""

import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import app
import store

TOKEN = 'test-token'


class QuietHandler(app.Handler):
    """The real handler, minus the access log — the suite makes ~30 requests."""

    def log_message(self, fmt, *args):
        pass


def call(port, path, method='GET', body=None, token=None):
    """Returns (status, parsed json). An HTTP error is a result, not a raise."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    if token is not None:
        req.add_header('Authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, json.loads(res.read() or b'{}')
    except urllib.error.HTTPError as e:
        with e:
            return e.code, json.loads(e.read() or b'{}')


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = os.path.join(self.dir.name, 'requests.jsonl')
        # The module reads its configuration once at import; the tests set it
        # per case rather than re-importing.
        app.REQUESTS_PATH = self.path
        app.ADMIN_TOKEN = TOKEN
        app.DIST = self.dir.name
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def post(self, text, contact=None):
        body = {'text': text}
        if contact is not None:
            body['contact'] = contact
        return call(self.port, '/api/requests', 'POST', body)

    # -- REQ-001 / REQ-003: the open write path ------------------------------

    def test_a_request_is_accepted_and_read_back(self):
        status, body = self.post('please add undo', 'me@example.com')
        self.assertEqual(status, 201)
        self.assertTrue(body['id'])

        status, body = call(self.port, '/api/requests', token=TOKEN)
        self.assertEqual(status, 200)
        self.assertEqual(len(body['requests']), 1)
        got = body['requests'][0]
        self.assertEqual(got['text'], 'please add undo')
        self.assertEqual(got['contact'], 'me@example.com')
        self.assertEqual(got['status'], 'new')

    def test_empty_and_oversized_text_are_rejected_with_a_reason(self):
        for text in ('', '   ', 'x' * (store.MAX_TEXT + 1)):
            status, body = self.post(text)
            self.assertEqual(status, 400, text[:20])
            self.assertTrue(body['error'])
        self.assertEqual(store.load_requests(self.path), [])

    def test_requests_read_back_newest_first(self):
        for text in ('first', 'second', 'third'):
            self.post(text)
        _, body = call(self.port, '/api/requests', token=TOKEN)
        self.assertEqual([r['text'] for r in body['requests']], ['third', 'second', 'first'])

    # -- REQ-002: the store --------------------------------------------------

    def test_status_folds_to_the_last_line_naming_the_request(self):
        _, body = self.post('add multiple traces')
        rid = body['id']
        for status in ('planned', 'done'):
            code, _ = call(self.port, f'/api/requests/{rid}/status', 'POST',
                           {'status': status}, token=TOKEN)
            self.assertEqual(code, 200)
        self.assertEqual(store.load_requests(self.path)[0]['status'], 'done')
        # appended, never rewritten: the request line and both statuses survive
        with open(self.path) as f:
            self.assertEqual(len(f.readlines()), 3)

    def test_a_damaged_line_is_skipped_rather_than_fatal(self):
        self.post('a real one')
        with open(self.path, 'a') as f:
            f.write('{"type":"request","id":"trunc"\n')  # a half-written append
            f.write('{"type":"nonsense","id":"x"}\n')
        got = store.load_requests(self.path)
        self.assertEqual([r['text'] for r in got], ['a real one'])

    def test_an_absent_store_reads_as_empty(self):
        self.assertEqual(store.load_requests(os.path.join(self.dir.name, 'nope.jsonl')), [])

    def test_delete_hides_a_request_without_erasing_its_line(self):
        _, body = self.post('a request that gets deleted')
        rid = body['id']
        code, _ = call(self.port, f'/api/requests/{rid}', 'DELETE', token=TOKEN)
        self.assertEqual(code, 200)

        _, body = call(self.port, '/api/requests', token=TOKEN)
        self.assertEqual(body['requests'], [])
        # the point of the tombstone: nothing was rewritten, so the text is
        # still on disk until the file is rotated (REQ-002)
        with open(self.path) as f:
            self.assertIn('a request that gets deleted', f.read())

    def test_a_tombstone_is_final(self):
        _, body = self.post('deleted, then a status arrives')
        rid = body['id']
        call(self.port, f'/api/requests/{rid}', 'DELETE', token=TOKEN)
        code, _ = call(self.port, f'/api/requests/{rid}/status', 'POST',
                       {'status': 'done'}, token=TOKEN)
        self.assertEqual(code, 404)
        # even a status line written straight into the file must not resurrect it
        store._append(self.path, {'type': 'status', 'id': rid, 'at': 'x', 'status': 'done'})
        self.assertEqual(store.load_requests(self.path), [])

    def test_delete_needs_the_token_and_a_real_id(self):
        _, body = self.post('protected from a stranger')
        rid = body['id']
        code, _ = call(self.port, f'/api/requests/{rid}', 'DELETE')
        self.assertEqual(code, 401)
        code, _ = call(self.port, '/api/requests/nosuchid', 'DELETE', token=TOKEN)
        self.assertEqual(code, 404)
        # deleting twice is the second case, not a second delete
        call(self.port, f'/api/requests/{rid}', 'DELETE', token=TOKEN)
        code, _ = call(self.port, f'/api/requests/{rid}', 'DELETE', token=TOKEN)
        self.assertEqual(code, 404)

    def test_an_unknown_id_is_404_and_a_bad_status_is_400(self):
        _, body = self.post('something')
        rid = body['id']
        code, _ = call(self.port, '/api/requests/nosuchid/status', 'POST',
                       {'status': 'done'}, token=TOKEN)
        self.assertEqual(code, 404)
        code, _ = call(self.port, f'/api/requests/{rid}/status', 'POST',
                       {'status': 'shipped'}, token=TOKEN)
        self.assertEqual(code, 400)

    # -- REQ-004: the panel is protected -------------------------------------

    def test_reads_and_status_writes_require_the_token(self):
        _, body = self.post('visible only to the maintainer')
        rid = body['id']
        for token in (None, 'wrong'):
            code, _ = call(self.port, '/api/requests', token=token)
            self.assertEqual(code, 401)
            code, _ = call(self.port, f'/api/requests/{rid}/status', 'POST',
                           {'status': 'done'}, token=token)
            self.assertEqual(code, 401)

    def test_an_unconfigured_token_fails_closed(self):
        app.ADMIN_TOKEN = ''
        self.post('still accepted')
        code, body = call(self.port, '/api/requests', token='anything')
        self.assertEqual(code, 503)
        self.assertIn('HEAP_ADMIN_TOKEN', body['error'])

    def test_the_default_token_is_a_real_token_that_warns(self):
        # compose supplies it so `docker compose up` works bare (T048); the
        # service treats it as a token like any other, and says so every start.
        app.ADMIN_TOKEN = app.DEFAULT_ADMIN_TOKEN
        self.post('sent to a default-token deployment')
        code, _ = call(self.port, '/api/requests', token=app.DEFAULT_ADMIN_TOKEN)
        self.assertEqual(code, 200)
        code, _ = call(self.port, '/api/requests', token='wrong')
        self.assertEqual(code, 401)
        self.assertIn('HEAP_ADMIN_TOKEN', app.token_warning(app.DEFAULT_ADMIN_TOKEN))

    def test_a_chosen_token_warns_about_nothing(self):
        self.assertIsNone(app.token_warning('something-nobody-guesses'))
        self.assertIn('unset', app.token_warning(''))

    def test_the_panel_page_itself_needs_no_token(self):
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}/admin')
        with urllib.request.urlopen(req) as res:
            self.assertEqual(res.status, 200)
            self.assertIn(b'feature requests', res.read())


if __name__ == '__main__':
    unittest.main()
