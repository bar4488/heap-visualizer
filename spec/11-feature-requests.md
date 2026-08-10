# 11 — Feature Requests

The one server-side surface. A user asks for a feature from inside the app; the
maintainer reads what came in and marks what is happening to it. Rationale, and
why the viewer itself stays client-side, is
[D010](../docs/decisions/D010-feature-requests-are-server-side.md).

## REQ-001: Asking for a feature

The toolbar must carry a control that opens a request form: a free-text field
for the request, an optional contact field, and a send action.

- Submitting must post the text to the service and report the outcome in the
  form: accepted, rejected with the reason, or **the service is unreachable**.
  The third case must be distinguishable from the second — the static tree can
  be served without the service (`./serve.py`), and a form that silently fails
  there is worse than one that says it cannot reach anything.
- The app must not require the service. Nothing outside the form may change
  behavior, block, or log an error because the service is absent, and no
  request to it may be made until the user sends one.
- The form must not send trace data, analysis data, session state, or anything
  else the user did not type. What crosses is the request text, the optional
  contact string, and nothing more.
- An accepted request must clear the field, so a second send is a new request
  rather than a duplicate of the first.

## REQ-002: The request store

Requests are kept in one append-only JSON-lines file. Every line is an object
carrying a `type`:

- `{"type":"request","id":…,"at":…,"text":…,"contact":…}` — `id` is unique and
  permanent, `at` is an ISO-8601 UTC timestamp, `contact` may be empty.
- `{"type":"status","id":…,"at":…,"status":…}` — a later decision about the
  request with that `id`.
- `{"type":"delete","id":…,"at":…}` — a tombstone: the request with that `id`
  is no longer listed by anything.

Rules:

- **Lines are only ever appended.** A status change appends, and so does a
  delete; nothing rewrites or removes a line, so the file is the history as
  well as the state. **Deleting therefore hides a request, it does not erase
  it**: the request's own line, and its text, stay in the file until the file
  is rotated, and any surface offering the action must say so.
- A tombstone is final. A `status` line naming a tombstoned request must not
  bring it back.
- A request's current status is the last `status` line naming it, or `new` when
  there is none. The permitted values are `new`, `planned`, `done`, `declined`.
  A tombstoned request has no status, because it is not read back at all.
- A line that does not parse, or names an unknown `type`, must be skipped rather
  than abort the read — a half-written last line must not make the panel
  unreadable.
- The file's path is configuration, and it must live on a volume that outlives
  the container.

## REQ-003: The HTTP interface

One process serves the static tree and the API from the same origin.

| Route | Auth | Behavior |
|---|---|---|
| `POST /api/requests` | none | Body `{text, contact?}`. Appends a request; responds with its `id`. |
| `GET /api/requests` | token | Every request, newest first, each with its folded status. |
| `POST /api/requests/{id}/status` | token | Body `{status}`. Appends a status line. |
| `DELETE /api/requests/{id}` | token | Appends a tombstone; the request stops being listed. |
| `GET /admin` | none | The review page itself. It carries no request data. |
| anything else | none | A file from the built static tree. |

- `text` must be rejected when it is empty after trimming or longer than 4000
  characters, with 400 and a reason the form can display. Both bounds exist so
  the open write path cannot be used to fill a disk one request at a time.
- A status or a delete for an unknown or already-tombstoned `id` must be 404,
  and an unpermitted status value 400.
- Every response must be JSON, including errors.

## REQ-004: The review panel

`GET /admin` serves a page listing the requests newest-first — text, contact,
time, and current status — with controls on each row that set its status and
delete it. The delete control must confirm first, and must say that the line
stays in the file ([REQ-002](#req-002-the-request-store)) rather than let
"delete" be read as an erase.

- **The panel is protected by a shared token** taken from the environment. The
  page asks for it, sends it on every data request, and the data routes must
  reject a wrong or missing one with 401.
- When no token is configured, the data routes must fail closed (503, saying so)
  rather than serve the requests unauthenticated. A misconfigured deployment
  must not be an open one.
- The **deployment configuration** may supply a default token so that starting
  the stack with an empty environment works. The service must not: a default
  compiled into the service would remove the rule above. A service started on
  the default token must say so on every start, naming the variable to set.
- The submit route stays unauthenticated: it is the whole point of the feature.
