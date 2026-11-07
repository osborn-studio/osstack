# Receipt convergence fix review

Date: 2026-11-07. Reviewer: independent `gpt-6.1-sol` worker.

Reviewed implementation: **`1f099d65a7c510550a51ba47ae198bc6651d9852`**, `fix(bridge): converge concurrent receipt recovery outcomes`, on `codex/bridge-receipt-convergence`. Base: N9 runtime `287864a5`; preceding regression-test commit: `09f0a5e8`. The assigned review checkout remains at parent commit `7bb61703`.

Verdict: the fix resolves the two original async-read regressions, but one additional **P2 convergence failure** is reproduced at the SQLite write-lock boundary. Request a targeted correction before calling convergence complete. No durable corruption or P1 is demonstrated.

## P2: successful recovery does not revalidate terminal state inside the confirmation lock

In the reviewed source, `recoverPendingReceipts` checks `getIntent(intent.intent_id).state !== 'pending'` after `await recoverRevision(...)`. That check is outside the write transaction. A different SQLite writer can complete the receipt before this caller acquires its confirmation lock. `confirmRevisionPublication` then takes `BEGIN IMMEDIATE`, rechecks the route, and throws `confirm_route_changed` because the intent is already confirmed. The strict confirmation guard protects the winner, but the recovery caller still fails instead of converging.

The new test `packages/cli/src/contained-mission-bridge-recovery-authority.test.ts` establishes this different window. It uses real SQLite connections, a real second Node process, the signed dispatch fixture, Mission FSM, W13 journal, and production confirmation/store methods. It does not replace a store method or use a delay to choose the winner.

Reproduction schedule:

1. Prepare a verified delivering child, its exact pending push range, and a released/stopped W13 record.
2. Writer B takes the owner-fenced write transaction on a second connection and signals that it holds the lock. It has the same current, valid owner token as A; it does not replace the daemon owner.
3. Recovery A reads valid remote receipt and PR facts. Its pre-transaction intent checks still see pending because B has not committed.
4. A attempts `BEGIN IMMEDIATE`. The supported SQLite `verbose` trace signals B to complete its normal production confirmation transaction, then release the lock.
5. B commits the confirmed intent, opened child, awaiting-review chain, check intent, and publication event. A then acquires the lock and rejects with **`Error: confirm_route_changed`**.
6. Assertions verify that B exited successfully, A attempted the write lock, and the durable state remains `intent=confirmed`, `chain=awaiting_review`, `child=pr_opened`, with the correct head and exactly one `round_published` event. Only the assertion that A should complete without an error fails.

This differs from the two original REDs: those release an asynchronous remote read after another recovery completes. Those tests pass at this head. The new test releases a competing writer when A attempts the database write lock, after A has already accepted the successful observation and checked pending outside the transaction.

Impact is an exported recovery/store API convergence failure with another writer that holds the same valid owner token. The test does not prove that ordinary single-process daemon startup creates such a second writer. If the product deliberately excludes all same-owner writers on other connections/processes, that restriction needs an explicit contract; it is not enforced by this recovery API. The core store already exposes serialized multiple-writer behavior under `BEGIN IMMEDIATE`.

Suggested correction: put the recovery-specific terminal-intent recheck and selection of confirmation/refusal behavior inside the same owner-fenced transaction that makes the corresponding state changes. Keep `confirmRevisionPublication`'s strict route checks and the SQL terminal triggers. Do not broadly swallow `confirm_route_changed`, owner loss, or SQL errors. No production correction is made by this reviewer.

## Transaction and terminal-state audit

The source audit covers the full `RevisionChainStore` state transitions and DDL, `ContainedMissionStore` transitions and terminal DDL, the owner fence, publication confirmation/refusal helpers, startup recovery, manual reconciliation, runner recovery, live assembly, and production read adapters.

- `RevisionChainStore.transaction` takes `BEGIN IMMEDIATE` and checks the daemon owner inside the lock. Its callback is synchronous. Nested store writes use the same connection/savepoints. A thrown settlement or Mission transition rolls back the outer transaction, including earlier events and reservation changes.
- Confirmed and failed intents reject every SQL update, including an update to the same terminal state. Uncertain intents may become confirmed or failed. Immutable fields bind receipts to the chain, child, repository, branch, old/new heads, base, and range binding.
- Closed chains reject every update. Close voids active reservations atomically. A still-pending receipt may be confirmed after close to account for a past write, but that operation cannot reopen the chain. A completed intent must not be settled again.
- Normal confirmation requires a pending push, matching stopped/released W13 process, publishing chain at the expected old head/base/current child, matching dispatched reservation, and delivering child at the expected revision and candidate. Cancelled confirmation requires `cancel_requested`, ends the child as `cancelled`, stops the chain, and creates no check intent.
- Landed confirmation is a distinct human-resume route. It checks the latest confirmed push, current head/base/child, absence of open push receipts, reservation, delivering child, and proven stop. Convergence must not bypass this route.
- Terminal Mission states cannot change state. Their only permitted row update clears an outstanding stop obligation with evidence. Appending an event is separate. A terminal convergence no-op must not duplicate evidence, publication, or check events.
- A human stop is not a closed terminal chain. Recovery may record a proven landed head while retaining the stop. Grant replacement and child resume have separate authority and unsettled-intent checks.

The original failures were attempted terminal updates. The intent trigger rejected them and the transaction rolled back. Their post-failure durable-state assertions passed. The new failure is also a protected attempted operation: the confirmation route check rejects before settlement. Neither result establishes ledger corruption.

## Correct parts of the reviewed fix

The fix adds transaction-level current-intent checks to `uncertainPublication`, `refuseRevisionPublication`, and `refuseRevisionPublicationAfterPush`. The last helper compares both the captured and current unsettled states before changing the chain or child. These checks protect their write-lock boundaries.

`recoverRevision` checks cancellation before stale-state handling on both read success and read failure. A caller's abort therefore retains priority and its exact reason. Non-stale transport failures retain the retryable receipt error. The production factory still combines each invocation signal with the service-lifetime signal without aborting that shared controller on invocation cancellation. No writer port, token acquisition, process release, or publication attempt is added.

Explicit and manual uncertain reconciliation now ignore late success, missing-ref, and transport-error observations after settlement. Their added tests compare serialized real databases. These no-op checks do not grant write authority: writes still go through the owner fence. Manual uncertain reconciliation has no new per-call cancellation interface; this patch does not claim to add one.

The landed-readback refusal now checks the current child's delivering state, candidate, and chain binding before stopping it. Existing confirmed-landed and cancellation tests pass. The patch leaves the SQL terminal triggers and strict confirmation transaction intact. Its remaining problem is the successful pending recovery path described above.

No additional reproduced P1/P2 is reported. Questions about normal daemon multi-process topology are a stated applicability limit, not an assertion that corruption occurred. No duplicate of the two original async-read tests is added.

## Independent checks

All commands ran from the assigned review worktree with `OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack`, one Vitest worker, and the existing 20-second test/hook limits. No full build, typecheck, or test run was started.

Before the fix appeared:

```sh
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack node node_modules/vitest/vitest.mjs run --config /Volumes/AIMATE_WORK/tmp/osstack/recovery-boundaries-vitest.config.mjs src/contained-mission-revision-publication.test.ts --maxWorkers=1 -t 'startup receipt recovery|startup recovery|routes an already confirmed receipt|stops a confirmed child|confirms the remote fact after cancellation'
```

Exit 0: **11 passed, 136 filtered out**. Log: `/Volumes/AIMATE_WORK/tmp/osstack/receipt-fix-review-baseline-tests.log`.

```sh
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack node node_modules/vitest/vitest.mjs run --config /Volumes/AIMATE_WORK/tmp/osstack/receipt-fix-review-core.config.mjs src/state/engineering-revision-chain-store.test.ts --maxWorkers=1 -t 'limits reservation and intent state transitions|rolls back the whole decision|requires durable writes and a current owner fence|accepts a pending-push base-change stop|treats closed as terminal'
```

Exit 0: **5 passed, 37 filtered out**. Log: `/Volumes/AIMATE_WORK/tmp/osstack/receipt-fix-review-core-contract.log`.

```sh
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack node node_modules/vitest/vitest.mjs run --config /Volumes/AIMATE_WORK/tmp/osstack/recovery-boundaries-vitest.config.mjs src/contained-mission-revision.runner.test.ts --maxWorkers=1 -t 'does not consume a delivery attempt when step 0 has a retryable read failure'
```

Exit 0: **1 passed, 50 filtered out**. Log: `/Volumes/AIMATE_WORK/tmp/osstack/receipt-fix-review-runner-retry.log`. The unchanged runner leaves the child delivering and consumes no delivery attempt across two retryable reads.

At reviewed fix head `1f099d65`:

```sh
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack node node_modules/vitest/vitest.mjs run --config /Volumes/AIMATE_WORK/tmp/osstack/receipt-fix-review-1f099d65.config.mjs src/contained-mission-bridge-recovery-boundaries.test.ts src/contained-mission-revision-publication.test.ts --maxWorkers=1 -t 'receipt recovery concurrency boundaries|startup receipt recovery|startup recovery|routes an already confirmed receipt|stops a confirmed child|confirms the remote fact after cancellation'
```

Exit 0: **14 passed, 136 filtered out**. Includes all three original independent boundary tests. Log: `/Volumes/AIMATE_WORK/tmp/osstack/receipt-fix-review-1f099d65-tests.log`.

```sh
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack node node_modules/vitest/vitest.mjs run --config /Volumes/AIMATE_WORK/tmp/osstack/receipt-fix-review-1f099d65-with-tests.config.mjs src/contained-mission-revision-publication.test.ts --maxWorkers=1 -t 'ignores a stale'
```

This loads the author's exact committed test file and fix source from Git objects. Exit 0: **7 passed, 142 filtered out**, duration 11.42 seconds. Log: `/Volumes/AIMATE_WORK/tmp/osstack/receipt-fix-review-1f099d65-author-tests.log`.

```sh
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack node node_modules/vitest/vitest.mjs run --config /Volumes/AIMATE_WORK/tmp/osstack/receipt-fix-review-1f099d65.config.mjs src/contained-mission-bridge-recovery-authority.test.ts --maxWorkers=1
```

Exit 1: **1 failed**, `confirm_route_changed`, duration 2.15 seconds. Log: `/Volumes/AIMATE_WORK/tmp/osstack/receipt-fix-review-authority.log`. The preceding durable-state assertions pass. This RED is retained.

The first authority-test attempt failed before behavior ran: Node 26.5.0 rejected `stripTypeScriptTypes` with `mode: 'transform'`. That log is retained at `/Volumes/AIMATE_WORK/tmp/osstack/receipt-fix-review-authority-loader-failure.log`. The fixture was corrected to transform individual source modules with the existing esbuild dependency and use an IPC readiness handshake. No timeout was increased. The next run produced the behavioral counterexample above.

Scoped Biome: `node node_modules/@biomejs/biome/bin/biome check packages/cli/src/contained-mission-bridge-recovery-authority.test.ts` exited 0, one file checked, no fixes. An explicit trailing-whitespace/end-of-file scan of both new files passed. Read-only `git status --short` shows only the two owned new files. The fix ref was rechecked after testing and still points to the reviewed head.

## Reproducibility and scope limits

The scratch Vitest plugin loads the reviewed production file with `git show <exact-head>:<path>` at its original module identity. Other production modules are unchanged between the N9 base and this checkout. For the author-test check, the plugin also loads the exact committed publication test file. The new second process loads this checkout's real source; its winning confirmation function and core stores are unchanged by the fix. No other checkout is read or modified.

Native limitation is unchanged: workspace `better-sqlite3` 12.10.0 JS with the available installed 12.11.1 native binding. These source-based checks do not establish a clean frozen install, package-build correctness, full type safety, CI acceptance, or Linux behavior. The author's normal-install results are separate evidence, not this worker's independent checks.

The parent reports that full 22-workspace acceptance at `78abb868` passed 8,882 tests. That earlier run does not cover this new fix or the new authority test.

Only the new report and the new authority test are written in this checkout. No Git index/ref/object writes, bundle import, production source changes, full acceptance run, service enablement, deployment, remote operation, or external message is performed. The parent owns commits and integration. Production acceptance remains closed.
