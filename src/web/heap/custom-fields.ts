// The allocation panel's custom-fields section (ANL-006).
//
// Pure: allocation info in, HTML out. It is here rather than in main.ts
// because its escaping and its type rules are exactly the parts worth
// asserting, and main.ts cannot be imported by a test.

import { esc } from '../fmt.ts';
import { customFieldPredicate } from '../filter-actions.ts';

/**
 * The custom fields a producer attached to this record, as their own section
 * so a producer's `pool` is never mistaken for an engine field. Values are
 * styled by type, and each one that the filter language can address carries
 * an action writing the predicate that matches it.
 *
 * Returns '' for an allocation carrying none, so no empty section appears.
 */
export function customFieldsSection(extra) {
  const entries = Object.entries(extra || {});
  if (!entries.length) return '';
  const rows = entries.map(([key, value]) => {
    const predicate = customFieldPredicate(key, value);
    let cls = 'dim';
    let text;
    if (typeof value === 'string') {
      cls = 'cf-string';
      text = `"${value}"`;
    } else if (typeof value === 'number') {
      cls = 'cf-number';
      text = String(value);
    } else if (typeof value === 'boolean' || value === null) {
      text = String(value);
    } else {
      // an object or an array: shown, and not filterable — see ANL-010
      text = JSON.stringify(value);
    }
    const action = predicate
      ? `<button class="cf-filter" data-predicate="${esc(predicate)}"
          title="Filter to allocations where ${esc(key)} is this value">⊙</button>`
      : '<span class="cf-filter cf-none" title="not addressable by the filter language">·</span>';
    return `<div class="row cf-row"><span class="k">${esc(key)}</span>`
      + `<span class="cf-value ${cls}">${esc(text)}</span>${action}</div>`;
  });
  // one grid around the rows, so the key column sizes to the widest key
  // in this allocation instead of the built-in fixed width
  return `<div class="cf-head"><span>trace fields</span></div>`
    + `<div class="cf-list">${rows.join('')}</div>`;
}

