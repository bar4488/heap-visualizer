#!/usr/bin/env python3
"""gen.py - synthetic heap-event stream generator for heap-visualizer.

Emits a JSONL (.heapl) stream of malloc/free/realloc events conforming to
spec/02-trace-format.md v1. It simulates a free-list allocator serving a workload made
of allocation "sites" (each with a characteristic size range and lifetime) and
sprinkles in same-timestamp bursts so the temporal and sequential timelines in
the viewer visibly diverge.

Deterministic: identical --seed and args produce byte-identical output.
Only the Python standard library is used.

Examples
--------
    python3 gen.py --seed 1 --ops 50000 --out trace.heapl
    python3 gen.py --ops 2000 | head
    python3 gen.py --ops 100000 --threads 4 --burst-prob 0.05 --leak-rate 0.03
"""

from __future__ import annotations

import argparse
import heapq
import json
import random
import sys
from dataclasses import dataclass, field

FORMAT_VERSION = 1
NULL_ID = 0            # reserved; never assigned to a real allocation
ALIGN = 16            # allocations are aligned to this many bytes

# ---------------------------------------------------------------------------
# Allocation sites: a workload profile.
#
# Each site models a place in a program that allocates memory, with a
# characteristic size distribution (log-uniform between size_min..size_max),
# a lifetime distribution (ns), a relative frequency weight, and a per-site
# leak bias multiplier.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Site:
    name: str
    size_min: int
    size_max: int
    life_min: int      # lifetime lower bound, in ns
    life_max: int      # lifetime upper bound, in ns
    weight: float      # relative selection frequency
    leak_bias: float = 1.0  # multiplies the global leak rate for this site


SITES: list[Site] = [
    #        name             size range        lifetime (ns) range    weight  leak
    Site("temp_string",       8,     128,        50,        5_000,      6.0),
    Site("json_node",         16,    96,         2_000,     200_000,    5.0),
    Site("request_buf",       128,   2_048,      10_000,    2_000_000,  3.0),
    Site("vector_backing",    64,    16_384,     5_000,     5_000_000,  2.0),
    Site("image_tile",        4_096, 65_536,     100_000,   20_000_000, 1.2),
    Site("connection",        256,   1_024,      1_000_000, 60_000_000, 0.8),
    Site("cache_entry",       128,   4_096,      5_000_000, 80_000_000, 1.0, leak_bias=4.0),
    Site("global_singleton",  32,    512,        0,         0,          0.15, leak_bias=50.0),
]


# Custom-field string values chosen to be awkward to render: markup, quotes,
# a backslash, an em dash, non-ASCII, and the empty string. A viewer that
# escapes correctly shows these literally.
LABELS: list[str] = [
    '<b>hot</b> path',
    'name="req" & id=\'7\'',
    'C:\\temp\\arena\\block',
    'ünïcode — ✓ 熱い',
    '',
]


def _log_uniform(rng: random.Random, lo: int, hi: int) -> int:
    """Integer drawn log-uniformly in [lo, hi] (small sizes are common)."""
    if lo >= hi:
        return lo
    import math
    x = math.exp(rng.uniform(math.log(lo), math.log(hi)))
    return max(lo, min(hi, int(x)))


def _align_up(n: int, a: int = ALIGN) -> int:
    return (n + a - 1) & ~(a - 1)


# ---------------------------------------------------------------------------
# Free-list allocator model.
#
# Produces plausible addresses with realistic reuse and fragmentation: a
# best-fit search over coalesced free blocks, falling back to bumping the top
# of a growable arena. This is what makes the address-line picture interesting
# (holes, reuse, growth) rather than a monotonic ramp.
# ---------------------------------------------------------------------------


class Allocator:
    def __init__(self, base: int):
        self.base = base
        self.top = base                       # bump pointer for fresh memory
        self.free_blocks: list[list[int]] = []  # sorted [start, size] runs

    def alloc(self, size: int) -> int:
        size = _align_up(size)
        # best-fit over the free list
        best_i = -1
        best_size = None
        for i, (_, bsize) in enumerate(self.free_blocks):
            if bsize >= size and (best_size is None or bsize < best_size):
                best_i, best_size = i, bsize
        if best_i >= 0:
            start, bsize = self.free_blocks[best_i]
            if bsize == size:
                self.free_blocks.pop(best_i)
            else:
                self.free_blocks[best_i] = [start + size, bsize - size]
            return start
        # no fit: bump the arena top
        addr = self.top
        self.top += size
        return addr

    def free(self, start: int, size: int) -> None:
        size = _align_up(size)
        # insert sorted, then coalesce with neighbours
        blocks = self.free_blocks
        lo, hi = 0, len(blocks)
        while lo < hi:                        # bisect on start
            mid = (lo + hi) // 2
            if blocks[mid][0] < start:
                lo = mid + 1
            else:
                hi = mid
        blocks.insert(lo, [start, size])
        i = lo
        # coalesce with previous
        if i > 0 and blocks[i - 1][0] + blocks[i - 1][1] == blocks[i][0]:
            blocks[i - 1][1] += blocks[i][1]
            blocks.pop(i)
            i -= 1
        # coalesce with next
        if i + 1 < len(blocks) and blocks[i][0] + blocks[i][1] == blocks[i + 1][0]:
            blocks[i][1] += blocks[i + 1][1]
            blocks.pop(i + 1)


# ---------------------------------------------------------------------------
# Live allocation bookkeeping.
# ---------------------------------------------------------------------------


@dataclass
class Live:
    id: int
    addr: int
    size: int
    thr: int
    site: str
    free_t: int | None      # scheduled free time, or None if it leaks


# ---------------------------------------------------------------------------
# Generator.
# ---------------------------------------------------------------------------


class Generator:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.rng = random.Random(args.seed)
        self.alloc = Allocator(args.arena_base)
        self.live: dict[int, Live] = {}
        # shuffled reservoir of live ids for realloc victim selection
        self._live_pool: list[int] = []
        # min-heap of (free_t, id) for allocations with a scheduled death
        self.pending: list[tuple[int, int]] = []
        self.next_id = 1
        self.seq = 0
        self.t = 0
        # burst state: when >0 we are inside a same-timestamp burst
        self.burst_left = 0
        # site selection weights
        self._site_weights = [s.weight for s in SITES]
        # stats
        self.n_malloc = self.n_free = self.n_realloc = self.n_leak = 0
        self.peak_live_bytes = 0
        self._cur_live_bytes = 0
        self.min_addr = args.arena_base
        self.max_addr = args.arena_base

    # -- id / time helpers --------------------------------------------------

    def _alloc_id(self) -> int:
        i = self.next_id
        self.next_id += 1
        return i

    def _advance_time(self) -> None:
        """Advance self.t. Inside a burst, do not advance (same timestamp)."""
        if self.burst_left > 0:
            self.burst_left -= 1
            # tiny jitter, mostly zero, so the burst shares one t
            self.t += self.rng.choice([0, 0, 0, 1])
            return
        # maybe start a new burst
        if self.rng.random() < self.args.burst_prob:
            self.burst_left = self.rng.randint(20, 200)
            return
        # normal inter-arrival gap: exponential-ish, integer ns
        gap = int(self.rng.expovariate(1.0 / self.args.mean_gap)) + 1
        self.t += gap

    def _pick_site(self) -> Site:
        return self.rng.choices(SITES, weights=self._site_weights, k=1)[0]

    def _pick_live_id(self) -> int:
        """A random live id, without materializing the whole live dict.

        `rng.choice(list(self.live))` is O(live) per realloc, which makes
        generating multi-million-event traces with a high realloc rate
        quadratic. Sampling from a reservoir of ids that is refilled in bulk
        keeps it amortized O(1); ids that died in the meantime are skipped.
        """
        while True:
            while self._live_pool:
                aid = self._live_pool.pop()
                if aid in self.live:
                    return aid
            self._live_pool = list(self.live)
            self.rng.shuffle(self._live_pool)

    # -- emission -----------------------------------------------------------

    def _emit(self, out, rec: dict) -> None:
        rec["seq"] = self.seq
        self.seq += 1
        out.write(json.dumps(rec, separators=(",", ":")))
        out.write("\n")

    def _hexaddr(self, a: int) -> str:
        return "0x%x" % a

    def _note_addr(self, addr: int, size: int) -> None:
        self.min_addr = min(self.min_addr, addr)
        self.max_addr = max(self.max_addr, addr + size)

    # -- core actions -------------------------------------------------------

    # -- custom trace fields ------------------------------------------------

    def _extra_alloc(self, site_name: str, size: int, thr: int) -> dict:
        """Caller-defined fields on an allocation record (--fields).

        Deliberately varied in shape, because the point of the flag is to
        exercise what the viewer does with producer data. One case per thing
        the allocation panel or the field catalog treats differently:

        `pool`, `refcount`      a plain string and a plain integer
        `allocator-class`       a key that is not identifier-shaped
        `owner`                 present on most records, JSON null on some
        `hot`                   a boolean
        `fill-ratio`            a float, which is not one of the three
                                catalogued scalar types
        `retries`               absent from most records, rather than null
        `label`                 markup, quotes and non-ASCII, to test escaping
        `origin`                long enough to test the panel's value column
        `revision`              an integer on some records, a string on others
        `debug`, `chunks`       a nested object and an array, neither of which
                                the filter language can address
        """
        pool = "large" if size >= 4096 else ("small" if size < 256 else "medium")
        extra: dict = {
            "pool": pool,
            "refcount": self.rng.randint(1, 8),
            "allocator-class": "slab" if size < 256 else "bump",
        }
        # present on most records, null on some: an optional field
        extra["owner"] = None if self.rng.random() < 0.2 else f"worker-{thr}"
        extra["hot"] = self.rng.random() < 0.3
        extra["fill-ratio"] = round(self.rng.uniform(0.05, 0.99), 3)
        # absent, not null: the other way a field is optional
        if self.rng.random() < 0.25:
            extra["retries"] = self.rng.randint(1, 3)
        if self.rng.random() < 0.2:
            extra["label"] = self.rng.choice(LABELS)
        if self.rng.random() < 0.1:
            extra["origin"] = (
                f"/build/src/runtime/{site_name}/pool/"
                f"{pool}/allocate_aligned_with_fallback.cpp:{self.rng.randint(60, 900)}"
            )
        # the same key holding two types across the trace: the catalog must
        # refuse to type it, and say so
        if self.rng.random() < 0.3:
            extra["revision"] = (
                self.rng.randint(1, 40) if self.rng.random() < 0.5
                else f"r{self.rng.randint(1, 40)}"
            )
        if self.rng.random() < 0.15:
            extra["debug"] = {"site": site_name, "hint": [size, thr]}
        if self.rng.random() < 0.12:
            extra["chunks"] = [self.rng.randint(1, 64) for _ in range(self.rng.randint(2, 4))]
        return extra

    def _extra_free(self) -> dict:
        return {
            "reason": self.rng.choice(["scope", "explicit", "shutdown"]),
            "drained": self.rng.random() < 0.5,
        }

    def _extra_realloc(self, site_name: str, size: int, thr: int, grew: bool) -> dict:
        """Fields on a realloc record: the allocation fields, plus how it grew.

        A realloc record describes a new allocation, so the panel shows these
        the same way it shows a malloc's.
        """
        extra = self._extra_alloc(site_name, size, thr)
        extra["grew"] = grew
        return extra

    def _do_malloc(self, out) -> None:
        site = self._pick_site()
        size = _log_uniform(self.rng, site.size_min, site.size_max)
        thr = self.rng.randrange(self.args.threads)
        addr = self.alloc.alloc(size)
        aid = self._alloc_id()

        leaks = self.rng.random() < (self.args.leak_rate * site.leak_bias)
        if leaks or site.life_max == 0:
            free_t = None
        else:
            life = self.rng.randint(site.life_min, site.life_max)
            free_t = self.t + life
            heapq.heappush(self.pending, (free_t, aid))

        self.live[aid] = Live(aid, addr, size, thr, site.name, free_t)
        self._cur_live_bytes += size
        self.peak_live_bytes = max(self.peak_live_bytes, self._cur_live_bytes)
        self._note_addr(addr, size)
        self.n_malloc += 1

        rec = {
            "t": self.t, "op": "M", "id": aid,
            "addr": self._hexaddr(addr), "size": size,
            "thr": thr, "site": site.name,
        }
        if self.args.fields:
            rec.update(self._extra_alloc(site.name, size, thr))
        self._emit(out, rec)

    def _do_free(self, out, aid: int) -> None:
        a = self.live.pop(aid, None)
        if a is None:
            return  # already freed (e.g. via realloc); skip
        self.alloc.free(a.addr, a.size)
        self._cur_live_bytes -= a.size
        self.n_free += 1
        rec = {
            "t": self.t, "op": "F", "id": aid,
            "addr": self._hexaddr(a.addr), "size": a.size, "thr": a.thr,
        }
        if self.args.fields:
            rec.update(self._extra_free())
        self._emit(out, rec)

    def _do_realloc(self, out) -> None:
        if not self.live:
            self._do_malloc(out)
            return
        old_id = self._pick_live_id()
        old = self.live.pop(old_id)
        # free the old region, then allocate the new one
        self.alloc.free(old.addr, old.size)
        self._cur_live_bytes -= old.size

        # new size: grow or shrink around the old size
        factor = self.rng.choice([0.5, 1.5, 2.0, 4.0])
        new_size = max(ALIGN, int(old.size * factor))
        new_addr = self.alloc.alloc(new_size)
        new_id = self._alloc_id()

        # inherit the old allocation's scheduled death (approximately)
        free_t = old.free_t
        if free_t is not None:
            heapq.heappush(self.pending, (free_t, new_id))

        self.live[new_id] = Live(new_id, new_addr, new_size, old.thr, old.site, free_t)
        self._cur_live_bytes += new_size
        self.peak_live_bytes = max(self.peak_live_bytes, self._cur_live_bytes)
        self._note_addr(new_addr, new_size)
        self.n_realloc += 1

        rec = {
            "t": self.t, "op": "R", "id": new_id, "old_id": old_id,
            "addr": self._hexaddr(new_addr), "size": new_size,
            "old_addr": self._hexaddr(old.addr), "old_size": old.size,
            "thr": old.thr, "site": old.site,
        }
        if self.args.fields:
            rec.update(self._extra_realloc(old.site, new_size, old.thr,
                                           new_size > old.size))
        self._emit(out, rec)

    def _drain_due_frees(self, out) -> None:
        """Emit every scheduled free whose time has arrived."""
        while self.pending and self.pending[0][0] <= self.t:
            _, aid = heapq.heappop(self.pending)
            if aid in self.live:            # may have been reallocated away
                self._do_free(out, aid)

    # -- driver -------------------------------------------------------------

    def run(self, out) -> None:
        args = self.args
        self._emit_header(out)

        for _ in range(args.ops):
            self._advance_time()
            self._drain_due_frees(out)
            if self.rng.random() < args.realloc_rate:
                self._do_realloc(out)
            else:
                self._do_malloc(out)

        # flush all remaining scheduled frees in time order
        while self.pending:
            free_t, aid = heapq.heappop(self.pending)
            if aid in self.live:
                self.t = max(self.t, free_t)
                self._do_free(out, aid)

        self.n_leak = len(self.live)

    def _emit_header(self, out) -> None:
        header = {
            "op": "H",
            "v": FORMAT_VERSION,
            "unit": self.args.unit,
            "arena_base": self._hexaddr(self.args.arena_base),
            "row_bytes": self.args.row_bytes,
            "title": "seed=%d ops=%d" % (self.args.seed, self.args.ops),
            "meta": {
                "generator": "gen.py",
                "threads": self.args.threads,
                "sites": [s.name for s in SITES],
            },
        }
        # the header carries no seq: per TRACE-007 in spec/02-trace-format.md, seq
        # is the 0-based index among *event* records (header and comments
        # excluded)
        out.write(json.dumps(header, separators=(",", ":")))
        out.write("\n")

    # -- reporting ----------------------------------------------------------

    def summary(self) -> str:
        span = self.max_addr - self.min_addr
        return (
            "heap-visualizer gen.py summary\n"
            "  events        : %d (M=%d F=%d R=%d)\n"
            "  leaked allocs : %d (%d bytes still live at end)\n"
            "  peak live     : %d bytes (%.2f MiB)\n"
            "  address span  : %s .. %s (%d bytes, %.2f MiB)\n"
            "  final t       : %d %s\n"
            % (
                self.seq,
                self.n_malloc, self.n_free, self.n_realloc,
                self.n_leak, self._cur_live_bytes,
                self.peak_live_bytes, self.peak_live_bytes / (1 << 20),
                self._hexaddr(self.min_addr), self._hexaddr(self.max_addr),
                span, span / (1 << 20),
                self.t, self.args.unit,
            )
        )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _int_auto(s: str) -> int:
    """Parse an int in decimal or 0x-hex."""
    return int(s, 0)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Generate a synthetic heap-visualizer .heapl (JSONL) event stream.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--seed", type=int, default=0,
                   help="RNG seed; same seed+args => identical output")
    p.add_argument("--ops", type=int, default=10_000,
                   help="number of allocation operations to generate")
    p.add_argument("--out", default="-",
                   help="output path, or '-' for stdout")
    p.add_argument("--row-bytes", type=_int_auto, default=0x1000, dest="row_bytes",
                   help="row_bytes hint written to the header")
    p.add_argument("--arena-base", type=_int_auto, default=0x555555550000,
                   dest="arena_base", help="base address of the simulated arena")
    p.add_argument("--threads", type=int, default=1,
                   help="number of simulated threads")
    p.add_argument("--mean-gap", type=int, default=500, dest="mean_gap",
                   help="mean inter-event time gap outside bursts, in time units")
    p.add_argument("--burst-prob", type=float, default=0.02, dest="burst_prob",
                   help="probability per step of entering a same-timestamp burst")
    p.add_argument("--leak-rate", type=float, default=0.02, dest="leak_rate",
                   help="baseline fraction of allocations never freed")
    p.add_argument("--realloc-rate", type=float, default=0.05, dest="realloc_rate",
                   help="fraction of steps that realloc instead of malloc")
    p.add_argument("--unit", default="ns", choices=["ns", "us", "ms", "s", "tick"],
                   help="time unit written to the header")
    p.add_argument("--fields", action="store_true",
                   help="attach caller-defined custom fields to records: one "
                        "case per value shape and catalog outcome a viewer "
                        "distinguishes (see Generator._extra_alloc)")
    p.add_argument("--quiet", action="store_true",
                   help="suppress the stderr summary")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    gen = Generator(args)
    if args.out == "-":
        gen.run(sys.stdout)
        out_ok = True
    else:
        with open(args.out, "w", encoding="utf-8") as fh:
            gen.run(fh)
        out_ok = True
    if not args.quiet:
        sys.stderr.write(gen.summary())
    return 0 if out_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
