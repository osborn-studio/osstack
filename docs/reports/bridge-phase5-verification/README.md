# Phase 5 local verification

Baseline `5602b901`. This branch adds tests, model transitions and reproducible verification scripts. It does not publish or enable live production.

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

All fourteen guard configs produce invariant counterexamples on final model commit `036d2be2`. Outcome-only probes show `ResumeOutcomeSafety` independently detects only the uncertain-intent mutant; the three other historical resume violations are detected by `ResumeSafety`, which retains pre-resume facts. The revised full main and rounds exhaustive runs are still running; no pass is claimed for them here.

Model limits remain: one commit per modeled push, assumed root baseline, exact closed-state reservation cleanup and some R2 reason rewrites. These are explicit abstractions, not implementation proof. The TypeScript property covers real ordered multi-commit ranges and the baseline separately.

5-G real sandbox acceptance is not run. Local Docker/fake GitHub can rehearse process and ledger behavior but cannot establish real GitHub App attribution, installation permissions or ruleset enforcement. See `gaps.md` for the exact required-versus-existing matrix. Phase 5 remains incomplete until the remaining model and real sandbox gates pass.

## Reproduction

```sh
OSSTACK_SCRATCH_ROOT=/path/to/scratch node scripts/verify-bridge-phase5-mutations.mjs
TLA2TOOLS_JAR=/path/to/tla2tools.jar JAVA=/path/to/java \
  OSSTACK_SCRATCH_ROOT=/path/to/scratch node scripts/verify-bridge-phase5-tlc.mjs --bounded
# --mutants runs model mutants; --main runs main, shadow and rounds exhaustively.
```

The full nineteen-entry source manifest requires the production baseline node `bcd20732`; on this standalone verification branch, select the eighteen other mutant names. The mutation runner restores each source file in `finally` and on handled SIGINT/SIGTERM/exit. It requires a passing baseline, distinguishes assertion failures from invalid imports, and writes command results and full logs under the canonical scratch root. Raw logs stay in scratch; `evidence.json` records hashes and concise results.

`model-checks.json` records completed bounded/shadow checks and all fourteen model-mutant counterexamples. `pending-tlc.json` identifies the two broad searches; process scheduling may suspend them during serialized acceptance testing.

`property-provenance.json` compares the original and integration source hashes, the recorded working-tree edit, and the executable-code hash. The log predates the local commit and parent cherry-pick; the later source-only change was an introductory comment. It does not claim that a source hash was embedded in the original run log. `source-mutant-history.json` retains the two initial survivors and shows their later kills; `source-mutants.json` is the final nineteen-name aggregate.

The initial mutation classifier was too broad: a failed-test header alone could count a timeout as a kill. The revised pure classifier requires a genuine AssertionError and rejects timeout, unhandled/import/startup failure, spawn error and signal outcomes; fifteen small mocked classifier tests pass. `mutation-log-audit.json` reclassifies all nineteen existing final logs as genuine assertion kills, with no timeout/signal diagnostics. Historical manifests omitted spawn error/signal fields; this limitation is explicit, and new manifests retain them. No heavy mutation suites were rerun for this audit.

GLM review triage is recorded in `review-triage.md`. The added exact publish-target assertion and extra-capability negative control require the next source-bound final property run; the earlier 10,000-case constructor result predates that test-only strengthening.
