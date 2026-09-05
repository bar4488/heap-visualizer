# GPT-5.6 Terra — suite v2 with heap API skill — 2026-09-05

Model: `openai/gpt-5.6-terra` (standard, non-fast)

Skill: `.opencode/skills/heap-analysis-api/SKILL.md`

Result: **110/110 (100%)**.

| Case | Category | Difficulty | Score |
|---|---|---|---:|
| `retained-cache-cohort` | memory analysis | medium | 10/10 |
| `transient-decompression-spike` | memory analysis | medium | 10/10 |
| `realloc-lineage` | memory analysis | medium | 10/10 |
| `worker-drain-imbalance` | memory analysis | medium | 10/10 |
| `corrupted-telemetry` | memory analysis | medium | 10/10 |
| `dual-leak-ranking-and-tagging` | memory analysis | medium | 10/10 |
| `uaf-callback-hijack` | security/UAF | hard | 10/10 |
| `uaf-realloc-interior-write` | security/UAF | hard | 10/10 |
| `stale-handle-generation-guard` | security/UAF | hard | 10/10 |
| `cycle-normalized-retention-growth` | temporal retention | hard | 10/10 |
| `allocator-slack-regression` | allocator accounting | hard | 10/10 |

Subtotals: original medium cases **60/60**; new hard cases **50/50**.

## Notable behavior

- The callback-hijack answer reconstructed all four same-address generations,
  used sequence order for six events sharing one timestamp, identified the
  network-controlled occupant, and distinguished the two non-causal reuse
  generations.
- The interior-write answer correctly classified use-after-realloc rather than
  current-object out-of-bounds access, computed the stale base-plus-128 pointer,
  identified the authorization record owning the bytes, and ordered the write
  before both later frees.
- The generation-guard answer did not overclaim: it treated suspicious callback
  data and address reuse as insufficient because `dereference=false` and the
  generation mismatch caused `action=drop`.
- The cycle-growth answer produced all eight per-cycle increments, cumulative
  totals, the exact cycle-5 excess, its five-field producer condition, and the
  fully-freed JIT distractor.
- The allocator-slack answer handled missing usable-size measurements correctly
  rather than interpreting an unknown denominator as measured zero slack.
- The canonical tagging case persisted revision 2 with exactly 429 tagged
  creators.

One response contained a non-rubric imprecision: in `realloc-lineage`, Terra
described all 54 freed stream-buffer generations as completed-request
generations. Six of those are earlier generations of the retained request. The
same answer separately identified the required 12 completed four-generation
chains, their exact pattern, and the retained seven-generation chain, so every
stated rubric criterion remains satisfied.

## Method

- One fresh model session, private standalone OpenCode server, and fresh
  heap-server data directory per case.
- Every transcript contains one successful `heap-analysis-api` skill load.
- Only the public prompt, connection capability, trace ID, and generic API
  skill were exposed; raw traces and private solutions were not.
- Security prompts explicitly identify the traces as synthetic authorized
  defensive analysis and prohibit exploit-code development.
- All 11 recorded runs exited successfully with no provider errors.
- Scoring manually applied the existing ten-point case rubrics.

OpenCode's per-step counters sum to 238,724 input, 24,753 output, and 7,984
reasoning tokens, plus 456,192 cache-read tokens. Aggregate per-case elapsed
time was 943 seconds; cases were run concurrently, so this is not wall-clock
duration. The run made 127 tool calls and received 19 `invalid_request`
responses.

The perfect result means suite v2 still does not separate GPT-5.6 Terra from
the ceiling under this skill-assisted protocol. Future difficulty should come
from less-local evidence, competing causal hypotheses, and answers requiring
cross-window synthesis rather than larger traces or undocumented API shapes.
