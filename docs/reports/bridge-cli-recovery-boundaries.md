# Receipt recovery and cancellation boundary audit

Date: 2026-11-07. Source baseline: `75c007667eccd0b24384338cf4f4d4d12848d2de`.
Scope: N9 production factory, live assembly, receipt read adapters, receipt recovery, and adjacent tests. Only the new test and this report are changed.

Result: one unresolved P2, reproduced by two failing tests. One new cancellation control passes. The 19 existing adapter, production ancestry, and real child cancellation tests pass. Production code is unchanged.

## P2: concurrent receipt recovery rejects after another caller confirms the receipt

The exported recovery surface permits overlapping calls. `assembleLiveBridge().revisionRecovery(signal)` creates recovery objects per invocation. Those objects share the same stores. The normal service startup coalesces its own `start()` calls, but that does not serialize independent calls to the exported assembly/recovery surface.

A recovery call captures pending intents before remote reads. Another caller can confirm the same receipt while the first read waits. The first caller then uses the captured pending intent after its await. It attempts to settle a terminal intent and rejects with:

```text
SqliteError: intent_transition_denied
code: SQLITE_CONSTRAINT_TRIGGER
```

Two deterministic schedules reproduce the problem:

1. Create a signed, dispatched revision child. Walk the real Mission state machine to `delivering`. Record its pending push, exact range, and released/stopped W13 journal row.
2. Start recovery A. Suspend its `remoteHead` read after A captures the pending intent.
3. Run recovery B against the same stores. B confirms the receipt. Assert `intent=confirmed`, `chain=awaiting_review`, `child=pr_opened`, the published head, and exactly one `round_published` event.
4. Complete A's read with either the matching published head or a missing ref (`null`).
5. A rejects in both cases. The tests expect successful accounting of the already completed receipt and remain red.

The matching case reaches `recoverPendingReceipts`' route-change branch (`contained-mission-revision-publication.ts:136`). It passes the old pending object to `refuseRevisionPublicationAfterPush`. That function tries to confirm it again at line 481. The missing-ref case reaches `recoverRevision`'s mismatch branch at line 314, then `uncertainPublication` at line 351. It tries to change the now-confirmed intent to uncertain.

The real SQL trigger in `engineering-revision-chain-ddl.ts:150` rejects both terminal updates. Transactions preserve the completed state. The final tests assert the durable snapshot after the rejection, so this report does **not** claim ledger corruption or an extra push. The defect is a fatal recovery result for a successfully settled concurrent receipt. A caller that gates startup or reconciliation on this result can fail its recovery barrier. A normal daemon-start overlap was not reproduced.

Suggested owner action: recheck the current intent inside the settlement transaction after asynchronous reads. Treat an already settled captured row as stale work. Preserve the terminal intent trigger. Cover both the matching and mismatch paths; serializing only one recovery object does not protect separate per-invocation objects or another settlement entry point. This is a proposed correction, not an implemented fix.

## Added coverage

`packages/cli/src/contained-mission-bridge-recovery-boundaries.test.ts` adds three cases:

- Matching late read after concurrent confirmation: fails with `intent_transition_denied`; durable state remains correct.
- Missing-ref late read after concurrent confirmation: fails with `intent_transition_denied`; durable state remains correct.
- Aborted invocation whose missing-ref read completes after another caller confirms: passes. It returns the exact abort reason, preserves the other caller's result, and leaves no pending work on a later scan.

The tests use real SQLite stores, signed dispatch, Mission transitions, and W13 journal APIs. They inject remote facts through the existing read ports. They use explicit Promise barriers, not sleeps or timeout changes. No production writer or App token port is supplied.

The first counterexample run exposed the SQL exceptions. The test was then strengthened to check durable state after each exception before asserting successful recovery. The second run retained the same two failures. Neither regression is skipped or marked as an expected failure.

Existing assertions were not copied as new cases. The adjacent suites already cover pre-aborted commands, remote repository pinning, exact remote ancestry, receipt commit cancellation, service shutdown ordering, and killing a running read child. The new cases add overlap across recovery instances with a real pending receipt.

## Checks and exact results

The checkout initially had no installed dependencies or workspace build output. No full build, test, or typecheck was started.

Environment preparation failures are retained here:

- `pnpm install --offline --frozen-lockfile --ignore-scripts`: exit 1, missing offline `@edgeone/pages-blob@0.0.12` tarball in the default worktree store.
- `pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir /Users/osborn/Library/pnpm/store`: exit 1, `ERR_SQLITE_ERROR`, unable to open the read-only store index for writing.
- Copied the store index to scratch and referenced the existing content files read-only. `pnpm install --offline --frozen-lockfile --ignore-scripts --store-dir /Volumes/AIMATE_WORK/tmp/osstack/recovery-boundaries-store`: exit 1, missing `fast-check@4.10.2` after reusing 443 packages. No download occurred.
- A first adapter-only run with scratch source aliases failed all 12 cases on unresolved `@osstack/protocol/source`. Added export-map subpath aliases in the scratch config.
- A first new-test run then failed all 3 cases before behavior ran because the native SQLite binding was absent. Log: `/Volumes/AIMATE_WORK/tmp/osstack/recovery-boundaries-tests-native-missing.log`.

For the scoped checks, local ignored dependency links use the available offline packages. The scratch Vitest config maps workspace exports to **this checkout's** source. It keeps both hermetic setup files, the existing 20-second limits, and `pool=forks`. The native binding was copied from the installed `/opt/homebrew/lib/node_modules/@osstack/cli/node_modules/better-sqlite3` (12.11.1). The tests load the workspace's 12.10.0 JS package. This is a verification limitation, not a clean frozen-install claim. No other checkout was used or changed.

Exact behavioral checks, run from the assigned worktree root:

```sh
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack node node_modules/vitest/vitest.mjs run --config /Volumes/AIMATE_WORK/tmp/osstack/recovery-boundaries-vitest.config.mjs src/contained-mission-bridge-recovery-boundaries.test.ts --maxWorkers=1
```

Exit 1. **2 failed, 1 passed**, 1 file. Final duration: 1.68 seconds. Both failures report `SQLITE_CONSTRAINT_TRIGGER` / `intent_transition_denied`. The post-failure durable-state assertions pass. Final log: `/Volumes/AIMATE_WORK/tmp/osstack/recovery-boundaries-tests.log`. Initial counterexample log: `/Volumes/AIMATE_WORK/tmp/osstack/recovery-boundaries-tests-first-counterexample.log`.

```sh
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack node node_modules/vitest/vitest.mjs run --config /Volumes/AIMATE_WORK/tmp/osstack/recovery-boundaries-vitest.config.mjs src/contained-mission-bridge-receipt-adapter.test.ts src/contained-mission-bridge-production.test.ts src/contained-mission-bridge-process.test.ts --maxWorkers=1
```

Exit 0. **19 passed**, 3 files. Duration: 2.36 seconds. Includes the existing real child-process abort test. Log: `/Volumes/AIMATE_WORK/tmp/osstack/recovery-boundaries-existing-tests.log`.

```sh
node node_modules/@biomejs/biome/bin/biome check packages/cli/src/contained-mission-bridge-recovery-boundaries.test.ts
git diff --check
```

Both exit 0. Biome checked one file and applied no fixes.

With the parent's complete dependency/build setup, the standard reproduction is:

```sh
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack pnpm --filter @osstack/cli test src/contained-mission-bridge-recovery-boundaries.test.ts --maxWorkers=1
```

That standard command was not run here. The source-alias checks do not establish package build/export correctness, full type safety, CI acceptance, or Linux coverage.

## Boundaries and remaining gates

No P1 was demonstrated. The one P2 remains unresolved because production edits are outside this worker's ownership. The two failing tests must be resolved by the production owner before treating this contribution as green.

The live production gate remains closed. No deployment, service enablement, push, PR, merge, repository setting change, or external message occurred. Cloud Grok Bots sharing Rubebun-Jadeem and the paused PR Reviewer do not establish formal `CHANGES_REQUESTED` capability. This audit does not replace N10, N11, or N13 acceptance evidence.

## Commit transport limitation

Normal `git add` failed because this sandbox cannot create the linked worktree's index lock under the main repository's `.git/worktrees/bridge-cli-recovery-boundaries`. No index or branch ref was changed there. The two owned files are packaged as one conventional commit in a scratch-only Git object store, with the audited baseline as its parent. A portable bundle is at `/Volumes/AIMATE_WORK/tmp/osstack/recovery-boundaries.bundle`. The assigned worktree branch remains at the baseline; the parent must import the bundle. The scratch repository uses the original object database only as a read-only alternate. It is not an additional checkout or worktree.
