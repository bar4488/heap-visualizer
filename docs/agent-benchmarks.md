# Agent analysis benchmarks

Generate the deterministic benchmark corpus with:

```sh
python3 src/benchmarks/generate.py
```

This writes `benchmarks/agent/tasks.json`, `solutions.json`, and eleven `.heapl`
files under `benchmarks/agent/traces/`. `tasks.json` is the only manifest that
should be exposed to an evaluated agent. Keep `solutions.json` with the harness:
it contains explanations, exact answers, evidence requests, trace statistics,
and a ten-point rubric for each case.

The cases intentionally test different analysis skills:

| Case | Primary challenge |
|---|---|
| `retained-cache-cohort` | Separate an unintended retained cohort from legitimate process-lifetime state and a larger transient distractor. |
| `transient-decompression-spike` | Explain a severe peak with no corresponding leak, using landmarks, timeline bins, and allocation lifetimes. |
| `realloc-lineage` | Follow one allocation through every realloc generation rather than counting generations as independent leaks. |
| `worker-drain-imbalance` | Find a thread/custom-field interaction hidden by balanced site-level allocation volume. |
| `corrupted-telemetry` | Audit all warning classes and limit conclusions when identity or geometry is unreliable. |
| `dual-leak-ranking-and-tagging` | Distinguish count and byte leaders, exclude a freed lookalike cohort, and annotate the exact union atomically. |
| `uaf-callback-hijack` | Prove an attacker-controlled stale indirect call through multiple same-address generations at one timestamp. |
| `uaf-realloc-interior-write` | Follow an interior pointer invalidated by realloc into a replacement authorization object and classify the write impact. |
| `stale-handle-generation-guard` | Reject a false exploit claim when address reuse occurs but a generation guard prevents dereference. |
| `cycle-normalized-retention-growth` | Normalize retained increments across repeated cycles and separate one excess cohort from expected roots and peak-volume noise. |
| `allocator-slack-regression` | Attribute requested-versus-usable footprint amplification while treating missing usable measurements honestly. |

`tasks.json` labels cases by `category` and `difficulty`, so an evaluator can
run only the hard cases or report security and memory-accounting results
separately.

The UAF cases remain valid `.heapl` v1 traces. Producer-observed operations such
as queued handles, stale dereferences, guard decisions, and security traps are
custom `E` records with structured human-readable titles. The task supplies the
incident event sequence; agents correlate the focused event context with
allocation details, death events, realloc relations, and address reuse. A
custom event is evidence about a producer-observed access, not an allocation
operation and not proof of exploitability by itself.

The suite deliberately has no built-in model runner, prompt framework, or score
aggregator. An evaluator should start a fresh local-server data directory for
each case, give the agent its prompt and connection capability, then score the
final answer and canonical analysis against the private solution.

## API skill and recorded runs

`.opencode/skills/heap-analysis-api/SKILL.md` gives evaluated agents the stable,
generic API contract: authentication, request shapes, limits, filter syntax,
pagination, warning evidence, and canonical mutation forms. It deliberately
contains no case identifiers, expected cohorts, benchmark-specific field
values, quantities, creator sequences, or rubric material. Require the agent to
load it before analysis when running the skill-assisted protocol.

The current GPT-5.6 Terra suite-v2 skill-assisted result is under
`benchmarks/agent/results/`. It keeps scored final responses, machine-readable
run metadata, and a methodology summary. The evaluation uses a fresh model
session, private OpenCode server, and fresh heap-server data directory for every
case. Raw model event streams, temporary capabilities, and server state are not
repository artifacts.
