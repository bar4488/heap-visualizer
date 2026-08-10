#!/usr/bin/env python3
"""The feature-request service, and the static server in front of it (spec 11).

One process, one origin: `dist/` is served exactly as `serve.py` serves it, and
four routes beside it carry the request form and the review panel. No proxy, no
CORS, no dependency — see D010 for why this is a process rather than a field in
a file, and why it never sees trace data.

    HEAP_REQUESTS_PATH  where the JSONL store lives   (default data/requests.jsonl)
    HEAP_ADMIN_TOKEN    shared secret for /api/requests reads and status writes
    HEAP_DIST           the built static tree         (default ../../dist)
    PORT                                              (default 8630)

Run it directly for a local check, or via docker compose (docs/context.md).
"""

import http.server
import json
import os
import sys

from store import Rejected, append_request, load_requests, set_status

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.environ.get('HEAP_DIST') or os.path.join(HERE, '..', '..', 'dist')
REQUESTS_PATH = os.environ.get('HEAP_REQUESTS_PATH') or os.path.join(HERE, '..', '..', 'data', 'requests.jsonl')
ADMIN_TOKEN = os.environ.get('HEAP_ADMIN_TOKEN', '')
PORT = int(os.environ.get('PORT', '8630'))

MAX_BODY = 64 * 1024

# What docker-compose.yml supplies when the environment does not (T048). It is
# not a fallback in here — an unset token still fails closed — only the string
# this recognizes as "nobody has chosen one yet", so every start can say so.
DEFAULT_ADMIN_TOKEN = 'admin'


def token_warning(token):
    """The line printed at startup, or None when the token was actually chosen."""
    if not token:
        return 'warning: HEAP_ADMIN_TOKEN unset — the review panel will serve nothing'
    if token == DEFAULT_ADMIN_TOKEN:
        return ('warning: running on the default admin token — anyone who reaches '
                'this port can read the requests. Set HEAP_ADMIN_TOKEN.')
    return None


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static files from dist/, plus the API. Unknown paths stay static."""

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIST, **kw)

    # -- helpers ------------------------------------------------------------

    def _json(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_BODY:
            raise Rejected('missing or oversized body')
        try:
            obj = json.loads(self.rfile.read(length).decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            raise Rejected('body is not JSON')
        if not isinstance(obj, dict):
            raise Rejected('body is not a JSON object')
        return obj

    def _authorized(self):
        """REQ-004: a wrong or missing token is 401; no token configured is 503.

        Failing closed on an unset token is the point — a deployment that
        forgot the environment variable must not be an open one.
        """
        if not ADMIN_TOKEN:
            self._json(503, {'error': 'HEAP_ADMIN_TOKEN is not configured'})
            return False
        header = self.headers.get('Authorization', '')
        if header != f'Bearer {ADMIN_TOKEN}':
            self._json(401, {'error': 'bad or missing token'})
            return False
        return True

    def end_headers(self):
        # same reason as serve.py: a rebuilt file must always be refetched
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, fmt, *args):
        # request text never reaches the log; only the method and path do
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    # -- routes -------------------------------------------------------------

    def do_GET(self):
        if self.path.split('?')[0] == '/admin':
            return self._send_admin()
        if self.path.split('?')[0] == '/api/requests':
            if not self._authorized():
                return
            return self._json(200, {'requests': load_requests(REQUESTS_PATH)})
        if self.path.startswith('/api/'):
            return self._json(404, {'error': 'no such route'})
        return super().do_GET()

    def do_POST(self):
        path = self.path.split('?')[0]
        try:
            if path == '/api/requests':
                body = self._body()
                rec = append_request(REQUESTS_PATH, body.get('text'), body.get('contact'))
                return self._json(201, {'id': rec['id']})
            if path.startswith('/api/requests/') and path.endswith('/status'):
                if not self._authorized():
                    return
                req_id = path[len('/api/requests/'):-len('/status')]
                body = self._body()
                if not set_status(REQUESTS_PATH, req_id, body.get('status')):
                    return self._json(404, {'error': 'no such request'})
                return self._json(200, {'ok': True})
        except Rejected as e:
            return self._json(400, {'error': str(e)})
        return self._json(404, {'error': 'no such route'})

    def _send_admin(self):
        """The panel itself carries no request data, so it needs no token."""
        with open(os.path.join(HERE, 'admin.html'), 'rb') as f:
            body = f.read()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    # index.html, not the directory: compose bind-mounts ./dist, and a bind
    # mount of a path that does not exist creates an empty directory, so
    # `isdir` would be true on exactly the tree that was never built.
    if not os.path.isfile(os.path.join(DIST, 'index.html')):
        sys.exit(f'error: no built site at {DIST} — run ./build.sh first')
    warning = token_warning(ADMIN_TOKEN)
    if warning:
        sys.stderr.write(warning + '\n')
    server = http.server.ThreadingHTTPServer(('', PORT), Handler)
    sys.stderr.write(f'serving {DIST} and the request API on :{PORT}\n')
    server.serve_forever()


if __name__ == '__main__':
    main()
