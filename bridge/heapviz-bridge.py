#!/usr/bin/env python3
"""heapviz-bridge - local file bridge for the heap-visualizer web app.

Browsers without the File System Access API (Firefox, Safari) can't open a
project folder directly. This bridge serves one directory over localhost
HTTP; the web app's "Connect to bridge…" talks to it with the same
read/write operations it would run against a picked folder.

Usage:
    python3 heapviz-bridge.py [--dir PATH] [--port 8631] [--token TOKEN]

Then paste the printed URL into the visualizer's landing screen.

Security: binds 127.0.0.1 only, requires the token on every request (so a
random web page can't read your files through the bridge), and refuses
paths that escape the served directory. Only the Python stdlib is used.
"""

from __future__ import annotations

import argparse
import json
import secrets
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


def make_handler(root: Path, token: str):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        # -- helpers ---------------------------------------------------------

        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            # Chrome's Private Network Access preflight for public->local
            self.send_header("Access-Control-Allow-Private-Network", "true")

        def _reply(self, code: int, body: bytes, ctype: str = "application/json"):
            self.send_response(code)
            self._cors()
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, code: int, obj):
            self._reply(code, json.dumps(obj).encode())

        def _request(self):
            """Parse+authorize the request. Returns (endpoint, rel_path) or None."""
            u = urlparse(self.path)
            q = parse_qs(u.query)
            if q.get("token", [""])[0] != token:
                self._json(401, {"error": "bad or missing token"})
                return None
            if not u.path.startswith("/api/"):
                self._json(404, {"error": "unknown endpoint"})
                return None
            return u.path[len("/api/"):], q.get("path", [""])[0]

        def _resolve(self, rel: str) -> Path | None:
            """Resolve rel against root; None if it escapes."""
            p = (root / rel.lstrip("/")).resolve()
            if p != root and root not in p.parents:
                self._json(403, {"error": "path escapes served directory"})
                return None
            return p

        # -- methods ---------------------------------------------------------

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            req = self._request()
            if req is None:
                return
            ep, rel = req
            if ep == "info":
                self._json(200, {"bridge": 1, "name": root.name})
            elif ep == "list":
                p = self._resolve(rel)
                if p is None:
                    return
                if not p.is_dir():
                    self._json(404, {"error": "not a directory"})
                    return
                entries = [{"name": c.name, "dir": c.is_dir()}
                           for c in sorted(p.iterdir(), key=lambda c: c.name)]
                self._json(200, entries)
            elif ep == "stat":
                p = self._resolve(rel)
                if p is None:
                    return
                if p.is_file():
                    self._json(200, {"size": p.stat().st_size})
                else:
                    self._json(404, {"error": "no such file"})
            elif ep == "file":
                p = self._resolve(rel)
                if p is None:
                    return
                if not p.is_file():
                    self._json(404, {"error": "no such file"})
                    return
                self._reply(200, p.read_bytes(), "application/octet-stream")
            else:
                self._json(404, {"error": "unknown endpoint"})

        def do_PUT(self):
            req = self._request()
            if req is None:
                return
            ep, rel = req
            if ep != "file" or not rel:
                self._json(404, {"error": "unknown endpoint"})
                return
            p = self._resolve(rel)
            if p is None:
                return
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(body)
            self._json(200, {"ok": True, "size": len(body)})

        def log_message(self, fmt, *args):  # quiet: one line per request is noise
            pass

    return Handler


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Local file bridge for heap-visualizer.")
    ap.add_argument("--dir", default=".", help="project directory to serve (default: cwd)")
    ap.add_argument("--port", type=int, default=8631)
    ap.add_argument("--token", default=None,
                    help="access token (default: freshly generated)")
    args = ap.parse_args(argv)

    root = Path(args.dir).resolve()
    if not root.is_dir():
        print(f"error: {root} is not a directory", file=sys.stderr)
        return 1
    token = args.token or secrets.token_urlsafe(9)

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(root, token))
    print(f"heapviz-bridge serving {root}")
    print(f"connect the visualizer to:  http://127.0.0.1:{args.port}/?token={token}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
