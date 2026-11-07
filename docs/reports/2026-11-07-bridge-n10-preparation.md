# N10 acceptance branch preparation

This report describes local branch construction and static comparisons. It is not a test, CI, approval, deployment, or Phase 5 acceptance verdict.

- Branch: `codex/bridge-phase5-acceptance` in the existing `bridge-check-retry` worktree.
- Base: `origin/main` at `a9b1a60515db0a10e604c1df9ee693c5c907d713`.
- Runtime dependency: frozen `codex/bridge-production-runtime` at `287864a5529d4f811267c1adeb7c4caed10105e5`, retained as an ancestor. A future main-base PR must say **merge after N9**, with the eventual N9 PR number supplied by the main session.
- The dependency's last runtime source change is `c486bd69`, the cherry-pick of `d8964643`: recovery cancellation belongs to its invocation and does not poison later shared reads. GLM-5.3 re-review passed for that runtime delta. The user-designated Reviewer is paused; there is no formal CR from that Reviewer.
- The normal production acceptance lock remains closed. Real sandbox `--execute` has not run.

## Imported scope

N10 includes the real sandbox driver `5afacf53`; property/source-mutant work `34af1e10`, `1ae47396`, `075874c1`, `1d99f7a7`; model/runner work `79efdaf8`; publication/property corrections `b8c3d453`, `78abb868`; graph deadline test fix `b9baca64`; and the three loop fixture fixes `c0387507`, `3286bfb5`, `5cd15888`.

Evidence documentation `1813135b` and `9f056eab`, graph-plan documentation `0a344499`, and the N9 static preparation report are included. Only the graph-plan cherry-pick conflicted: its latest verified text was retained over older main progress claims. There were no source conflicts in this composition.

The `.agents/skills/verify-osstack/SKILL.md` add/modify/delete sequence (`be180ae6`, `a57f04e7`, `76ba33fd`) is excluded. Both its path history and net diff are empty relative to the main base. Existing `.cursor/skills/verify-osstack` is unchanged.

## Static equivalence and explicit additional deltas

Before the final mutation-classifier/constructor-property review delta, `packages/`, `scripts/`, and `pnpm-lock.yaml` match candidate `78abb868` exactly except:

1. The four source/test paths changed by N9 `d8964643` / `c486bd69`: assembly, production factory, receipt adapter, and service-wiring regression.
2. `packages/cli/src/graph-review-findings.test.ts`: #418's `2da03590` fixture-order correction, inherited through N9. It reads the latest revision before revocation and persists cancellation without an intervening await.

The extra `.changeset/bridge-recovery-cancellation-scope.md` belongs to the runtime delta. Reports and graph/evidence documents are separate metadata changes. Accordingly, the correct pre-classifier equation is **candidate 78 + d896 + the #418 fixture correction**, not simply candidate 78 + d896.

The final independent delta `87375400` is included as `4cae9fe4`: the mutation classifier rejects signal/spawn/timeout/import failures and requires a real AssertionError; its author reports fifteen light mock units passing. The constructor property now uses exact target equality with three extra-capability negative controls. Core property comments accurately separate store linearization from production journaling. Historical mutation/source provenance and GLM triage are archived alongside the evidence. These changes require fresh targeted verification and final-head/source-SHA-bound 10k runs; earlier green logs do not certify the strengthened tests.

Static manifest equality now holds exactly for **candidate 78 + N9 c486/d896 + #418 2da fixture + 87375400 review delta** over all tracked `packages/**`, `scripts/**`, `pnpm-lock.yaml`, and `.changeset/**` entries. There are 1,693 entries and zero unexpected differences. The manifest SHA-256 is `49e6a968f0d22d35dbc64f5bd4e4d6f9a942dfd6f76aae7fd5f47c34fc49d705`, computed from sorted lines `mode blob path\n` using Git blob IDs. Documentation-only commits do not change this manifest.


## Preparation checks and remaining gates

Only static checks and dependency reuse were performed here: N9 ancestor relation, candidate diff, duplicate-skill history/net-diff checks, `git diff --check`, and a read-only inspection that all nineteen mutation anchors occur exactly once. The TLA module is byte-identical to recorded model commit `036d2be2`; this comparison does not complete the two pending broad TLC runs.

`pnpm install --offline --frozen-lockfile --ignore-scripts` reused cached dependencies successfully. No build, typecheck, whole-workspace suite, mutation campaign, property campaign, TLC process, live smoke, or external publication ran as part of this branch preparation. The parent session is still verifying the frozen earlier candidate serially; its worktree was not changed.

The parent session will run the final targeted checks and head-bound evidence before publishing a PR. Five independent Codex CLI verification worktrees based on preparation commit `75c00766` are separate follow-up work; their future tests/reports have not been silently included or claimed passing here.

## Final property source hashes for the parent verification controller

- `packages/core/src/bridge/revision-chain.property.test.ts`: SHA-256 `add72f411d69aab16eba40258289a7e6635cb8b12b22f82b8a4d92ff918d7cf8`.
- `packages/cli/src/contained-mission-revision.spec-property.test.ts`: SHA-256 `10a75a3047c03685e2b94ab45a78bf5c4704d27e097f3724a264d3c17601ac4f`.

Record the final branch HEAD as well as these source hashes at command launch. This preparation does not retroactively attest earlier logs. The following five independent CLI worktrees remain separate: recovery-boundaries, sandbox-guards, operator-readiness, installed-release-audit, and ledger-property; later integration changes require a new final-head comparison.
