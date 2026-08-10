---
id: T048
title: docker compose up works with no environment set
status: done
updated: 2026-08-11
---

# T048: `docker compose up` Works With No Environment Set

## Outcome

`docker compose up` with nothing set serves a usable review panel: the compose
file supplies a default `HEAP_ADMIN_TOKEN`, and the service says on every start
that the default is in use and what to set instead.

The default lives in `docker-compose.yml`, not in `app.py`: the service's own
rule — no token configured means the review routes serve nothing
([REQ-004](../../spec/11-feature-requests.md#req-004-the-review-panel)) — is
what keeps a hand-run or differently-deployed process from being open, and a
default baked into the code would delete it.

Asked for by the user on 2026-08-11, over the stated cost: a published port on
a known token is a readable request list until someone changes it.

## Done when

- [x] `docker compose up` with no `HEAP_ADMIN_TOKEN` in the environment serves
      `/admin` and its data routes.
- [x] Starting on the default logs a warning naming `HEAP_ADMIN_TOKEN`, and
      starting on any other token does not.
- [x] `python3 src/server/app.py` with nothing set still fails closed (503).
- [x] REQ-004 states the default and what it is for.
- [x] `python3 -m unittest discover -s src/server` passes.

## Result

Done. The default is one line of `docker-compose.yml`; `app.py` gained
`token_warning`, which names the variable both when the token is unset and when
it is the default, and is what the suite asserts on.

Verified: `docker compose up` with an empty environment logged the warning and
served `/admin` data on `Bearer admin`, while a wrong token stayed 401;
`app.py` imported with nothing set still reports the unset warning and its
routes 503.

**`__pycache__/` had been committed with T047** and is now removed from the
index and ignored, along with `data/` (the store's default path outside
Docker).
