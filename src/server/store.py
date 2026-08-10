"""The request store: an append-only JSONL file (spec REQ-002).

Two line shapes, both carrying a `type`:

    {"type": "request", "id": …, "at": …, "text": …, "contact": …}
    {"type": "status",  "id": …, "at": …, "status": …}

Nothing rewrites a line. A status change appends, so the file is the history
as well as the state, and the reader folds the last status naming each request
over it. That is also why a half-written trailing line is skipped rather than
fatal: the writer may be mid-append while the panel reads.

Stdlib only, like everything else that runs here (D010).
"""

import json
import os
import secrets
import threading
from datetime import datetime, timezone

# REQ-002. `new` is the implied status of a request with no status line, so it
# is never actually written by append_request.
STATUSES = ('new', 'planned', 'done', 'declined')

# REQ-003. Both bounds are what keeps an unauthenticated write path from being
# a way to fill a disk one request at a time.
MAX_TEXT = 4000
MAX_CONTACT = 200

# One process appends, but ThreadingHTTPServer means several threads may. A
# single lock around the open-append-close is enough: lines are short and each
# write is one line.
_lock = threading.Lock()


def _now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


class Rejected(Exception):
    """Bad input, with the reason the form displays (REQ-001)."""


def _append(path, obj):
    with _lock:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, 'a', encoding='utf-8') as f:
            f.write(json.dumps(obj, ensure_ascii=False) + '\n')


def append_request(path, text, contact=''):
    """Validate and append one request. Returns the stored record."""
    text = (text or '').strip()
    contact = (contact or '').strip()
    if not text:
        raise Rejected('the request is empty')
    if len(text) > MAX_TEXT:
        raise Rejected(f'the request is longer than {MAX_TEXT} characters')
    if len(contact) > MAX_CONTACT:
        raise Rejected(f'the contact is longer than {MAX_CONTACT} characters')
    rec = {
        'type': 'request',
        'id': secrets.token_hex(6),
        'at': _now(),
        'text': text,
        'contact': contact,
    }
    _append(path, rec)
    return rec


def set_status(path, req_id, status):
    """Append a status line. Returns False when no such request exists."""
    if status not in STATUSES:
        raise Rejected(f'status must be one of: {", ".join(STATUSES)}')
    if not any(r['id'] == req_id for r in load_requests(path)):
        return False
    _append(path, {'type': 'status', 'id': req_id, 'at': _now(), 'status': status})
    return True


def load_requests(path):
    """Every request, newest first, each folded with its current status.

    A line that does not parse, or names a type this does not know, is skipped:
    the panel stays readable while the file's tail is being written.
    """
    requests = []
    statuses = {}
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(obj, dict) or not isinstance(obj.get('id'), str):
                    continue
                if obj.get('type') == 'request':
                    requests.append(obj)
                elif obj.get('type') == 'status' and obj.get('status') in STATUSES:
                    statuses[obj['id']] = obj['status']
    except FileNotFoundError:
        return []
    out = [dict(r, status=statuses.get(r['id'], 'new')) for r in requests]
    out.reverse()
    return out
