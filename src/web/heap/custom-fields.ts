// The allocation panel's custom-fields section (ANL-006).
//
// Pure: allocation info in, HTML out. It is here rather than in main.ts
// because its escaping and its type rules are exactly the parts worth
// asserting, and main.ts cannot be imported by a test.

import { esc } from '../fmt.ts';
import { customFieldPredicate } from '../filter-actions.ts';

/**
 * The two records that describe one allocation, as one list of rows: the
 * creator's custom fields, then the fields of the `F`/`R` that freed it. A key
 * both records carry appears once holding the death record's value — the later
 * record is the later word on the same allocation — and remembers where it
 * came from, because the filter language addresses the two sides differently.
 */
function mergeFields(extra, deathExtra) {
  const rows = new Map();
  for (const [key, value] of Object.entries(extra || {})) {
    rows.set(key, { key, value, atDeath: false });
  }
  for (const [key, value] of Object.entries(deathExtra || {})) {
    rows.set(key, { key, value, atDeath: true });
  }
  return [...rows.values()];
}

/**
 * The custom fields a producer attached to this allocation's records, as their
 * own section so a producer's `pool` is never mistaken for an engine field.
 * Values are styled by type, and each one that the filter language can address
 * carries an action writing the predicate that matches it.
 *
 * Returns '' for an allocation carrying none, so no empty section appears.
 */
export function customFieldsSection(extra, deathExtra = null) {
  const entries = mergeFields(extra, deathExtra);
  if (!entries.length) return '';
  const rows = entries.map(({ key, value, atDeath }) => {
    const predicate = customFieldPredicate(key, value, atDeath);
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
    // the badge is the whole tell that this value is the freeing record's, and
    // it is why the row's predicate reads `death.field.…`
    const source = atDeath
      ? '<span class="cf-at" title="from the record that freed this allocation">on free</span>'
      : '';
    return `<div class="row cf-row"><span class="k">${esc(key)}${source}</span>`
      + `<span class="cf-value ${cls}">${esc(text)}</span>${action}</div>`;
  });
  // one grid around the rows, so the key column sizes to the widest key
  // in this allocation instead of the built-in fixed width
  return `<div class="cf-head"><span>trace fields</span></div>`
    + `<div class="cf-list">${rows.join('')}</div>`;
}
