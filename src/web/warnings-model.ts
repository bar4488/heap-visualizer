// The Warnings panel's pure logic: warnings grouped by the domain that raised
// them (MODEL-005, IVL-006). The engine names each warning's domain and kind;
// the table below is only the fallback for an older core that does not, and
// the source of per-domain totals from `warnCounts` (indexed by code), which
// stay exact when the warning list itself is capped.

/** Engine JSON: one warning, as `hp_warnings_json` renders it. */
export type Warning = {
  seq: number; code: number; kind?: string; domain?: string; msg: string;
  detail?: number; detailExact?: string;
};

/** Each code's domain, by code (src/core/src/store.rs `warn_domain`). */
const CODE_DOMAIN = [
  'trace', 'trace', 'trace', 'heap', 'heap', 'heap', 'heap', 'heap', 'trace', 'log', 'log', 'trace',
  'interval', 'interval', 'interval', 'interval', 'interval', 'interval', 'interval', 'sched', 'trace',
];

/** Groups are listed in this order; a domain not named here sorts after. */
const DOMAIN_ORDER = ['trace', 'heap', 'log', 'interval', 'sched'];

export function warningDomain(w: Pick<Warning, 'code' | 'domain'>): string {
  return w.domain || CODE_DOMAIN[w.code] || 'trace';
}

/**
 * What a warning's `detail` means, where it means something (IVL-006): the
 * begin seq of an implicitly closed or unclosed interval, the CPU of a double
 * run, the byte length of a truncated name. Empty otherwise.
 */
export function warningDetail(w: Warning): string {
  const v = w.detailExact ?? (w.detail === undefined ? '' : String(w.detail));
  if (!v) return '';
  switch (w.code) {
    case 13: case 14: return `begin #${v}`;
    case 19: return `cpu ${v}`;
    case 20: return `${v} bytes`;
    default: return '';
  }
}

export type WarningGroup = { domain: string; total: number; rows: Warning[] };

/**
 * The warnings grouped by domain, in a fixed domain order. `total` is the
 * domain's count from `warnCounts` when given (exact past the list's cap),
 * else the rows listed.
 */
export function groupWarnings(warnings: Warning[], warnCounts?: number[] | null): WarningGroup[] {
  const groups = new Map<string, WarningGroup>();
  const group = (domain: string) => {
    let g = groups.get(domain);
    if (!g) { g = { domain, total: 0, rows: [] }; groups.set(domain, g); }
    return g;
  };
  // a code's domain as the listed warnings name it, so a code newer than the
  // table above still counts toward the domain its rows are listed under
  const codeDomain = new Map<number, string>();
  for (const w of warnings) {
    const domain = warningDomain(w);
    codeDomain.set(w.code, domain);
    group(domain).rows.push(w);
  }
  if (warnCounts) {
    for (const g of groups.values()) g.total = 0;
    warnCounts.forEach((n, code) => {
      if (n > 0) group(codeDomain.get(code) || CODE_DOMAIN[code] || 'trace').total += n;
    });
  } else {
    for (const g of groups.values()) g.total = g.rows.length;
  }
  const rank = (d: string) => { const i = DOMAIN_ORDER.indexOf(d); return i < 0 ? DOMAIN_ORDER.length : i; };
  return [...groups.values()].sort((a, b) => rank(a.domain) - rank(b.domain) || a.domain.localeCompare(b.domain));
}
