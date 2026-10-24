# Delivery Contract V2 / guarded execution audit

Scope: B0 schema/core helpers and B1 actual guarded-local / guarded-git execution. This report does not qualify the parent branch's bin wiring, Graph path, live publishing or deployment; those require integration validation.

The requested Claude Code CLI model was `claude-haiku-5-5`. All four result objects identify that name in `modelUsage`; this is CLI metadata, not independent provider identity attestation. Each run used print mode with tools, slash commands, hooks, plugins, MCP and session persistence disabled. The reviewer received a static source/diff bundle, executed no tests and did not alter the repository.

## Raw evidence

Evidence root: `/Volumes/AIMATE_WORK/tmp/osstack/smoke/pr237-integration/delivery-contract/`. `b1-audit-N-context.txt`, `.json`, and `.stderr` retain exact review input, output and diagnostics. The fourth round is a focused recheck of confirmed findings and subsequent changes.

| Round | Raw result SHA-256 | Reported P0 / P1 / P2 |
| --- | --- | --- |
| 1 | `e2ea3fb307c686dbf3dea92ad3e0085938957f5b18fbd84e59d1b4731ea99834` | 0 / 4 / 3 |
| 2 | `a1feb7971e636aaf1f7d17f19c48890ab2de9c293db08672c76a28467bdde354` | 0 / 1 / 3 |
| 3 | `9e19577f5b89f2b6e33992034746302c67a7363686a4f6155a34e28f74b840c1` | 0 / 3 / 2 |
| 4 | `be8c8e3b4f2b423bd6c257068cd67aa6ce348e2521dbf383fa5a6d34a747d81f` | 0 / 0 / 2 |

## Disposition

- Resume now rejects contract presence/digest mismatch in both directions. A new receipt is mandatory for a new successful attempt; an omitted reference cannot fall back to a prior attempt.
- V2 verification comes only from the trusted host policy registry. Contract hashes select existing commands and cannot execute raw contract strings. Canonical budget references use `policy:<digest>`; local execution maps the host's actual budget to existing cooperative Loop controls.
- Trust-kernel classification covers the new contract/host/Loop/context sources. The fourth review identified the actual `knowledge/src/context-budget.ts` path; that P2 was corrected with a focused R3 regression.
- Receipt integrity now carries the same pre-check snapshot through post-review and final staging/capture. It hashes every tracked worktree file, candidate untracked file and the ignored-path set. Hidden index flags, new ignored paths and post-review mutations fail closed. Rename source and destination scope is checked before verification; the older staged porcelain parser also checks both ends.
- Host Git reads disable external diff/textconv, fsmonitor and system/global configuration. V2 staging and commits use hardened options and independently reject local clean/smudge/process filters; a real marker-file counterexample verifies neither stage nor commit executes them. This resolves the fourth review's second remaining P2 concern.
- Live receipt verification uses current tree/diff/workspace digests and only accepts known persisted base/commit/merge HEADs. Provider/model independence explicitly follows the existing reported-identity rule, not an unimplemented provider attestation guarantee.
- PR-only publication reuses the existing publisher, pushes an exact SHA refspec, validates destination and draft/open state, and returns before merge/CI/deploy. The repeated remote-newline concern was not a bug because `remoteRepository` already trims; the new boundary also trims explicitly and tests use newline-terminated output.
- V1 no-contract JSON shape remains unchanged. Local completion requires the actual successful task, receipt, governance and budget outcome. Failed candidates remain isolated for inspection.

The final independent result was **0 P0 / 0 P1**, with two P2 findings subsequently fixed and directly tested. This does not claim a new independent audit of the entire final integration branch.

## Validation and boundaries

Focused coverage: protocol/core contract suites; autonomy engine, state machine, risk and real Git candidate suites; GitHub publisher; Loop engine; CLI host receipt, actual guarded-local and actual guarded-git suites. Real local Git, SQLite and Loop are used; adapters and remote GitHub commands are controlled test doubles. The context integration checks both prepared and adapter-observed receipt prompt hashes against the exact prompt received by the real Loop's adapter invocation, with a full frozen contract digest.

Builds of the modified protocol/core/autonomy/Loop/GitHub packages and CLI strict typecheck are captured in the evidence root. Component tests do not replace parent full regression, startup budget, actual factory wiring or external-service qualification.

The 100,000-path / 64 MiB workspace snapshot bound is fail-closed. Existing ignored dependency contents are not hashed; this is not hermetic testing, a filesystem sandbox, physical-process stop proof or atomicity against an unrestricted concurrent local writer. Time budgets are cooperative checks, not a hard cancellation SLA. Scout execution remains unavailable until its tool-free boundary is demonstrated. Graph and live publication qualifications remain separate.
