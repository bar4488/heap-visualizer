// Heap domain: the body of the Event window — what a custom (`E`) trace
// record shows when you click it (TRACE-010, NAV-005).
//
// Pure: one event row in, HTML out, like custom-fields.ts and for the same
// reason. A custom event is not an allocation, so this is deliberately not the
// allocation body with parts removed: there is nothing to name, tag, color or
// navigate to on the map — only where it sits in the stream and what the
// producer attached to it.

import { esc } from '../fmt.ts';
import { customFieldsSection } from './custom-fields.ts';

/** The label shown in the window's head. */
export function eventWindowTitle(event) {
  return event && event.title ? `Event · ${event.title}` : 'Event';
}

/**
 * `fmtTime` is passed in rather than imported because formatting a timestamp
 * needs the trace's time unit, which lives in main.ts's UI state.
 */
export function eventWindowBody(event, fmtTime) {
  const rows = [
    event.title ? ['label', event.title] : null,
    ['seq', String(event.seq)],
    ['t', fmtTime(event.t)],
    event.thr !== null && event.thr !== undefined ? ['thread', String(event.thr)] : null,
  ].filter(Boolean);
  const html = rows
    .map(([k, v]) => `<div class="row"><span class="k">${k}</span><span>${esc(v)}</span></div>`)
    .join('');
  // no per-field filter action: the filter language is over allocations, and a
  // predicate on `field.<key>` here would match records that are not this one
  return html + customFieldsSection(event.extra, null, { actions: false });
}
