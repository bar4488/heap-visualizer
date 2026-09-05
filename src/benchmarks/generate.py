#!/usr/bin/env python3
"""Generate deterministic agent-analysis benchmark traces and ground truth."""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = ROOT / "benchmarks" / "agent"
SUITE_VERSION = 2


@dataclass
class Allocation:
    id: int
    creator: int
    size: int
    addr: int
    site: str
    thread: int
    fields: dict[str, Any]
    death: int | None = None


class Trace:
    def __init__(self, case_id: str, *, version: int = 1):
        self.case_id = case_id
        self.header = {
            "op": "H", "v": version, "unit": "ns", "arena_base": "0x10000000",
            "row_bytes": 4096, "title": f"agent benchmark: {case_id}",
            "meta": {"generator": "src/benchmarks/generate.py", "suite": SUITE_VERSION},
        }
        self.lines: list[str] = []
        self.events: list[dict[str, Any]] = []
        self.allocations: list[Allocation] = []
        self.live: dict[int, Allocation] = {}
        self.next_id = 1
        self.next_addr = 0x10000000
        self.time = 0
        self.live_bytes = 0
        self.peak_live_bytes = 0
        self.peak_events_applied = 0
        self.total_allocated = 0

    def _event(self, op: str, *, t: int | None = None, declared_seq: int | None = None,
               **values: Any) -> int:
        if t is None:
            t = self.time + 1
        self.time = t
        seq = len(self.events)
        record = {"seq": seq if declared_seq is None else declared_seq, "t": t, "op": op}
        record.update(values)
        self.events.append(record)
        self.lines.append(json.dumps(record, separators=(",", ":"), ensure_ascii=False))
        return seq

    def landmark(self, title: str, **fields: Any) -> int:
        return self._event("E", title=title, **fields)

    def malformed(self, text: str = "this is not json") -> None:
        self.lines.append(text)

    def alloc(self, size: int, site: str, thread: int, *, fields: dict[str, Any] | None = None,
              t: int | None = None, allocation_id: int | None = None,
              addr: int | None = None, declared_seq: int | None = None) -> Allocation:
        allocation_id = self.next_id if allocation_id is None else allocation_id
        self.next_id = max(self.next_id, allocation_id + 1)
        if addr is None:
            addr = self.next_addr
            self.next_addr += ((max(size, 1) + 15) // 16) * 16 + 16
        fields = dict(fields or {})
        seq = self._event("M", t=t, declared_seq=declared_seq, id=allocation_id,
                          addr=f"0x{addr:x}", size=size, thr=thread, site=site, **fields)
        allocation = Allocation(allocation_id, seq, size, addr, site, thread, fields)
        self.allocations.append(allocation)
        self.live[allocation_id] = allocation
        self.live_bytes += size
        self.total_allocated += size
        if self.live_bytes > self.peak_live_bytes:
            self.peak_live_bytes = self.live_bytes
            self.peak_events_applied = seq + 1
        return allocation

    def free(self, allocation: Allocation, *, fields: dict[str, Any] | None = None,
             t: int | None = None) -> int:
        seq = self._event("F", t=t, id=allocation.id, addr=f"0x{allocation.addr:x}",
                          size=allocation.size, thr=allocation.thread, **(fields or {}))
        if allocation.death is None:
            allocation.death = seq
            if self.live.get(allocation.id) is allocation:
                self.live.pop(allocation.id)
                self.live_bytes -= allocation.size
        return seq

    def realloc(self, allocation: Allocation, size: int, *, fields: dict[str, Any] | None = None,
                t: int | None = None, addr: int | None = None) -> Allocation:
        new_id = self.next_id
        self.next_id += 1
        if addr is None:
            addr = self.next_addr
            self.next_addr += ((size + 15) // 16) * 16 + 16
        merged = dict(allocation.fields)
        merged.update(fields or {})
        seq = self._event("R", t=t, id=new_id, old_id=allocation.id,
                          addr=f"0x{addr:x}", size=size,
                          old_addr=f"0x{allocation.addr:x}", old_size=allocation.size,
                          thr=allocation.thread, site=allocation.site, **merged)
        allocation.death = seq
        if self.live.get(allocation.id) is allocation:
            self.live.pop(allocation.id)
            self.live_bytes -= allocation.size
        new = Allocation(new_id, seq, size, addr, allocation.site, allocation.thread, merged)
        self.allocations.append(new)
        self.live[new_id] = new
        self.live_bytes += size
        self.total_allocated += size
        if self.live_bytes > self.peak_live_bytes:
            self.peak_live_bytes = self.live_bytes
            self.peak_events_applied = seq + 1
        return new

    def bytes(self) -> bytes:
        header = json.dumps(self.header, separators=(",", ":"), ensure_ascii=False)
        return (header + "\n" + "\n".join(self.lines) + "\n").encode()

    def stats(self) -> dict[str, Any]:
        return {
            "events": len(self.events), "allocations": len(self.allocations),
            "liveAtEndCount": len([a for a in self.allocations if a.death is None]),
            "liveAtEndBytes": sum(a.size for a in self.allocations if a.death is None),
            "peakLiveBytes": self.peak_live_bytes,
            "peakEventsApplied": self.peak_events_applied,
            "totalAllocatedBytes": self.total_allocated,
        }


@dataclass
class Case:
    id: str
    title: str
    prompt: str
    answer_shape: list[str]
    trace: Trace
    explanation: str
    answer: dict[str, Any]
    evidence: list[dict[str, Any]]
    rubric: list[dict[str, Any]]
    category: str = "memory-analysis"
    difficulty: str = "medium"


def noise(trace: Trace, rng: random.Random, count: int, *, phase: str,
          sites: tuple[str, ...] = ("http_parse", "template_node", "log_record"),
          threads: int = 8) -> None:
    pending: list[Allocation] = []
    for index in range(count):
        size = rng.choice((48, 64, 96, 128, 192, 256, 512, 1024, 4096))
        allocation = trace.alloc(size, rng.choice(sites), rng.randrange(threads), fields={
            "phase": phase, "batch": index // 50, "class": rng.choice(("hot", "cold")),
        })
        pending.append(allocation)
        if len(pending) > 24:
            trace.free(pending.pop(0), fields={"reason": "complete"})
    for allocation in pending:
        trace.free(allocation, fields={"reason": "complete"})


def retained_cache_case() -> Case:
    trace = Trace("retained-cache-cohort")
    rng = random.Random(1101)
    trace.landmark("startup complete", stage="startup")
    singletons = [trace.alloc(4096, "runtime_singleton", 0, fields={"role": role, "region": "global"})
                  for role in ("metrics", "config", "scheduler")]
    noise(trace, rng, 700, phase="warmup")
    trace.landmark("steady traffic", stage="serving")
    noise(trace, rng, 900, phase="serving")
    suspects = [trace.alloc(65536 + (i % 3) * 4096, "cache_insert", i % 4, fields={
        "region": "eu-west", "generation": 17, "entryKind": "compiled-policy",
    }) for i in range(18)]
    distractors = [trace.alloc(262144, "image_decode", i % 6, fields={
        "region": "us-east", "generation": 17, "entryKind": "tile",
    }) for i in range(32)]
    for allocation in reversed(distractors):
        trace.free(allocation, fields={"reason": "frame-complete"})
    noise(trace, rng, 700, phase="serving")
    trace.landmark("shutdown complete", stage="shutdown")
    suspect_bytes = sum(a.size for a in suspects)
    prompt = """The service has completed shutdown but still retains more memory than its three documented runtime singletons. Identify the unintended retained cohort, quantify its allocation count and requested bytes, give its earliest creator event, and state the strongest common producer attributes that distinguish it from normal traffic. Support the conclusion with filters or endpoint evidence; do not label every live allocation as a leak."""
    return Case(
        "retained-cache-cohort", "Find a leak hidden behind legitimate process-lifetime state", prompt,
        ["unintended cohort", "allocation count", "requested bytes", "earliest creator", "distinguishing attributes", "evidence"], trace,
        "Filtering live-at-end allocations first leaves three legitimate runtime singletons and one coherent cache cohort. Grouping by site reveals cache_insert; its records all share region eu-west, generation 17, and entryKind compiled-policy. The much larger image allocations are fully freed and are not leaks.",
        {"site": "cache_insert", "count": 18, "requestedBytes": str(suspect_bytes),
         "earliestCreator": suspects[0].creator,
         "attributes": {"region": "eu-west", "generation": 17, "entryKind": "compiled-policy"},
         "excludedExpectedLive": {"site": "runtime_singleton", "count": len(singletons)}},
        [
            {"endpoint": "/api/v1/allocations/summarize", "body": {"filter": {"source": "not alloc.freed"}, "groupBy": "site", "limit": 20}, "expectGroup": {"key": "cache_insert", "allocations": 18, "requestedBytes": str(suspect_bytes)}},
            {"endpoint": "/api/v1/allocations/query", "body": {"filter": {"source": "not alloc.freed and malloc.site == \"cache_insert\""}, "orderBy": "creator-asc", "limit": 20}, "expect": {"matched.allocations": 18, "items.0.creator": suspects[0].creator}},
        ],
        [{"criterion": "Identifies cache_insert rather than image_decode or all live state", "points": 4},
         {"criterion": "Reports exact count, bytes, and earliest creator", "points": 3},
         {"criterion": "Finds all three common custom attributes", "points": 2},
         {"criterion": "Cites reproducible semantic evidence", "points": 1}],
    )


def transient_peak_case() -> Case:
    trace = Trace("transient-decompression-spike")
    rng = random.Random(2202)
    trace.landmark("warmup", stage="warmup")
    noise(trace, rng, 500, phase="warmup")
    singleton = trace.alloc(8192, "runtime_singleton", 0, fields={"role": "dictionary"})
    trace.landmark("snapshot import begins", stage="import", importId="imp-73")
    start_seq = len(trace.events)
    burst_t = trace.time + 100
    chunks = [trace.alloc(786432 + (i % 5) * 65536, "decompress_chunk", i % 8,
                          fields={"importId": "imp-73", "codec": "zstd", "chunk": i}, t=burst_t)
              for i in range(96)]
    peak = trace.peak_live_bytes
    peak_applied = trace.peak_events_applied
    trace.landmark("snapshot index build", stage="import", importId="imp-73")
    for allocation in chunks:
        trace.free(allocation, fields={"reason": "chunk-indexed"}, t=burst_t + 500)
    end_seq = len(trace.events)
    trace.landmark("snapshot import complete", stage="serving", importId="imp-73")
    noise(trace, rng, 600, phase="serving")
    prompt = """Operators saw a sharp memory spike during this trace, but the end-of-process leak check is nearly clean. Determine the operation and event/time window responsible, identify and quantify the dominant allocation cohort, report the global peak live bytes, and show whether the cohort is transient or retained. Explain why ranking only live-at-end allocations would miss the incident."""
    chunk_bytes = sum(a.size for a in chunks)
    return Case(
        "transient-decompression-spike", "Explain a severe transient peak without calling it a leak", prompt,
        ["responsible operation", "sequence/time window", "cohort count and bytes", "global peak", "retention conclusion", "evidence"], trace,
        "The import creates 96 zstd decompression chunks at one timestamp, then frees every one after the index build. They dominate the peak but contribute nothing to live-at-end state; the only retained allocation is the documented dictionary singleton.",
        {"site": "decompress_chunk", "operation": "snapshot import imp-73", "count": 96,
         "requestedBytes": str(chunk_bytes), "allFreed": True, "startSeq": start_seq,
         "endSeqExclusive": end_seq, "allocationTime": str(burst_t), "freeTime": str(burst_t + 500),
         "peakLiveBytes": str(peak), "peakEventsApplied": peak_applied,
         "liveAtEnd": {"site": singleton.site, "count": 1, "bytes": str(singleton.size)}},
        [
            {"endpoint": "/api/v1/timeline", "body": {"domain": "sequence", "range": {"from": start_seq, "to": end_seq}, "bins": 8}, "expectTotals": {"allocations": 96, "frees": 96}},
            {"endpoint": "/api/v1/allocations/query", "body": {"filter": {"source": "malloc.site == \"decompress_chunk\""}, "orderBy": "size-desc", "limit": 100}, "expect": {"matched.allocations": 96}},
        ],
        [{"criterion": "Identifies snapshot import/decompress_chunk", "points": 3},
         {"criterion": "Reports exact cohort and peak quantities", "points": 3},
         {"criterion": "Proves all chunks were freed in the correct window", "points": 3},
         {"criterion": "Explains the live-at-end blind spot", "points": 1}],
    )


def realloc_lineage_case() -> Case:
    trace = Trace("realloc-lineage")
    rng = random.Random(3303)
    trace.landmark("stream workload", stage="serving")
    noise(trace, rng, 550, phase="serving", sites=("packet", "header", "tls_record"))
    completed: list[Allocation] = []
    for request in range(12):
        allocation = trace.alloc(4096, "stream_buffer", request % 4, fields={
            "route": "/bulk/export", "request": f"req-{request:04d}", "policy": "adaptive",
        })
        for size in (8192, 32768, 131072):
            allocation = trace.realloc(allocation, size, fields={"capacityClass": f"c{size}"})
        completed.append(allocation)
    for allocation in completed:
        trace.free(allocation, fields={"reason": "response-complete"})
    target = trace.alloc(4096, "stream_buffer", 3, fields={
        "route": "/bulk/export", "request": "req-8841", "policy": "adaptive",
    })
    chain = [target]
    for size in (8192, 16384, 65536, 262144, 524288, 1048576):
        target = trace.realloc(target, size, fields={"capacityClass": f"c{size}"})
        chain.append(target)
    noise(trace, rng, 650, phase="serving", sites=("packet", "header", "tls_record"))
    prompt = """One live stream buffer is unexpectedly 1 MiB. Reconstruct its complete realloc lineage back to the original creator, including creator event and size at every generation. Identify the request and route tying the generations together, say which generation remains live, and contrast it with the otherwise similar completed stream requests. Do not treat realloc records as unrelated allocations."""
    return Case(
        "realloc-lineage", "Reconstruct a retained buffer through realloc generations", prompt,
        ["request and route", "ordered creator chain", "sizes", "live generation", "comparison with completed requests", "evidence"], trace,
        "Filtering live stream buffers isolates req-8841. Each allocation detail points backward through reallocatedFrom; following those relations yields seven generations from 4 KiB to 1 MiB. The twelve distractor requests follow shorter chains and their final generations are freed.",
        {"request": "req-8841", "route": "/bulk/export", "site": "stream_buffer",
         "creators": [a.creator for a in chain], "sizes": [str(a.size) for a in chain],
         "liveCreator": chain[-1].creator, "completedComparableRequests": 12},
        [
            {"endpoint": "/api/v1/allocations/query", "body": {"filter": {"source": "not alloc.freed and malloc.site == \"stream_buffer\""}, "orderBy": "size-desc", "limit": 20}, "expect": {"matched.allocations": 1, "items.0.creator": chain[-1].creator}},
            {"endpoint": "/api/v1/allocations/query", "body": {"filter": {"source": "malloc.fields.request == \"req-8841\""}, "orderBy": "creator-asc", "limit": 20}, "expect": {"matched.allocations": len(chain)}},
        ],
        [{"criterion": "Identifies req-8841 and /bulk/export", "points": 2},
         {"criterion": "Reports every creator and size in order", "points": 5},
         {"criterion": "Identifies only the final generation as live", "points": 2},
         {"criterion": "Distinguishes completed comparison requests", "points": 1}],
    )


def worker_imbalance_case() -> Case:
    trace = Trace("worker-drain-imbalance")
    rng = random.Random(4404)
    trace.landmark("queue processing", stage="serving")
    retained: list[Allocation] = []
    counts: dict[int, int] = {}
    for worker in range(8):
        allocations = []
        for index in range(180):
            queue = "deferred" if index % 5 == 0 else "ready"
            allocation = trace.alloc(2048 + (index % 4) * 256, "message_frame", worker,
                                     fields={"queue": queue, "epoch": 9, "workerRole": "consumer"})
            allocations.append(allocation)
        for allocation in allocations:
            should_retain = worker == 6 and allocation.fields["queue"] == "deferred"
            if should_retain:
                retained.append(allocation)
            else:
                trace.free(allocation, fields={"reason": "processed"})
        counts[worker] = sum(a.death is None for a in allocations)
    noise(trace, rng, 500, phase="shutdown", sites=("audit_line", "metrics_sample"), threads=8)
    trace.landmark("worker drain complete", stage="shutdown")
    retained_bytes = sum(a.size for a in retained)
    prompt = """All workers processed nearly identical message volume, so the site-level allocation totals look balanced, yet shutdown retains message frames. Find the worker and queue condition responsible, quantify retained count and bytes, compare all eight workers' retained counts, and provide a precise filter that selects the faulty cohort without selecting already processed frames."""
    return Case(
        "worker-drain-imbalance", "Find a per-worker drain failure hidden by balanced volume", prompt,
        ["worker", "queue condition", "retained count and bytes", "per-worker comparison", "precise filter", "evidence"], trace,
        "Every worker allocates 180 frames, hiding the issue in unfiltered volume. Only thread 6 retains its deferred queue entries; ready entries and all entries on the other seven workers are freed.",
        {"thread": "6", "queue": "deferred", "count": len(retained),
         "requestedBytes": str(retained_bytes), "liveCountsByThread": {str(k): v for k, v in counts.items()},
         "filter": "not alloc.freed and malloc.site == \"message_frame\" and malloc.thread == 6 and malloc.fields.queue == \"deferred\""},
        [
            {"endpoint": "/api/v1/allocations/summarize", "body": {"filter": {"source": "not alloc.freed and malloc.site == \"message_frame\""}, "groupBy": "thread", "limit": 20}, "expectGroup": {"key": "6", "allocations": len(retained), "requestedBytes": str(retained_bytes)}},
        ],
        [{"criterion": "Identifies thread 6 and deferred queue", "points": 4},
         {"criterion": "Reports exact retained count and bytes", "points": 2},
         {"criterion": "Shows zero retained frames on every other worker", "points": 2},
         {"criterion": "Provides a filter constrained to live matching frames", "points": 2}],
    )


def corrupted_telemetry_case() -> Case:
    trace = Trace("corrupted-telemetry", version=2)
    trace.landmark("capture begins", stage="capture")
    first = trace.alloc(1024, "session_state", 0, fields={"session": "s-1"})
    trace.malformed('{"op":"M","id":')
    prior_time = trace.time
    trace.alloc(2048, "normal_buffer", 1, t=trace.time - 1, declared_seq=999,
                fields={"session": "s-2"})
    # Keep later records monotonic relative to the pre-error stream so this is
    # one decreasing-time defect rather than an accidental cascade.
    trace.time = prior_time
    trace._event("F", id=999999, addr="0xdead0000", size=32, thr=2)
    trace.free(first, fields={"reason": "complete"})
    trace.free(first, fields={"reason": "duplicate-record"})
    duplicate = trace.alloc(4096, "session_state", 0, allocation_id=77,
                            fields={"session": "s-dup-a"})
    trace.alloc(8192, "session_state", 0, allocation_id=77,
                fields={"session": "s-dup-b"})
    trace.alloc(512, "overlapping_region", 3, addr=duplicate.addr + 128,
                fields={"session": "s-overlap"})
    trace.alloc(0, "zero_record", 4, fields={"session": "s-zero"})
    trace.landmark("capture ends", stage="capture")
    prompt = """Before drawing a leak conclusion from this capture, audit its integrity. Enumerate every warning kind and count, identify the implicated event sequences, and explain which records make allocation identity or geometry unreliable. State what conclusions remain safe and what should be withheld pending a clean recapture. Use warning and allocation evidence rather than silently ignoring malformed records."""
    expected = {
        "unknown_version": 1, "malformed_line": 1, "decreasing_time": 1,
        "sequence_mismatch": 1, "unknown_id": 1, "double_free": 1,
        "duplicate_id": 1, "overlap": 1, "invalid_size": 1,
    }
    return Case(
        "corrupted-telemetry", "Audit a trace before trusting its apparent leaks", prompt,
        ["warning kinds and counts", "event sequences", "identity risks", "geometry risks", "safe conclusions", "withheld conclusions"], trace,
        "The trace deliberately exercises every v1 warning class once. The duplicate id makes id-to-creator attribution ambiguous, the overlap makes address ownership ambiguous, and the zero-size record is not valid allocation geometry. Other well-formed records remain inspectable, but an exact leak total or ownership claim for the implicated session records should be withheld.",
        {"warningCounts": expected, "expectedWarningTotal": sum(expected.values()),
         "warningEvents": {
             "unknown_version": [0], "malformed_line": [1], "decreasing_time": [2],
             "sequence_mismatch": [2], "unknown_id": [3], "double_free": [5],
             "duplicate_id": [7], "overlap": [8], "invalid_size": [9],
         },
         "identityRiskSites": ["session_state"], "geometryRiskSites": ["overlapping_region", "zero_record"],
         "requiredConclusion": "request a clean recapture before exact leak attribution"},
        [{"endpoint": "/api/v1/overview", "expect": {"warnings.total": sum(expected.values()), "warnings.byCode": expected}},
         {"endpoint": "/api/v1/warnings", "query": {"from": 0, "count": 20}, "expectKinds": expected}],
        [{"criterion": "Finds every warning kind and exact count", "points": 4},
         {"criterion": "Maps warnings to implicated sequences/records", "points": 2},
         {"criterion": "Explains duplicate-id and overlap consequences separately", "points": 2},
         {"criterion": "Avoids an unsupported exact leak conclusion", "points": 2}],
    )


def dual_ranking_tag_case() -> Case:
    trace = Trace("dual-leak-ranking-and-tagging")
    rng = random.Random(6606)
    trace.landmark("post-deploy workload", stage="serving", build="2026.09.5")
    noise(trace, rng, 800, phase="serving")
    byte_leaks = [trace.alloc(524288, "compressed_blob", i % 3, fields={
        "build": "2026.09.5", "owner": "artifact-cache", "ticket": "HV-217",
    }) for i in range(9)]
    count_leaks = [trace.alloc(384, "index_node", i % 8, fields={
        "build": "2026.09.5", "owner": "search-index", "ticket": "HV-231",
    }) for i in range(420)]
    old_build = [trace.alloc(524288, "compressed_blob", i % 3, fields={
        "build": "2026.08.9", "owner": "artifact-cache", "ticket": "HV-190",
    }) for i in range(7)]
    for allocation in old_build:
        trace.free(allocation, fields={"reason": "evicted"})
    noise(trace, rng, 700, phase="serving")
    tag_filter = "not alloc.freed and malloc.fields.build == \"2026.09.5\" and malloc.fields.ticket in {\"HV-217\", \"HV-231\"}"
    prompt = """The post-deploy leak report needs two rankings: the largest retained regression by bytes and the largest by allocation count. Identify both cohorts with exact counts/bytes and ownership attributes, explain why either ranking alone is misleading, exclude the similar old-build traffic, then create a tag named `post-deploy-regression` and atomically apply it to exactly the two current-build cohorts. Report the resulting tagged member count and analysis revision evidence."""
    return Case(
        "dual-leak-ranking-and-tagging", "Rank two different leak regressions and annotate the union", prompt,
        ["bytes leader", "count leader", "exact quantities", "ownership attributes", "old-build exclusion", "tag mutation result"], trace,
        "Nine large HV-217 blobs dominate retained bytes, while 420 tiny HV-231 index nodes dominate count. Both are current build 2026.09.5. Similar old-build blobs are freed. After creating the tag, one replace tag-query with the union filter selects exactly 429 creators and emits one snapshot-required revision.",
        {"bytesLeader": {"site": "compressed_blob", "ticket": "HV-217", "owner": "artifact-cache",
                         "count": len(byte_leaks), "requestedBytes": str(sum(a.size for a in byte_leaks))},
         "countLeader": {"site": "index_node", "ticket": "HV-231", "owner": "search-index",
                         "count": len(count_leaks), "requestedBytes": str(sum(a.size for a in count_leaks))},
         "excludedBuild": "2026.08.9", "tagId": "post-deploy-regression",
         "taggedMembers": len(byte_leaks) + len(count_leaks), "tagFilter": tag_filter,
         "expectedFinalRevision": 2, "snapshotRequired": True},
        [
            {"endpoint": "/api/v1/allocations/summarize", "body": {"filter": {"source": "not alloc.freed"}, "groupBy": "site", "limit": 20}, "expectGroups": ["compressed_blob", "index_node"]},
            {"endpoint": "/api/v1/analysis/changes", "body": {"expectedRevision": 0, "requestId": "bench-create-regression-tag", "change": {"type": "putTag", "id": "post-deploy-regression", "name": "post-deploy-regression", "color": "#d9485f"}}, "expect": {"revision": 1}},
            {"endpoint": "/api/v1/analysis/tag-query", "body": {"expectedRevision": 1, "requestId": "bench-tag-regressions", "tagId": "post-deploy-regression", "filter": {"source": tag_filter}, "operation": "replace"}, "expect": {"revision": 2, "matched": 429, "changed": 429, "snapshotRequired": True}},
        ],
        [{"criterion": "Correctly separates bytes and count leaders", "points": 3},
         {"criterion": "Reports exact quantities and ownership/ticket fields", "points": 2},
         {"criterion": "Excludes freed old-build traffic", "points": 1},
         {"criterion": "Creates and atomically applies the requested tag to 429 members", "points": 3},
         {"criterion": "Reports revision/snapshot evidence", "points": 1}],
    )


def uaf_callback_hijack_case() -> Case:
    trace = Trace("uaf-callback-hijack")
    rng = random.Random(7707)
    trace.landmark("extension workload begins", stage="serving")
    noise(trace, rng, 600, phase="serving", sites=("rpc_frame", "json_value", "audit_record"))
    address = 0x18000000
    victim = trace.alloc(256, "extension_state", 2, addr=address, fields={
        "extension": "pdf-preview", "object": "ext-19", "generation": 41,
        "expectedCallback": "0x401280", "owner": "extension-manager",
    })
    queued = trace.landmark(
        f"async dispatch queued handle=h-77 ptr=0x{address:x} generation=41",
        eventKind="dispatch-queued", handle="h-77", ptr=f"0x{address:x}", generation=41,
    )
    noise(trace, rng, 120, phase="serving", sites=("rpc_frame", "json_value"))
    death = trace.free(victim, fields={"reason": "extension-unload", "extension": "pdf-preview"})
    incident_time = trace.time + 10
    benign_a = trace.alloc(256, "thumbnail_job", 5, addr=address, t=incident_time, fields={
        "generation": 42, "source": "background", "firstQword": "0x402100",
    })
    trace.free(benign_a, t=incident_time, fields={"reason": "complete"})
    benign_b = trace.alloc(256, "metrics_packet", 1, addr=address, t=incident_time, fields={
        "generation": 43, "source": "internal", "firstQword": "0x403300",
    })
    trace.free(benign_b, t=incident_time, fields={"reason": "flushed"})
    replacement = trace.alloc(256, "request_body_chunk", 7, addr=address, t=incident_time, fields={
        "generation": 44, "source": "network", "route": "/extensions/render",
        "request": "atk-552", "firstQword": "0x7fff41414141", "controlled": True,
    })
    trap = trace.landmark(
        f"security trap stale indirect call handle=h-77 ptr=0x{address:x} "
        "expected_generation=41 observed_generation=44 callback=0x7fff41414141 "
        "source=request-body request=atk-552",
        t=incident_time, eventKind="stale-indirect-call", handle="h-77", ptr=f"0x{address:x}",
        expectedGeneration=41, observedGeneration=44, callback="0x7fff41414141",
    )
    noise(trace, rng, 500, phase="recovery", sites=("rpc_frame", "audit_record"))
    prompt = f"""This is authorized defensive analysis of an entirely synthetic trace; do not develop exploit code. A control-flow integrity trap occurred at event {trap}. Determine whether the evidence shows a security-relevant use-after-free or a benign stale callback. Reconstruct the complete lifetime and same-address reuse chain relevant to handle h-77, including creator/death events, generations, sites, and the occupant at the trap. Explain why timestamp ordering alone is insufficient, identify the externally controlled evidence and attempted control-flow target, and distinguish causal records from unrelated allocator reuse. Give a defensible impact verdict with exact API evidence."""
    address_filter = f"alloc.address == 0x{address:x}"
    return Case(
        "uaf-callback-hijack", "Prove attacker-controlled callback hijack through same-address reuse", prompt,
        ["UAF verdict", "victim lifetime", "ordered reuse chain", "trap occupant", "attacker control", "control-flow target", "causal evidence"], trace,
        "The queued handle retains generation 41's extension_state after it is freed. Two benign generations briefly reuse the address and die. At the same timestamp, attacker-controlled request data becomes generation 44 at that address before the stale indirect call reads its first word as a callback. Sequence, not timestamp, establishes the final reuse-before-call ordering.",
        {
            "verdict": "exploitable control-flow UAF", "handle": "h-77", "address": f"0x{address:x}",
            "queuedEvent": queued, "victim": {"creator": victim.creator, "death": death, "generation": 41, "site": victim.site},
            "reuseChain": [
                {"creator": benign_a.creator, "death": benign_a.death, "generation": 42, "site": benign_a.site},
                {"creator": benign_b.creator, "death": benign_b.death, "generation": 43, "site": benign_b.site},
                {"creator": replacement.creator, "death": None, "generation": 44, "site": replacement.site},
            ],
            "trapEvent": trap, "sharedTime": str(incident_time), "trapOccupantCreator": replacement.creator,
            "attackerRequest": "atk-552", "attackerSource": "network", "attemptedCallback": "0x7fff41414141",
        },
        [
            {"endpoint": "/api/v1/overview", "expect": {"warnings.total": 0}},
            {"endpoint": "/api/v1/allocations/query", "body": {"filter": {"source": address_filter}, "orderBy": "creator-asc", "limit": 20}, "expect": {"matched.allocations": 4, "items.0.creator": victim.creator, "items.3.creator": replacement.creator}},
            {"endpoint": "/api/v1/stream/context", "body": {"filter": {"source": address_filter}, "center": trap, "before": 8, "after": 1, "includeLandmarks": True}, "expectEventTitleContains": "stale indirect call"},
        ],
        [{"criterion": "Identifies an exploitable UAF rather than generic address reuse", "points": 2},
         {"criterion": "Reconstructs victim and all three reuse generations with exact event ordering", "points": 3},
         {"criterion": "Identifies generation 44 as the trap occupant and explains same-time sequence ordering", "points": 2},
         {"criterion": "Connects attacker-controlled request data to callback 0x7fff41414141", "points": 2},
         {"criterion": "Cites bounded API evidence and excludes non-causal reuse", "points": 1}],
        "security-uaf", "hard",
    )


def uaf_realloc_interior_write_case() -> Case:
    trace = Trace("uaf-realloc-interior-write")
    rng = random.Random(8808)
    trace.landmark("authentication workload", stage="serving")
    noise(trace, rng, 500, phase="serving", sites=("header_map", "tls_record", "log_entry"))
    old_address = 0x19000000
    original = trace.alloc(512, "session_packet", 3, addr=old_address, fields={
        "session": "sess-204", "generation": 8, "roleOffset": 128, "owner": "auth-parser",
    })
    stale_ptr = old_address + 128
    saved = trace.landmark(
        f"interior pointer retained session=sess-204 base=0x{old_address:x} offset=128 ptr=0x{stale_ptr:x}",
        eventKind="interior-pointer-retained", ptr=f"0x{stale_ptr:x}", session="sess-204",
    )
    moved = trace.realloc(original, 4096, fields={"generation": 9, "capacity": 4096})
    incident_time = trace.time + 20
    replacement = trace.alloc(512, "authorization_record", 6, addr=old_address, t=incident_time, fields={
        "request": "login-991", "principal": "guest", "roleOffset": 128,
        "roleBefore": "guest", "source": "remote-login",
    })
    trap = trace.landmark(
        f"security trap stale interior write ptr=0x{stale_ptr:x} bytes=admin "
        "field=role result=privilege-escalation request=login-991",
        t=incident_time, eventKind="stale-interior-write", ptr=f"0x{stale_ptr:x}",
        bytes="admin", result="privilege-escalation",
    )
    trace.free(replacement, fields={"reason": "request-aborted"}, t=incident_time + 1)
    trace.free(moved, fields={"reason": "session-close"}, t=incident_time + 2)
    noise(trace, rng, 450, phase="recovery", sites=("header_map", "log_entry"))
    prompt = f"""This is authorized defensive analysis of an entirely synthetic trace; do not develop exploit code. Investigate the privilege-boundary trap at event {trap}. Reconstruct how the pointer became stale, including the original allocation, the realloc move, the stale interior offset, and the allocation owning the target bytes when the write occurred. Determine whether this is an out-of-bounds write on the current packet, a use-after-realloc, or harmless reuse. Report exact creator/death relations, address arithmetic, same-time ordering, overwritten semantic field/value, and security impact. Explain which later frees are consequences rather than prevention."""
    old_filter = f"alloc.address == 0x{old_address:x}"
    return Case(
        "uaf-realloc-interior-write", "Trace an interior pointer into an attacker-relevant post-realloc occupant", prompt,
        ["bug class", "original and realloc relation", "stale pointer arithmetic", "write-time owner", "overwritten field", "exploit impact", "event evidence"], trace,
        "Realloc creator movement kills the 512-byte generation and creates a live 4096-byte generation elsewhere. The retained base+128 pointer still targets the old range. authorization_record then reuses that range before the stale write changes its role field from guest to admin. Later frees occur after the write and do not mitigate it.",
        {
            "verdict": "exploitable use-after-realloc write", "session": "sess-204",
            "originalCreator": original.creator, "reallocCreator": moved.creator, "originalDeath": original.death,
            "oldAddress": f"0x{old_address:x}", "offset": 128, "stalePointer": f"0x{stale_ptr:x}",
            "replacementCreator": replacement.creator, "replacementSite": replacement.site,
            "trapEvent": trap, "sharedTime": str(incident_time), "field": "role",
            "before": "guest", "written": "admin", "impact": "privilege escalation",
        },
        [
            {"endpoint": "/api/v1/overview", "expect": {"warnings.total": 0}},
            {"endpoint": "/api/v1/allocations/query", "body": {"filter": {"source": old_filter}, "orderBy": "creator-asc", "limit": 20}, "expect": {"matched.allocations": 2, "items.0.creator": original.creator, "items.1.creator": replacement.creator}},
            {"endpoint": f"/api/v1/allocations/{moved.creator}", "expect": {"allocation.relations.reallocatedFrom": original.creator}},
            {"endpoint": "/api/v1/stream/context", "body": {"filter": {"source": old_filter}, "center": trap, "before": 4, "after": 3, "includeLandmarks": True}, "expectEventTitleContains": "privilege-escalation"},
        ],
        [{"criterion": "Classifies the bug as use-after-realloc rather than current-object OOB", "points": 2},
         {"criterion": "Reports exact original/realloc creators, death relation, and moved generation", "points": 2},
         {"criterion": "Computes base plus 128 and identifies the write-time authorization_record owner", "points": 2},
         {"criterion": "Explains role guest-to-admin overwrite and privilege-escalation impact", "points": 3},
         {"criterion": "Orders the write before later frees using event evidence", "points": 1}],
        "security-uaf", "hard",
    )


def stale_handle_guard_case() -> Case:
    trace = Trace("stale-handle-generation-guard")
    rng = random.Random(9909)
    noise(trace, rng, 450, phase="serving", sites=("task_node", "io_buffer", "timer"))
    address = 0x1A000000
    victim = trace.alloc(192, "websocket_peer", 4, addr=address, fields={
        "connection": "ws-81", "generation": 12, "callback": "0x405500",
    })
    queued = trace.landmark(
        f"poll handle queued handle=poll-18 ptr=0x{address:x} generation=12",
        eventKind="poll-queued", handle="poll-18", generation=12,
    )
    death = trace.free(victim, fields={"reason": "peer-disconnect"})
    replacement = trace.alloc(192, "admin_command", 1, addr=address, fields={
        "generation": 13, "source": "local-admin", "callback": "0x7fff42424242",
    })
    guard = trace.landmark(
        f"generation guard rejected handle=poll-18 ptr=0x{address:x} "
        "expected_generation=12 observed_generation=13 action=drop dereference=false",
        eventKind="generation-guard", handle="poll-18", dereference=False,
    )
    trace.free(replacement, fields={"reason": "command-complete"})
    noise(trace, rng, 450, phase="serving", sites=("task_node", "io_buffer", "timer"))
    prompt = f"""This is authorized defensive analysis of an entirely synthetic trace; do not develop exploit code. A security alert flagged a possible callback UAF at event {guard}. Decide whether an actual post-free dereference or security impact occurred. Reconstruct the stale handle, victim lifetime, address reuse, replacement object, and generation check. Address the suspicious replacement callback value without assuming that reuse alone proves impact. State precisely what security property held or failed and what evidence would be required to call this an executed UAF."""
    address_filter = f"alloc.address == 0x{address:x}"
    return Case(
        "stale-handle-generation-guard", "Reject a false exploit claim when a generation guard blocks dereference", prompt,
        ["exploitability verdict", "victim lifetime", "reuse occupant", "generation comparison", "dereference decision", "required contrary evidence"], trace,
        "The handle is stale and the address is reused by an object carrying a suspicious callback, but the generation check compares 12 with 13 and drops the operation before dereference. This is a detected stale handle, not an executed UAF or control-flow exploit.",
        {
            "verdict": "stale handle safely blocked; no UAF dereference", "handle": "poll-18",
            "victimCreator": victim.creator, "victimDeath": death, "queuedEvent": queued,
            "address": f"0x{address:x}", "replacementCreator": replacement.creator,
            "replacementSite": replacement.site, "expectedGeneration": 12, "observedGeneration": 13,
            "guardEvent": guard, "action": "drop", "dereference": False,
        },
        [
            {"endpoint": "/api/v1/overview", "expect": {"warnings.total": 0}},
            {"endpoint": "/api/v1/allocations/query", "body": {"filter": {"source": address_filter}, "orderBy": "creator-asc", "limit": 20}, "expect": {"matched.allocations": 2, "items.0.creator": victim.creator, "items.1.creator": replacement.creator}},
            {"endpoint": "/api/v1/stream/context", "body": {"filter": {"source": address_filter}, "center": guard, "before": 5, "after": 1, "includeLandmarks": True}, "expectEventTitleContains": "dereference=false"},
        ],
        [{"criterion": "Concludes no post-free dereference or exploit occurred", "points": 3},
         {"criterion": "Reconstructs exact victim lifetime and replacement creator", "points": 2},
         {"criterion": "Reports expected generation 12 versus observed 13 and action drop", "points": 2},
         {"criterion": "Explains why suspicious address reuse/callback data is insufficient", "points": 2},
         {"criterion": "States the contrary evidence needed for an exploit claim", "points": 1}],
        "security-uaf", "hard",
    )


def cycle_growth_case() -> Case:
    trace = Trace("cycle-normalized-retention-growth")
    rng = random.Random(10110)
    per_cycle: list[dict[str, Any]] = []
    all_roots: list[Allocation] = []
    anomalous: list[Allocation] = []
    for cycle in range(8):
        start = trace.landmark(f"cycle {cycle} begins", stage="cycle-start", cycle=cycle)
        transients = []
        for index in range(120):
            allocation = trace.alloc(rng.choice((512, 1024, 4096, 16384)), "request_state", index % 8,
                                     fields={"cycle": cycle, "kind": "transient", "owner": "gateway"})
            transients.append(allocation)
        scratch = [trace.alloc(2 * 1024 * 1024, "jit_scratch", i % 4,
                               fields={"cycle": cycle, "kind": "transient", "owner": "runtime"})
                   for i in range(6)]
        roots = [trace.alloc(16384, "request_state", i, fields={
            "cycle": cycle, "kind": "audit-root", "owner": "compliance", "expected": True,
        }) for i in range(4)]
        all_roots.extend(roots)
        storm = []
        if cycle == 5:
            storm = [trace.alloc(32768, "request_state", i % 8, fields={
                "cycle": cycle, "kind": "retry-shadow", "owner": "payments",
                "upstream": "ledger", "status": 503, "retryPolicy": "unbounded",
            }) for i in range(13)]
            anomalous.extend(storm)
        for allocation in reversed(scratch):
            trace.free(allocation, fields={"reason": "compile-complete"})
        for allocation in transients:
            trace.free(allocation, fields={"reason": "request-complete"})
        end = trace.landmark(f"cycle {cycle} checkpoint", stage="checkpoint", cycle=cycle)
        per_cycle.append({"cycle": cycle, "start": start, "checkpoint": end,
                          "retainedCount": len(roots) + len(storm),
                          "retainedBytes": str(sum(a.size for a in roots + storm))})
    prompt = """Each completed cycle should retain exactly four 16 KiB compliance audit roots. Large JIT bursts are expected and transient. Reconstruct the retained contribution of every cycle, identify the first and only cycle that violates the invariant, quantify baseline versus excess retention, and identify the producer condition behind the excess. Then distinguish cumulative live-at-end bytes from per-cycle net growth and explain why total allocation volume or peak bytes point at the wrong subsystem. Provide exact filters/evidence for all eight cycles."""
    return Case(
        "cycle-normalized-retention-growth", "Find one anomalous retained increment across repeated high-volume cycles", prompt,
        ["eight per-cycle retained contributions", "violating cycle", "baseline and excess", "producer condition", "cumulative versus incremental totals", "distractor exclusion"], trace,
        "Every cycle contributes four expected 16 KiB audit roots. Cycle 5 alone also retains thirteen 32 KiB retry shadows after ledger 503 responses under an unbounded retry policy. JIT scratch dominates allocation and peak volume but is fully freed.",
        {
            "perCycle": per_cycle, "violatingCycle": 5,
            "baselinePerCycle": {"count": 4, "bytes": "65536"},
            "cycleFive": {"count": 17, "bytes": "491520"},
            "excess": {"count": len(anomalous), "bytes": str(sum(a.size for a in anomalous))},
            "condition": {"kind": "retry-shadow", "owner": "payments", "upstream": "ledger", "status": 503, "retryPolicy": "unbounded"},
            "liveAtEnd": {"count": len(all_roots) + len(anomalous), "bytes": str(sum(a.size for a in all_roots + anomalous))},
            "excludedSite": "jit_scratch",
        },
        [
            {"endpoint": "/api/v1/allocations/summarize", "body": {"filter": {"source": "not alloc.freed and malloc.fields.cycle == 5"}, "groupBy": "site", "limit": 20}, "expectGroup": {"key": "request_state", "allocations": 17, "requestedBytes": "491520"}},
            {"endpoint": "/api/v1/allocations/summarize", "body": {"filter": {"source": "malloc.site == \"jit_scratch\""}, "groupBy": "freed", "limit": 20}, "expectGroup": {"key": "freed", "allocations": 48, "liveAtEnd": 0}},
            {"endpoint": "/api/v1/allocations/query", "body": {"filter": {"source": "not alloc.freed and malloc.fields.kind == \"retry-shadow\""}, "orderBy": "creator-asc", "limit": 20}, "expect": {"matched.allocations": 13, "matched.requestedBytes": "425984"}},
        ],
        [{"criterion": "Reports exact retained count/bytes for all eight cycles", "points": 3},
         {"criterion": "Identifies cycle 5 and computes 13 allocations / 425984 excess bytes", "points": 2},
         {"criterion": "Finds the full retry-shadow producer condition", "points": 2},
         {"criterion": "Separates per-cycle increment from cumulative live-at-end total", "points": 2},
         {"criterion": "Proves JIT scratch is a freed volume/peak distractor", "points": 1}],
        "temporal-retention", "hard",
    )


def allocator_slack_case() -> Case:
    trace = Trace("allocator-slack-regression")
    trace.landmark("allocator profile begins", stage="profile")
    cohorts: dict[str, list[Allocation]] = {}
    specs = (
        ("small_header", 2000, 33, 128, "network"),
        ("payload_fragment", 800, 192, 208, "storage"),
        ("aligned_vector", 100, 4096, 4112, "compute"),
    )
    for site, count, requested, usable, owner in specs:
        cohort = [trace.alloc(requested, site, i % 8, fields={"owner": owner, "profile": "rss-gap"})
                  for i in range(count)]
        # Usable is a defined trace field, not a custom field.
        for allocation in cohort:
            record = trace.events[allocation.creator]
            record["usable"] = usable
            trace.lines[allocation.creator] = json.dumps(record, separators=(",", ":"), ensure_ascii=False)
        cohorts[site] = cohort
    unknown = [trace.alloc(512, "opaque_cache", i % 4, fields={"owner": "legacy", "profile": "rss-gap"})
               for i in range(500)]
    for cohort in list(cohorts.values()) + [unknown]:
        for allocation in cohort:
            trace.free(allocation, fields={"reason": "profile-complete"})
    trace.landmark("allocator profile complete", stage="profile")
    small_requested = 2000 * 33
    small_usable = 2000 * 128
    prompt = """Allocator RSS exceeded requested-byte accounting during this completed workload, but there is no live-at-end leak. Determine which measured site contributes the largest allocator slack despite not leading requested bytes. For every site with known usable sizes, report allocation count, requested bytes, usable bytes, absolute slack, usable/requested amplification, and known-usable denominator. Treat the site with missing usable measurements correctly: state what can and cannot be ranked. Explain why requested-byte ranking and leak analysis both misdiagnose this incident."""
    return Case(
        "allocator-slack-regression", "Explain allocator footprint amplification without a leak", prompt,
        ["measured-site table", "absolute slack leader", "amplification", "known-usable denominators", "unknown-measurement limitation", "not-a-leak conclusion"], trace,
        "aligned_vector leads requested bytes, but small_header's rounding from 33 to 128 bytes creates by far the largest measured slack and amplification. opaque_cache has no usable measurements, so its slack cannot be ranked. Every allocation is freed.",
        {
            "sites": {
                "small_header": {"count": 2000, "requestedBytes": "66000", "usableBytes": "256000", "known": 2000, "slackBytes": "190000", "amplification": "3.8787878788"},
                "payload_fragment": {"count": 800, "requestedBytes": "153600", "usableBytes": "166400", "known": 800, "slackBytes": "12800", "amplification": "1.0833333333"},
                "aligned_vector": {"count": 100, "requestedBytes": "409600", "usableBytes": "411200", "known": 100, "slackBytes": "1600", "amplification": "1.00390625"},
                "opaque_cache": {"count": 500, "requestedBytes": "256000", "usableBytes": "0", "known": 0, "slackBytes": None},
            },
            "slackLeader": "small_header", "slackLeaderBytes": str(small_usable - small_requested),
            "allFreed": True,
        },
        [
            {"endpoint": "/api/v1/allocations/summarize", "body": {"groupBy": "site", "limit": 20}, "expectGroup": {"key": "small_header", "allocations": 2000, "requestedBytes": "66000", "usableBytes": "256000", "usableKnownAllocations": 2000, "liveAtEnd": 0}},
            {"endpoint": "/api/v1/allocations/summarize", "body": {"filter": {"source": "malloc.site == \"opaque_cache\""}, "groupBy": "site", "limit": 20}, "expectGroup": {"key": "opaque_cache", "usableKnownAllocations": 0, "liveAtEnd": 0}},
        ],
        [{"criterion": "Computes exact requested, usable, slack, and denominator values for measured sites", "points": 4},
         {"criterion": "Identifies small_header as 190000-byte slack and 3.8788x amplification leader", "points": 2},
         {"criterion": "Does not treat opaque_cache usableBytes zero as measured zero slack", "points": 2},
         {"criterion": "Explains why requested-byte ranking points elsewhere", "points": 1},
         {"criterion": "Proves the workload is fully freed and not a leak", "points": 1}],
        "allocator-accounting", "hard",
    )


CASES: tuple[Callable[[], Case], ...] = (
    retained_cache_case,
    transient_peak_case,
    realloc_lineage_case,
    worker_imbalance_case,
    corrupted_telemetry_case,
    dual_ranking_tag_case,
    uaf_callback_hijack_case,
    uaf_realloc_interior_write_case,
    stale_handle_guard_case,
    cycle_growth_case,
    allocator_slack_case,
)


def generate(output: Path) -> None:
    traces = output / "traces"
    traces.mkdir(parents=True, exist_ok=True)
    tasks = {"suiteVersion": SUITE_VERSION, "cases": []}
    solutions = {"suiteVersion": SUITE_VERSION, "cases": []}
    for build in CASES:
        case = build()
        payload = case.trace.bytes()
        trace_name = f"{case.id}.heapl"
        (traces / trace_name).write_bytes(payload)
        digest = "sha256:" + hashlib.sha256(payload).hexdigest()
        tasks["cases"].append({
            "id": case.id, "title": case.title, "trace": f"traces/{trace_name}",
            "traceId": digest, "category": case.category, "difficulty": case.difficulty,
            "prompt": case.prompt, "answerShape": case.answer_shape,
        })
        solutions["cases"].append({
            "id": case.id, "traceId": digest, "explanation": case.explanation,
            "answer": case.answer, "traceStats": case.trace.stats(),
            "evidence": case.evidence, "rubric": case.rubric,
            "maxScore": sum(item["points"] for item in case.rubric),
        })
    (output / "tasks.json").write_text(json.dumps(tasks, indent=2, ensure_ascii=False) + "\n")
    (output / "solutions.json").write_text(json.dumps(solutions, indent=2, ensure_ascii=False) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    generate(args.out)
    print(f"generated {len(CASES)} cases in {args.out}")


if __name__ == "__main__":
    main()
