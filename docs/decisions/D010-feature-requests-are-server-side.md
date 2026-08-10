---
id: D010
title: Feature requests are server-side, and compose is a run path not a build path
created: 2026-08-10
---

# D010: Feature Requests Are Server-Side, and Compose Is a Run Path

Asked for by the user on 2026-08-10: an "ask for a feature" button in the app,
the requests kept somewhere the maintainer can read, a panel to review them, and
Docker Compose to serve it alongside the site.

## The app stays client-side; the request service is beside it

Everything about a *trace* stays in the browser — no trace bytes, no analysis,
no session state leaves the page, and
[ARCH-001](../../spec/08-architecture.md#arch-001-the-wasm-core) through
ARCH-003 are untouched. The request service shares an origin with the static
tree and nothing else: it never sees heap data, and the viewer works with the
service absent (the form reports it, the rest of the app does not know it
exists).

That is the whole reason it is a separate process rather than, say, a field in
`.heapa`. A request is the one piece of state that belongs to the *project*
rather than to a trace, and the project has no other server.

## Python stdlib, one process, an append-only file

The service serves `dist/` **and** the API, so there is no proxy and no CORS.
It is `http.server` with no dependencies, matching `serve.py` and the same
stance TOOL-002 takes about the runtime: nothing gets installed to run this.

Storage is `requests.jsonl`, append-only, one JSON object per line — a request
line, or a status line naming an earlier request. The same idiom as `.heapl`:
greppable, tail-able, backed up by copying, and safe to append to under a lock.
A status change appends rather than rewrites, so the file is also the history.
SQLite would buy queries this has no use for.

The review panel is protected by a shared token from the environment
(`HEAP_ADMIN_TOKEN`). Not because the threat model is interesting, but because
"bind to localhost" stops being true the first time the port is published, and
that mistake is silent.

## Compose is not a second build path

[TOOL-002](../../spec/10-tooling.md#tool-002-build) says a container path must
not be reintroduced without a decision record. This is that record, and the
distinction it turns on is that **`docker compose` does not build the app**.
`./build.sh` against a local toolchain is still the only way `dist/` is
produced; the image copies an already-built `dist/` in and runs the Python
service over it. There is no Rust and no `tsc` in the image, nothing to keep in
sync with the real build, and `compose up` on a tree that was never built fails
saying so.

What [T038](../tickets/T038-drop-the-docker-build.md) removed — a container
that ran `cargo` and `tsc` so that a second toolchain had to be maintained — is
not coming back. Reversing that would need its own record.

## What would reverse this

A second server-side feature. One process serving static files and appending to
a JSONL file is right for exactly one small write path; a second one is the
point to ask for a real service with a real store, rather than growing this
one.
