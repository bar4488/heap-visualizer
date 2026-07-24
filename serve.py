#!/usr/bin/env python3
"""Dev server: http.server with caching disabled, so edited files are always refetched."""
import functools
import http.server
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8630
WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'web')


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    http.server.test(
        HandlerClass=functools.partial(NoCacheHandler, directory=WEB),
        port=PORT,
    )
