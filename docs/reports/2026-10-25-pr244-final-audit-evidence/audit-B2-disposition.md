# B2 Graph audit disposition

Scope: authenticated initial Haiku audit of 30fe5eb0; follow-up changes in shared pr244-final-audit checkout. This is engineering triage, not a substitute for the requested final model review.

## F1 — conditional double release: missing context resolved; fail-closed behavior retained

`GovernedExecution.acquire()` returns leases whose `release()` and `releaseAfterReconciliation()` both return without touching permits when `released` is true. `releaseAfterReconciliation` is coalesced while pending. The broker deliberately retains the lease reference when the durable admission acknowledgement fails so trusted recovery can reverify authority and finish **only** the DB acknowledgement. It does not quarantine an already physically released lease (`physicallyReleased` guard). The interface now documents this required idempotence explicitly.

Throwing from the release boundary is intentional: returning an ordinary successful action response could let the host advance the chain while durable admission is still outstanding. The effect's committed truth remains available in the ledger, replays do not execute it twice, and terminal projection rejects `ADMISSION_RELEASE_PENDING`. Existing fault-injection tests at `graph-action-broker-boundary.test.ts` cover physical release failure, retained admission blocking terminal projection, and the exact scenario of physical release succeeding followed by a SQLite trigger rejecting `released_at`. The latter reconciles successfully and acquires a new write permit afterward. No semaphore double release exists with the production lease implementation.

## F2 — unstarted settlement storage failure: safety policy preserved, comment corrected

`GraphActionStore.recordUnstartedOutcome` creates its durable no-admission acknowledgement atomically with the zero-token failed settlement, and enforces exact live owner/generation and no previous admission. `recordOutcome` also runs under its fenced transaction. If that commit fails, the host cannot advertise durable proof of non-execution or refresh a stale generation to release reservations. The unresolved intent remains replay-blocked for trusted reconciliation; this is an intentional recovery requirement during failed storage or lost authority, not a successful execution claim. The catch comment now expressly covers storage failure as well as stale ownership. No hidden automatic retry or weakened accounting proof was added.

## F3 — fixed: inherited Git environment could redirect delivery identity reads

`deliveryGit` now removes all inherited `GIT_*` variables before installing its own safe Git configuration. Regression creates two actual repositories, poisons `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and `GIT_CONFIG_PARAMETERS`, checks the intended HEAD and tree, and verifies a source-file mutation is detected in the intended repository. The new test failed against the old code (other repository HEAD returned) and passes after the fix. Red evidence: `B2-git-red.log`.

## F4 — comment corrected, cancellation regression added

The broker comment now says trusted persistence determines the classification and the broker preserves it. It no longer makes a blanket claim that abort after executor completion is successful. New test finishes a passing check, injects cancellation during the asynchronous independent identity check inside persistence, and expects no success result plus a non-retryable `INTERNAL_ERROR` verification failure. Existing stop-unconfirmed paths remain unknown and require reconciliation.

## F5 — fixed: retry replacement cannot alter trusted execution semantics

Before allocating any retry intent, replacement is now restricted to review/tests and must match a canonical identity of execution kind, plan semantics, command/command-suite or adapter ID/capability/full capabilities. Only per-attempt plan/task IDs and the freshly prepared physical worktree path are excluded. Thus host callbacks can still rebind a freshly isolated verification workspace, but cannot switch command, adapter capability, prompt, limits or operation kind under the old action payload. The independently persisted verification envelope continues to record actual workspace/invocation identity; the existing run fence binds compiler/program identity across recovery. No schema migration or worker-supplied fingerprint is introduced.

The regression replaced a retryable test command with an unauthorized command; old code executed it and allocated attempt 2 (RED, `B2-retry-red.log`). New code rejects before retry allocation and verifies there is still one ledger row and no unauthorized file. Fresh-workspace retry integration is run separately.

## F6 — delegated daemon owner

Worker-log shutdown drain is owned by the parent/daemon agent. This file does not claim it resolved; incorporate their evidence in the consolidated review.

## F7 — measured instead of unsafe caching

An opt-in test (`OSSTACK_REVIEW_INVENTORY_REPORT`) measures a real 31 MiB Git candidate through isolated branch preparation and three repetitions of verify-workspace, actual fixture-adapter invocation and verification-evidence persistence. It retains raw-byte fingerprints at every authority/preimage boundary: caching across those boundaries would weaken timestamp-preserving mutation and ignored/untracked-file detection. Output `B2-review-inventory.json` reports actual durations including Git and evidence I/O. This is a local point measurement, not an arbitrary repository-size, provider, universal latency or concurrent RPC performance guarantee. The existing 100,000-entry and 256 MiB/file safety limits are not latency budgets.

## Context to include in final Haiku review

- `governed-execution.ts` (full file) and `graph-action-broker-boundary.test.ts` resolve F1.
- `core/src/state/graph-actions.ts` `reserve`, `recordOutcome`, `recordUnstartedOutcome`, transaction enforcement and retry admission guard resolve F2.
- `graph-delivery.ts` dispatch/preparation and the verification constructors resolve host-only fresh-workspace retry context.
- Startup/managed-home, worker-log drain, follow-up host configuration and remote/scout review belong to other assigned audit groups.
- Native filesystem host receipt tests exercise actual `link()` successfully on the test filesystem; unsupported filesystems remain fail-closed, not silently overwritten.
- Paid provider/real external environment qualification remains separate.

Validation results appended after completion.

## Validation evidence

- Git environment RED: 1 new regression failed against old implementation, 4 existing passed.
- Retry command identity RED: 1 new regression failed against old implementation, 8 existing passed.
- Focused batch: 99 of 100 passed, including every old test and the 31 MiB benchmark; the newly added cancellation case exceeded Vitest's implicit 5-second default. Its timeout is now explicitly 15 seconds, matching the existing real-Git cases in this file; no production deadline was changed. The original failing run is preserved in `B2-green.log` (filename predates its result). Focused retry result is `B2-cancellation-green.log`.
- Real `graph-delivery.integration.test.ts`: 11/11 passed, including freshly prepared verification retry, repair and real worker cancellation/journaling scenarios.
- `graph-action-broker.test.ts`: 37/37 passed, including new SQLite commit-failure/no-replay regression.
- CLI `tsc --noEmit`: passed after code changes.
- Actual review 31 MiB point measurement on Node 22.22.1/darwin: preparation 6077.44 ms; verify 92.60–333.39 ms; invoke 296.19–574.83 ms; persistence 3533.28–6277.25 ms. These times include all associated Git, stop, authority and evidence I/O, with a fixture reviewer. They expose real nontrivial latency; no arbitrary-size low-latency claim is justified. Raw samples are retained. No cross-boundary cache was added.


# Final B2 disposition (2026-10-24, supersedes chronological claims above)

All Graph code changes are frozen, uncommitted for parent integration. Actual Claude Code CLI claude-haiku-5-5 r10 review found no remaining code blocker but required two documentation corrections. Actual r11 reviewed those exact corrections and returned PASS for the documentation delta, carrying r10 code conclusions on unchanged hashes. Do not describe r11 alone as a fresh whole-PR audit: F6/global QA/CI remain separate. R5 was rejected for prompt length, not an audit pass; all earlier NEEDS_FIX/CONTEXT reports remain preserved.

Final implementation: inherited Git environment removed; retry semantics bound; conservative unstarted failure/replay preserved; release/reconciliation physical completion/coalescing tightened with every reconciliation caller verifying; publication keeps cheap authority around every await and four raw observation boundaries; bounded fd reads and aggregate inventory resource limits; contained final stop proof uses existing30s grace instead of incorrect1s outer race, retains fresh journal+daemon+absence proof. Formal operating-envelope doc describes resource-domain mismatch, materialization-before-ceiling, non-real-time deadlines, adapter overrun, non-atomic transient mutation windows, same-generation intent limits and real-environment gaps. No authority bypass or false-stop confirmation introduced.

Final behavior evidence: r10 graph-verification52 passed/1opt-in skipped,83.43s,exit0 after r9 lease change; r9 lease+broker-boundary37passed,exit0; r4 inventory/governed/broker40passed (inventory unchanged); r9 CLI typecheck0; r4 seven-file lint0+r9 store/lease-three-filelint0. Independent r4 opt-in benchmark1passed89.531s is historical diagnostic on unchanged verification/store/test bytes with stub acquisition callbacks; it is not current real-lease integration evidence. The earlier combined opt-in run failed120s timeout for an unestablished cause and remains recorded.

R11 evidence caveat closed by B2-final-evidence-crosscheck.json: graph-verification-store SHA256 is identical in r3/r4/r9/r10 model manifests and recomputed current source,5f11a70120906b2e65cae5f00aec2303bf6eca8b81e8ea165e35419f0b571300. Stub fixture acquire callbacks also checked in source.

Residual nonblocking work: pre-restore uncompressed admission alignment; exact-default count assertion/growth probe regression/aggregate across-directory regression; more precise per-proof stop failure diagnostics; original adapter runtime qualification; non-atomic same-UID mutations; manual-only recovery for unprovable intents; real Docker/provider/remote/launchd qualification. No full global QA or CI success is claimed here. Parent must run final integrated checks, commit/push and transitionReady only after all PR gates pass.
