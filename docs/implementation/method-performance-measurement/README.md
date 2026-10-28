# Performance measurement method

This slice adds shared [performance measurement guidance](../../../osstack-methods-skill/references/performance-measurement.md). It teaches a caller to compare equivalent completed work, preserve errors and timing boundaries, explain measured limits, and separate local numbers from user-visible effects. It adds no benchmark runner, model call, runtime behavior or qualification.

The author baseline is `92088fe55a2f985ca743fa1fabee0c081a6f672d`. Only the new reference and this implementation record belong to this slice. The integration owner handles entry routing, shared attribution and export tests. This author slice alone does not claim that the new method is reachable from the four entries or that either host has used it.

## Source and adaptation

The original material was read directly from `cursor/plugins` Git objects at `99b609a72323b70204eab407c622f436e858e112`:

| Original source | SHA-256 | Retained practice |
| --- | --- | --- |
| [benchmark-checklist](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/benchmark-checklist/SKILL.md) | `ba109e96c8f6c1c391baccf19e5d11e14370df7b3f2605e1572cd565a6c0fca0` | Equivalent tuning, correctness, completed work, timing scope, interleaved samples, limiter and end-to-end relevance |
| [principle-explain-the-number](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-explain-the-number/SKILL.md) | `cd5a25f9e7cf023627ccb470dc5faa97542f29b4319496a32b839a8e1e988047` | Explain constraints and alternative causes before trusting a number; preserve spread and evidence |

OSStack uses host-available diagnostics rather than assuming Linux tools. Five alternating samples per side are a starting point, not a statistical guarantee. A one-run ballpark retains correctness/work checks and cannot select an option. An unmeasured bottleneck remains a hypothesis. Latency reduction and speedup use different denominators. The method does not import automatic optimization loops, publication rules or new runtime permissions.

The existing `scripts/bench-cli-startup.mjs` was read at the baseline, not executed. It measures five child-process spawns for each startup surface, checks successful exit and expected stdout, and reports median/min/max against a budget. It is a budget check, not evidence that this method has run a comparative performance experiment. No package, benchmark command or budget was changed.

## Examples and validation scope

The reference contains four explicitly synthetic examples: a comparable observation with limited end-to-end significance, a shifted timing boundary and component bound, fast rejected work, and unresolved noise. Their values are invented. Arithmetic checks can establish the example calculations; they cannot establish real performance or model review quality.

Independent criteria were frozen before author implementation: `ebec2ebce5de0cc5c5d1ea6f933ca0e5b5b069c1bfaab2ca1d858627395a9436`. Author evidence is retained under the task scratch directory `method-impact-performance-20261028/performance`: exact upstream snapshots and source anchors, arithmetic/negative-control checks, relative-link checks, Git diff checks and a candidate binding. The integration owner retains independent review and any later audit separately. No model, full-suite test or actual benchmark is claimed by this author slice.

Author checks passed: eight synthetic arithmetic checks, five local documentation links, both pinned upstream content hashes, and the staged Git whitespace check. These checks validate the authored examples and document structure only. They do not measure host behavior, actual latency or the effectiveness of the method.
