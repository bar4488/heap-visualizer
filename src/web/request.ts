// The "Request" panel: ask for a feature from inside the app (spec REQ-001).
//
// Three rules shape this file:
//
//  1. **The app must not need the service.** Nothing here runs until the user
//     opens the panel and presses Send — no probe at startup, no health check,
//     no console error on a tree served by ./serve.py. The viewer is still
//     fully client-side; this is the one thing beside it (D010).
//
//  2. **Unreachable is not the same as rejected**, and saying so is the whole
//     reason `requestOutcome` is a function rather than three lines inside the
//     click handler. The static tree can be served with no service in front of
//     it, and a form that then says "something went wrong" is a form that looks
//     broken when it is merely unplugged. That distinction is the pure part,
//     and the web suite is what checks it.
//
//  3. **Only what the user typed is sent.** No trace name, no session, no
//     analysis, nothing about the loaded file. The body is `{text, contact}`.
//
// It is not in heap/panels.ts: there is nothing heap-shaped about it and
// nothing to restore per trace, for the same reason the Event window is not
// (SHELL-003).

import { $ } from './shell/dom.ts';
import { raisePanel } from './shell/panels.ts';

const ENDPOINT = '/api/requests';

export type Outcome = { ok: boolean; message: string };

/**
 * What the form says, given the response the service gave (or did not).
 *
 * `status` is 0 when `fetch` itself failed — no service listening at all. A
 * static server answers a POST it does not implement with 405/501, and a tree
 * served by something else again may answer 404 with an HTML body; all of
 * those mean the same thing to a person: nothing is there to receive this.
 * Only a 400 from the service itself is the user's to fix, and it carries the
 * reason ([REQ-003](../../spec/11-feature-requests.md)).
 *
 * Exported for the web suite; nothing else imports it.
 */
export function requestOutcome(status, body): Outcome {
  if (status === 201 && body && body.id) return { ok: true, message: 'Sent — thank you.' };
  if (status === 400 && body && body.error) return { ok: false, message: body.error };
  if (status === 0) {
    return { ok: false, message: 'Cannot reach the request service — this site is served without it.' };
  }
  if (status === 404 || status === 405 || status === 501) {
    return { ok: false, message: 'This site is served without the request service.' };
  }
  return { ok: false, message: `The request service answered ${status}.` };
}

async function send(text, contact): Promise<Outcome> {
  let status = 0;
  let body = null;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, contact }),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch {
    // a network-level failure: status stays 0, which requestOutcome reads as
    // "nothing is listening" rather than as a rejection
    status = 0;
  }
  return requestOutcome(status, body);
}

export function initRequest() {
  const panel = $('request-panel');
  const text = $('request-text');
  const contact = $('request-contact');
  const button = $('request-send');
  const status = $('request-status');

  const say = (msg, ok) => {
    status.textContent = msg;
    status.classList.toggle('bad', !ok);
  };

  $('btn-request').onclick = () => {
    panel.hidden = !panel.hidden;
    if (panel.hidden) return;
    raisePanel(panel);
    text.focus();
  };

  button.onclick = async () => {
    const body = text.value.trim();
    if (!body) {
      say('Write what you would like first.', false);
      return;
    }
    button.disabled = true;
    say('Sending…', true);
    const outcome = await send(body, contact.value.trim());
    button.disabled = false;
    say(outcome.message, outcome.ok);
    // Clearing on success only, so a failed send never loses what was typed
    // and a second press is a retry rather than a duplicate (REQ-001).
    if (outcome.ok) text.value = '';
  };

  // ctrl/cmd+enter sends, the same gesture the filter editor applies with
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) button.click();
  });
}
