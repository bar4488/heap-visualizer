// The Events (stream) panel's pure logic: what a row of the engine's event
// list is, how it reads, and how a list with some domains left out maps list
// positions to spine records. The DOM half is stream/events-panel.ts; the
// worker imports the index math from here too, so both sides agree on it.
//
// A row is the engine's Events-list JSON (`hp_events_json`). Three shapes
// arrive, and none is told apart by comparing op numbers beyond the ones the
// engine gives bespoke rows:
//
//   heap (op 0–2)  {seq, op, t, id, e, addr, size, site, …}
//   marks (op 3)   {seq, op, t, e:null, title, thr, extra?}
//   logs  (op 4)   {seq, op, t, e:null, level, logger, msg, thr, extra?}
//   any other      the generic record summary plus `op` and `e:null`:
//                  {seq, op, t, e:null, thr, pid?, domain, kind, title,
//                   level?, source?, fields}       (DOM-004)
//
// A domain added to the core shows up through the last shape: its kind label
// and description come from its descriptor's `kinds`, its title and source
// from the summary. The wire letters (M, F, B, …) are never shown: a row reads
// `alloc`, `free`, `call ▸`, `switch`, a log level, … (NAV-005).

import { esc, fmtNum } from '../fmt.ts';
import { levelBadge, levelIndex } from '../logs/logs-model.ts';
import type { DomainDescriptor, EventRow } from '../protocol.ts';

/** The rows the engine renders bespoke, by op: their domain and kind. */
const BESPOKE: { domain: string; kind: string }[] = [
  { domain: 'heap', kind: 'malloc' },
  { domain: 'heap', kind: 'free' },
  { domain: 'heap', kind: 'realloc' },
  { domain: 'marks', kind: 'event' },
  { domain: 'logs', kind: 'log' },
];

/** The domain a row belongs to: its summary's, else the bespoke row's. */
export function rowDomain(ev: EventRow): string {
  if (typeof ev.domain === 'string') return ev.domain;
  return BESPOKE[ev.op]?.domain ?? 'unknown';
}

/** The kind name of a row's record (`malloc`, `begin`, …): the summary's, else the bespoke row's. */
export function rowKind(ev: EventRow): string {
  if (typeof ev.domain === 'string') return typeof ev.kind === 'string' && ev.kind ? ev.kind : 'record';
  return BESPOKE[ev.op]?.kind ?? 'record';
}

// ---------------------------------------------------------------------------
// kind labels

type KindText = { label: string; description: string };

/**
 * What the UI calls each kind when a descriptor does not say (an older core):
 * the same words the core's descriptors carry. `domain:kind`, and
 * `domain:kind:source` where the summary's source refines it.
 */
const DEFAULT_KINDS: Record<string, KindText> = {
  'heap:malloc': { label: 'alloc', description: 'Allocation' },
  'heap:free': { label: 'free', description: 'Free' },
  'heap:realloc': { label: 'realloc', description: 'Reallocation' },
  'marks:event': { label: 'mark', description: 'Mark' },
  'logs:log': { label: 'log', description: 'Log line' },
  'intervals:begin': { label: 'begin', description: 'Interval begins' },
  'intervals:end': { label: 'end', description: 'Interval ends' },
  'intervals:switch': { label: 'switch', description: 'Context switch' },
  'intervals:begin:call': { label: 'call ▸', description: 'Function call begins' },
  'intervals:end:call': { label: 'ret ◂', description: 'Function call returns' },
  'intervals:begin:span': { label: 'span ▸', description: 'Span begins' },
  'intervals:end:span': { label: 'span ◂', description: 'Span ends' },
};

/** The widest label the fixed-width kind column holds. */
const KIND_WIDTH = 8;

export type KindInfo = {
  domain: string;
  kind: string;
  /** Short, at most KIND_WIDTH characters: `alloc`, `call ▸`, `switch`. */
  label: string;
  /** The kind in words: `Allocation`, `Function call begins`. */
  description: string;
  /** Whether the label already says what the summary's source does. */
  sourced: boolean;
};

/**
 * How a row's record type reads: its descriptor kind's `label` and
 * `description` (refined by `sources[source]` when the summary has one), else
 * the defaults above, else the kind name itself.
 */
export function kindInfo(ev: EventRow, domains: DomainDescriptor[] | null | undefined): KindInfo {
  const domain = rowDomain(ev);
  const kind = rowKind(ev);
  const source = typeof ev.source === 'string' ? ev.source : '';
  const k = domains?.find((x) => x.id === domain)?.kinds?.find((x) => x.kind === kind) as any;
  const bySource = source ? (k?.sources?.[source] ?? DEFAULT_KINDS[`${domain}:${kind}:${source}`]) : undefined;
  const base = DEFAULT_KINDS[`${domain}:${kind}`];
  const label = bySource?.label || k?.label || base?.label;
  const description = bySource?.description || k?.description || base?.description;
  return {
    domain,
    kind,
    label: (label || kind).slice(0, KIND_WIDTH),
    description: description || `${domain} ${kind} record`,
    sourced: !!label,
  };
}

/** A thread in words: `thread worker-2 (pid 4242)`, `thread 3`, or ''. */
export function threadPhrase(thr: number | null | undefined, pid: number | null | undefined, names?: ThreadNames): string {
  if (thr === null || thr === undefined) return pid === null || pid === undefined ? '' : `process ${pid}`;
  const name = names?.get(threadKey(thr, pid)) ?? names?.get(threadKey(thr));
  const p = pid === null || pid === undefined ? '' : ` (pid ${pid})`;
  return `thread ${name ?? thr}${p}`;
}

/**
 * A generic summary's title as the row's details: the kind label already says
 * the direction, so a leading `→`/`←` goes, and a switch reads `cpu 3 → main`.
 */
export function detailText(title: string | null | undefined): string {
  if (!title) return '';
  return title.replace(/^[→←]\s*/, '').replace(/\s*⇐\s*/, ' → ');
}

/** The kind cell's tooltip: the record in words. */
export function kindTooltip(ev: EventRow, ctx: Pick<RowContext, 'domains' | 'names' | 'fmtAllocSize'>): string {
  const k = kindInfo(ev, ctx.domains);
  const thr = threadPhrase(ev.thr, ev.pid, ctx.names);
  const on = thr ? ` on ${thr}` : '';
  if (typeof ev.domain !== 'string' && k.domain === 'heap') {
    const size = typeof ev.size === 'number' ? ` of ${ctx.fmtAllocSize(ev.size)}` : '';
    const at = ev.addr ? ` at ${ev.addr}` : '';
    const site = ev.site ? ` (site ${ev.site})` : '';
    return `${k.description}${size}${at}${site}${on}`;
  }
  if (typeof ev.domain !== 'string' && k.domain === 'logs') {
    const from = ev.logger ? ` from ${ev.logger}` : '';
    return `${k.description} at level ${levelBadge(ev.level).trim()}${from}${on}`;
  }
  const what = detailText(ev.title);
  return `${k.description}${on}${what ? `: ${what}` : ''}`;
}

/** The kind cell: a fixed-width label, tinted by domain, explained on hover. */
function kindCell(ev: EventRow, ctx: RowContext, text?: string, extra = ''): string {
  const k = kindInfo(ev, ctx.domains);
  const cls = `ev-kind k-${esc(k.kind)}${extra}`;
  return `<span class="${cls}" title="${esc(kindTooltip(ev, ctx))}">${esc(text ?? k.label)}</span>`;
}

// ---------------------------------------------------------------------------
// threads

/** `pid/thr` → a thread's name, for the threads a domain names (v2 traces). */
export type ThreadNames = Map<string, string>;

const threadKey = (thr: number, pid?: number | null) => `${pid ?? ''}/${thr}`;

/**
 * Thread names from the descriptors: the interval domain lists its tracks
 * (`tracks.threads: [{thr, pid?, name}]`). The core's placeholder label
 * (`thread 3`) is not a name and is left out.
 */
export function threadNames(domains: DomainDescriptor[] | null | undefined): ThreadNames {
  const names: ThreadNames = new Map();
  for (const d of domains || []) {
    for (const t of d.tracks?.threads || []) {
      if (typeof t?.thr !== 'number' || typeof t.name !== 'string') continue;
      if (!t.name || t.name === `thread ${t.thr}`) continue;
      names.set(threadKey(t.thr, t.pid), t.name);
    }
  }
  return names;
}

/** `3`, `7/3` with a process, and the thread's name after it when it has one. */
export function threadLabel(thr: number | null | undefined, pid: number | null | undefined, names?: ThreadNames): string {
  if (thr === null || thr === undefined) return pid === null || pid === undefined ? '' : `${pid}/–`;
  const id = pid === null || pid === undefined ? `${thr}` : `${pid}/${thr}`;
  const name = names?.get(threadKey(thr, pid)) ?? names?.get(threadKey(thr));
  return name ? `${id} ${name}` : id;
}

// ---------------------------------------------------------------------------
// rows

export type RowContext = {
  domains: DomainDescriptor[] | null | undefined;
  names?: ThreadNames;
  fmtAllocSize: (bytes: number) => string;
  /** seq of the current event (the playhead's last applied record), or -1. */
  curSeq: number;
};

/** One row's markup. Data attributes say what a click on it means. */
export function renderRow(ev: EventRow, ctx: RowContext): string {
  const cur = ev.seq === ctx.curSeq ? ' cur' : '';
  const domain = rowDomain(ev);
  const seq = `<span class="ev-seq">${fmtNum(ev.seq)}</span>`;
  const thr = threadLabel(ev.thr, ev.pid, ctx.names);
  const thrSpan = thr ? `<span class="ev-thr">${esc(thr)}</span>` : '';
  const attrs = `data-seq="${ev.seq}" data-domain="${esc(domain)}"`;
  // a log line: its level as the kind, then its message, in place of
  // geometry (LOG-006)
  if (typeof ev.domain !== 'string' && domain === 'logs') {
    return `<div class="ev-row ev-log lv-${levelIndex(ev.level)}${cur}" ${attrs} data-log="1" title="click: seek here and show this line in Logs">`
      + `${seq}${kindCell(ev, ctx, levelBadge(ev.level).trim(), ' ev-lv')}${thrSpan}<span class="ev-msg">${esc(ev.msg ?? '')}</span></div>`;
  }
  // a custom event has no geometry to show: its label takes the width of the
  // address, size and site columns together (TRACE-010)
  if (typeof ev.domain !== 'string' && domain === 'marks') {
    return `<div class="ev-row ev-custom${cur}" ${attrs} data-custom="1" title="click: seek here and open this mark">`
      + `${seq}${kindCell(ev, ctx)}${thrSpan}<span class="ev-label">${ev.title ? esc(ev.title) : '<span class="dim">untitled</span>'}</span></div>`;
  }
  // any other domain's record: its generic summary — details, then the
  // source when the kind label does not already say it
  if (domain !== 'heap') {
    const k = kindInfo(ev, ctx.domains);
    const what = detailText(ev.title);
    const title = what ? esc(what) : `<span class="dim">${esc(k.kind)}</span>`;
    const source = ev.source && !k.sourced ? `<span class="ev-src">${esc(ev.source)}</span>` : '';
    return `<div class="ev-row ev-generic d-${esc(domain)}${cur}" ${attrs} data-custom="1" title="click: seek here">`
      + `${seq}${kindCell(ev, ctx)}${thrSpan}<span class="ev-label">${title}</span>${source}</div>`;
  }
  return `<div class="ev-row${cur}" ${attrs} title="click: seek here and select the allocation">`
    + `${seq}${kindCell(ev, ctx)}<span class="ev-addr">${esc(ev.addr ?? '')}</span>`
    + `<span class="ev-size">${ctx.fmtAllocSize(ev.size)}</span>`
    + `<span class="ev-site">${ev.site ? esc(ev.site) : ''}</span></div>`;
}

/**
 * The status-line text for a stepped-onto record of a non-heap domain, in
 * the Events list's words: `call ▸ handle_upload · thread worker-1 (pid 7) · seq 9`.
 */
export function genericStatusText(ev: EventRow, domains?: DomainDescriptor[] | null, names?: ThreadNames): string {
  const k = kindInfo(ev, domains);
  const what = detailText(ev.title);
  const parts = [what ? `${k.label} ${what}` : k.label];
  const thr = threadPhrase(ev.thr, ev.pid, names);
  if (thr) parts.push(thr);
  parts.push(`seq ${fmtNum(ev.seq)}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// domain toggles

export type DomainChip = { id: string; name: string; count: number };

/** One chip per domain the trace has records of, in registry order. */
export function domainChips(domains: DomainDescriptor[] | null | undefined): DomainChip[] {
  return (domains || []).filter((d) => d.count > 0).map((d) => ({ id: d.id, name: d.name || d.id, count: d.count }));
}

/**
 * The domains the list includes, for the `events` query: undefined when
 * nothing is excluded, so the engine's identity list is used at no cost.
 */
export function includedDomains(chips: DomainChip[], excluded: ReadonlySet<string>): string[] | undefined {
  if (!chips.some((c) => excluded.has(c.id))) return undefined;
  return chips.filter((c) => !excluded.has(c.id)).map((c) => c.id);
}

// ---------------------------------------------------------------------------
// the list with domains left out
//
// The list is virtualized by position, so leaving a domain out needs a map
// from position to seq that does not scan the trace. Each domain answers
// "how many of my records are at or before seq" with its locate (its rows
// are its records: heap and point domains). A domain whose query is over
// something other than its records — the interval domain's is over intervals,
// its records are edges — cannot; it is counted as the residual: every
// record no other domain claims. At most one domain can be the residual.

export type MaskPlan = {
  /** Records the list holds. */
  total: number;
  /** Domains counted directly, added. */
  add: string[];
  /** Domains counted directly, subtracted from `seq + 1` (residual included). */
  sub: string[];
  /** Whether the count is `seq + 1 − Σ sub` rather than `Σ add`. */
  residual: boolean;
};

const countsByLocate = (d: DomainDescriptor) => d.shape !== 'interval';

/**
 * The plan for a list including `included`, or null when the list is the
 * whole spine (nothing with records is left out) or the descriptors cannot
 * support it (two residual domains).
 */
export function maskPlan(domains: DomainDescriptor[] | null | undefined, included: string[] | undefined): MaskPlan | null {
  if (!included || !domains) return null;
  const present = domains.filter((d) => d.count > 0);
  const inc = present.filter((d) => included.includes(d.id));
  if (inc.length === present.length) return null;
  const residuals = present.filter((d) => !countsByLocate(d));
  if (residuals.length > 1) return null;
  const total = inc.reduce((n, d) => n + d.count, 0);
  const residualIn = residuals.length === 1 && included.includes(residuals[0].id);
  if (residualIn) {
    return { total, add: [], sub: present.filter((d) => !included.includes(d.id)).map((d) => d.id), residual: true };
  }
  return { total, add: inc.map((d) => d.id), sub: [], residual: false };
}

/** Records the list holds at or before `seq` (0 for seq < 0). */
export function maskRank(plan: MaskPlan, seq: number, rankOf: (domain: string, seq: number) => number): number {
  if (seq < 0) return 0;
  if (plan.residual) {
    let n = seq + 1;
    for (const d of plan.sub) n -= rankOf(d, seq);
    return n;
  }
  let n = 0;
  for (const d of plan.add) n += rankOf(d, seq);
  return n;
}

/** The seq of list position `k` (0-based), or `n` when past the end. */
export function maskSeqAt(plan: MaskPlan, k: number, n: number, rankOf: (domain: string, seq: number) => number): number {
  if (k >= plan.total) return n;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (maskRank(plan, mid, rankOf) >= k + 1) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
