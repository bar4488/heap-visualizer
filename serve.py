#!/usr/bin/env python3
"""Dev server over dist/: http.server with caching disabled, so a rebuilt file is always refetched.

dist/ is a build product — run ./build.sh (or ./build.sh web) before serving.
"""
import functools
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8630
DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dist')


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    http.server.test(
        HandlerClass=functools.partial(NoCacheHandler, directory=DIST),
        port=PORT,
    )
