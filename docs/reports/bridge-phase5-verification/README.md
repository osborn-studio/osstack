# Phase 5 local verification

Baseline `5602b901`. This branch adds tests, model transitions and reproducible verification scripts. It does not publish or enable live production.

## Current acceptance snapshot

Final source-bound mutation rerun at `315e7fc49ed2bfa01321cd904a7c2ab04e8e115a`: all 19 mutants killed by actual assertion failures, all baselines pass, zero invalid/timeout/signal/spawn-error results. The unmodified strict harness ran each mutant separately and stopped on any non-kill; it exited zero. Node was v26.5.0. All tracked package/script SHA256 values match before/after and final source diff/status are clean. `final-source-mutants.json` binds the aggregate, raw evidence paths and manifest hashes; this supersedes historical mutation snapshots below for final-source coverage.

Parent final `812` full acceptance: all 22 workspaces, 8,901 passed / 6 skipped; CLI 3,985 passed / 5 skipped. After journal fixes `cf6` + `dab`, only root verification JavaScript changed; Linux Node24 journal validation passed 220/220. Parent reports main `d89cd4a5` with #421 and #422 user-merged; their exact-head CI was green.

Real 5-G **attempt 4 PASSED**, `LIVE_5G_ONLY`, **13/13**, `qualified:true`, exit 0; production **CLOSED**. The [fourth-run report](fourth-run-v2.md) binds driver `c6c3dd93` and installed runtime `81205698`, the immutable report/snapshot hashes, 68 successful independent GETs, exact App A/App B/range evidence and separate real W13 revocation. All 69 host journals are stopped; two decision reservations/missions/claims remain, so `ledger_settled:false`. Attempts 1–3 remain failed/unqualified, including attempt 3's 7/13 failure and later diagnostic. No fifth paid run is authorized. See [current v2 status](current-v2-status.md) for completed scoped post-run reviews and the unchanged [v2 contract](acceptance-v2.md).

The user's full local-code/Grok-approval loop is **not complete**: v2 5-G tests registered-review transport/containment, not Watcher chat failure → local repair. A distinct exact-head CI-failure intake → trusted local verification → bounded repair request is still missing; current dispatch requires actual review IDs and must not fabricate them. Watcher-only chat findings remain a further intake gap. See [product closure gaps and source references](acceptance-v2.md#product-closure-still-missing). No new Bot duties or Reviewer unpause is required; the counted Mission-main human approval gate remains unchanged.

Final source `7f657613` local checks: full explicit-SSD-root suite **8,905 passed / 6 skipped across 22 packages** (CLI 3,989/5), twelve-file Node **369 passed**, final targeted finding mutant validly killed/restored, and GLM static delta review **PASS** with source hash binding. The initial long-socket environment run failed/was aborted 143 and remains preserved. These are separately scoped local results, not live v2 or Grok integration proof; see [current evidence](current-v2-status.md).

## Completed local checks

- Reproduced the two loop process-fixture cleanup failures (114/116). Short unique process titles plus platform-appropriate `ps` identity checks produce 116/116 passing tests. Only recorded PIDs whose exact marker was verified were cleaned.
- `OSSTACK_PROPERTY_RUNS=10000 OSSTACK_PROPERTY_SEED=51007 OSSTACK_PROPERTY_COVERAGE=1 pnpm --filter @osstack/core test src/bridge/revision-chain.property.test.ts`: pass. Coverage: 930 multi-commit ranges, 2,008 reservations, 1,894 dispatches, 1,179 confirmed pushes, 205 uncertain receipts, 258 failed intents, 549 grant-expiry events, 561 cancellations. The generator includes explicit push rejection, cancellation and expiry. Cancellation/expiry are modeled caller stop events; cryptographic grant validation remains in focused integration tests.
- The store/linearization property for invariant 6 checks a synthetic confirmed root `open_pr` baseline plus exact ordered range concatenation, including intermediate commits. Missing baseline, missing middle commit and reordered ranges are rejected. Range ordering follows each intent's `expected_old_head` to `new_head` binding, and rejects a foreign predecessor. The range journal is test-model state; production validation must be verified separately.
- Invariant 5: 10,000 generated root specifications and hostile review texts pass the real spec constructor. Root scope, caps, verification command, verification paths and repair limits stay equal; cloned arrays and caps do not alias the root.
- CLI focused suite: 272 tests in six files pass. The subsequent token-order suite passes 24 tests. A real second-daemon owner claim and the 503/429/readback-exhaustion matrix add four passing cases. Core and CLI typechecks pass after correcting unused fixture locals and explicit callback parameter types; inventory is fresh. Targeted Biome check passes after removing two unused fixture locals.
- Nineteen real TypeScript/DDL source mutants are killed by their assigned unit/integration suites (independently from the property suites) (eighteen in this branch plus the baseline-omission mutant in the parent integration tree); `source-mutants.json` records commands and outcomes. The parent baseline run used production node `bcd20732` and its signed-grant test; the harness reported killed and exited zero. TLA mutants are reported separately.
- Revised bounded exhaustive TLC: 2,068,903 generated / 303,148 distinct states, depth 23, empty queue. Bounds: one reviewer, one review submission, one attempt, one outsider write, two-round hard cap. Shadow: 67,673 generated / 11,897 distinct, depth 13. No simulation result is used as model-checking evidence.

## Failure history and limits

One long synchronous property run passed its assertions but Vitest timed out on worker RPC updates under CPU contention. The property now yields between generated cases; the final 10,000-case run with linked intent ranges exits zero in 48 seconds.

The first mutation run found an ordinary-push survivor. A bare-Git regression now resets the remote to an ancestor after precheck. The exact old-head lease rejects this intervening write; removing it fails the test. The revision-denial mutation initially selected runner tests, which do not exercise the real port; switching to the existing ports test kills it.

The first model extension let a human fail an uncertain receipt while a released process could still apply it; TLC found `WriteAheadIntent`. Settlement now waits for process release resolution. The first broad run then found an `Inv4` ghost error after a same-child human resume. That human decision now clears the detection ghost. Failed logs are retained in the evidence manifest; they are not passes.

All fourteen guard configs produce invariant counterexamples on final model commit `036d2be2`. Outcome-only probes show `ResumeOutcomeSafety` independently detects only the uncertain-intent mutant; the three other historical resume violations are detected by `ResumeSafety`, which retains pre-resume facts. The revised full two-reviewer main run completed with no error: 553,491,833 generated / 69,290,566 distinct states, depth 48, empty queue, process exit 0. Its 1h01 wall time includes a scheduling suspension for parent serialized acceptance. The three-review full-rounds run also completed without error: 709,628,051 generated / 95,121,536 distinct states, depth 46, empty queue, exit 0. Its 1h32 wall time includes the same scheduling suspension. The raw TLC fingerprint estimates are retained in model-checks.json; this is a bounded model-checking result, not an absolute mathematical guarantee.

Model limits remain: one commit per modeled push, assumed root baseline, exact closed-state reservation cleanup and some R2 reason rewrites. These are explicit abstractions, not implementation proof. The TypeScript property covers real ordered multi-commit ranges and the baseline separately.

Earlier execution-status statements are historical; attempts 1–3 remain failed/unqualified and attempt 4 passed its sandbox scope, as recorded in [current v2 status](current-v2-status.md). Local Docker/fake GitHub can rehearse process and ledger behavior but cannot establish real GitHub App attribution, installation permissions or ruleset enforcement. See `gaps.md` for the exact required-versus-existing matrix. The fourth run supplies the real v2 sandbox gate evidence. Production and external Grok/product-loop gates remain separate and incomplete.

## Reproduction

```sh
OSSTACK_SCRATCH_ROOT=/path/to/scratch node scripts/verify-bridge-phase5-mutations.mjs
TLA2TOOLS_JAR=/path/to/tla2tools.jar JAVA=/path/to/java \
  OSSTACK_SCRATCH_ROOT=/path/to/scratch node scripts/verify-bridge-phase5-tlc.mjs --bounded
# --mutants runs model mutants; --main runs main, shadow and rounds exhaustively.
```

The full nineteen-entry source manifest requires the production baseline node `bcd20732`; final integrated source `315e7fc4` includes it and all nineteen passed the strict rerun. The mutation runner restores each source file in `finally` and on handled SIGINT/SIGTERM/exit. It requires a passing baseline, distinguishes assertion failures from invalid imports, and writes command results and full logs under the canonical scratch root. Raw logs stay in scratch; `evidence.json` records hashes and concise results.

`model-checks.json` records all four completed normal configurations and fourteen model-mutant counterexamples, including verbatim broad-run fingerprint estimates. `pending-tlc.json` is empty: both broad searches finished, and no owned TLC process remains running.

`property-provenance.json` compares the original and integration source hashes, the recorded working-tree edit, and the executable-code hash. The log predates the local commit and parent cherry-pick; the later source-only change was an introductory comment. It does not claim that a source hash was embedded in the original run log. `source-mutant-history.json` retains the two initial survivors and shows their later kills; `source-mutants.json` is the final nineteen-name aggregate.

The initial mutation classifier was too broad: a failed-test header alone could count a timeout as a kill. The revised pure classifier requires a genuine AssertionError and rejects timeout, unhandled/import/startup failure, spawn error and signal outcomes; fifteen small mocked classifier tests pass. `mutation-log-audit.json` reclassifies all nineteen existing final logs as genuine assertion kills, with no timeout/signal diagnostics. Historical manifests omitted spawn error/signal fields; this limitation is explicit, and new manifests retain them. No heavy mutation suites were rerun for this audit.

GLM review triage is recorded in `review-triage.md`. The strengthened exact publish-target assertion and extra-capability negative control passed in the final source-bound run on `f7f0615a36686ccfde1716a68fee9fd97bb09e15`; the earlier constructor result is retained only as history.

Final source-bound acceptance: `final-property-runs.json` records both 10,000-case runs on integration HEAD `f7f0615a36686ccfde1716a68fee9fd97bb09e15`, seed 51007, max/minWorkers 1. Each log embeds startup and completion HEAD plus SHA256 of both tests, the store, spec builder and lockfile. Both runs exited zero, kept identical source hashes, and observed a clean tracked tree. The parent serialized full repository suite passed on its stable pre-strengthening snapshot; no new full repository run is claimed here.

`final-source-checks.json` records the final integration CLI typecheck and fifteen classifier units, both exit zero with stable HEAD/source hashes. The final constructor run includes the exact-target and extra-capability negative control, closing GLM F5.

The explicit §5.6 `extra_repair` clause has a separate positive runner regression: a real ledger exhausts repair cycles, stops the chain as `child_halted`, and resumes the same child/round before its next launch. The isolated case passes; removing `acknowledgeAdvance` makes that same case fail a real assertion. `extra-repair-evidence.json` records source hashes, baseline exit 0 and mutant kill. Only this new case and its mutant were run; no full suite or property rerun was needed because their source files were unchanged.

Completed local model acceptance comprises four separately scoped normal configurations (bounded live, two-reviewer live main, full three-review rounds, and shadow), plus fourteen model-mutant counterexamples. The reports preserve scope assumptions and TLC fingerprint collision estimates. The later fourth-run real sandbox attribution/ruleset/timeline evidence is linked above; it remains separate from these local model results.
