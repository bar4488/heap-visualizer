---
id: T047
title: Ask for a feature, from the app to a reviewable list
status: doing
updated: 2026-08-10
---

# T047: Ask for a Feature, From the App to a Reviewable List

## Outcome

The toolbar has a **Request** button that opens a form; sending posts to a
Python-stdlib service that appends to `requests.jsonl`; `/admin` lists what came
in behind a shared token and sets each request's status. `docker compose up`
serves the built `dist/` and that service as one origin.

Asked for by the user on 2026-08-10. The shape and its four choices are
[D010](../decisions/D010-feature-requests-are-server-side.md); the behavior is
[spec/11](../../spec/11-feature-requests.md).

## Done when

- [ ] `src/server/app.py` serves `dist/` plus the four routes of
      [REQ-003](../../spec/11-feature-requests.md#req-003-the-http-interface),
      with no third-party import.
- [ ] `python3 -m unittest discover -s src/server` covers the store fold, the
      text bounds, the unknown-id status, and the auth cases of
      [REQ-004](../../spec/11-feature-requests.md#req-004-the-review-panel)
      — including that an unset token fails closed.
- [ ] `docker compose up` serves the app on a published port and keeps
      `requests.jsonl` on a named volume; a tree with no `dist/` fails with a
      message naming `./build.sh`.
- [ ] The form reports unreachable separately from rejected, so `./serve.py`
      (no service) is honest rather than silent
      ([REQ-001](../../spec/11-feature-requests.md#req-001-asking-for-a-feature)).
- [ ] `node_modules/.bin/tsc -p tsconfig.test.json` and the three existing
      suites still pass.

## Non-goals

- Accounts, per-user identity, editing or deleting a request, notification of
  any kind, rate limiting beyond the length bound, and a second server-side
  feature (D010 names that as the point to reconsider the whole shape).
- Building anything inside the container. `./build.sh` stays the one build path
  ([TOOL-002](../../spec/10-tooling.md#tool-002-build)).
- Restoring the request panel across sessions: it is not in the panel table, for
  the reason the Event window is not
  ([SHELL-003](../../spec/09-ui-shell.md#shell-003-panels-are-declared-as-data)).
