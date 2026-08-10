---
id: T049
title: The admin can delete a request
status: done
updated: 2026-08-11
---

# T049: The Admin Can Delete a Request

## Outcome

Each row of the review panel has a delete control; using it appends a tombstone
line naming the request, and the request stops being listed by
`GET /api/requests` from then on.

**Deleting appends; it does not erase.** The request line stays in
`requests.jsonl` and the text is still on disk until the file is rotated — the
store has one rule and it is that nothing rewrites a line
([REQ-002](../../spec/11-feature-requests.md#req-002-the-request-store)). The
panel says so where the control is. Erasing a request's text is a different
feature and would need the rewrite path this deliberately does not have.

Asked for by the user on 2026-08-11, over that stated cost.

## Done when

- [x] `DELETE /api/requests/{id}` appends a tombstone, 404s an unknown id, and
      401s without the token.
- [x] A deleted request is absent from `GET /api/requests`, and a status line
      arriving for it afterwards does not bring it back.
- [x] The panel's control confirms first and says that the line stays in the
      file.
- [x] REQ-002/003/004 state the tombstone, so the spec and the store agree.
- [x] `python3 -m unittest discover -s src/server` passes.

## Result

Done. `store.delete_request` appends the tombstone and `load_requests` drops
tombstoned ids from a `set` rather than another last-line-wins fold, which is
what makes a later status line unable to resurrect one. `DELETE
/api/requests/{id}` is the route; the panel row carries a red `delete` beside
its status control.

Verified against the container: delete removed a request from the list while
its text stayed in the file, a second delete of the same id was 404, and an
unauthenticated one was 401.

## Non-goals

- Erasing the text from disk, undeleting through the API, and any UI for
  reading tombstoned requests back — the file itself is that UI.
