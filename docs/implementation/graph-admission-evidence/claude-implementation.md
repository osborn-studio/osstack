**Verdict:** G08 approve. G09 approve the protocol with two required fixes before merge. G10 has three P0 integration defects that turn ordinary cancels and adapter failures into permanent repository quarantine and daemon-wide write lockout.

## P0

**1. Retain fires on every abort or exception, no adapter can confirm a stop, and retain leaks the global write permit.**
`packages/cli/src/daemon.ts` ~691 (session start finally), ~1003 (session turn finally), ~3344 (task submit finally), ~3062 (guarded autonomy finally). `packages/cli/src/governed-execution.ts` retain ~78, release ~80.
Trace: user calls `task.cancel` → controller aborts → `boundedAdapterEvents` rejects after 1 s grace → finally sees aborted → `confirmAdapterStopped` returns false because no adapter in this snapshot implements `confirmStopped` (no `packages/agents` change in git status; if the property is not on `AgentAdapter`, strict typecheck fails outright) → `retain` → repo added to `quarantinedRepositories`, file lock kept, and `releasePermits` never runs. The global `writes` FifoSemaphore permit and the `activeRuns` entry leak. After `DEFAULT_WRITE_CONCURRENCY` such events the daemon blocks every write for every repo with no timeout. After a daemon restart the lock file names a dead pid and `recover_stale: false` returns Busy forever. Same path for: client disconnect mid-task (`sock.write` failure now aborts), any `AgentSessionEventSchema.parse` failure, any throw inside `runOnce`, and any guarded autonomy result other than completed/needs_approval, including an ordinary test failure.
Smallest fix: in `retain`, release the global and repo semaphore permits and `activeRuns` entry but keep the file lock and the quarantine set. Drop `|| controller.signal.aborted` when `settled` is true, since normal iterator exhaustion is already accepted as release on the non-abort path. Add one operator RPC or CLI verb that clears a quarantine entry and removes the lock file, otherwise G10 cannot be operated.

**2. Nested lifecycle lease in `runCycles` deadlocks or leaks.**
`packages/loop/src/loop-engine.ts` 221-225 and 305-319. `packages/cli/src/daemon.ts` ~1311-1317.
Trace: `runCycles` → `withLifecycleLease` acquires lease A → `runCyclesAdmitted` calls `this.runOnce()` per cycle (the diff did not redirect it to `runOnceAdmitted`) → `withLifecycleLease` again → daemon wrapper overwrites `held` with a second `acquireDaemonRunSlot`. With `loopId` set: "run already admitted or queued" thrown. Without it: the second acquire waits on the repo FifoSemaphore held by lease A, no signal, forever. Even when it resolves, lease A is unreachable and never released.
Smallest fix: `runCyclesAdmitted` calls `runOnceAdmitted`. Also make the daemon wrapper refuse a second call instead of overwriting `held`.

**3. `task.submit` write capabilities are refused unless `adapterWorkspaces` is registered, and nothing registers it.**
`packages/cli/src/daemon.ts` ~3287-3296, `governed-execution.ts` acquire ~36.
Trace: write capability → `workspacePath` omitted because `ctx.adapterWorkspaces` is undefined → `trusted repository scope required for writes` → every write task fails. When a client also passes the pre-G10 `context.repo_id` such as "example-web", it is now treated as the expected `repo-<sha>` and rejected as identity mismatch.
Smallest fix: wire `adapterWorkspaces` from `serve`, and only pass `repoId` as an expectation when it matches `/^repo-[a-f0-9]{64}$/`; otherwise ignore it with a warning.

## P1

- **Global admission fault on lease expiry.** `governed-execution.ts` ~66-73, `repo-lock.ts` renew ~248. Machine sleep or any event-loop stall over 40 s → `renew` rejects with "lease expired" → `this.fault` set for the daemon lifetime → all admissions refused until restart. Expiry never permits stealing (alive check at ~301), so refusing renew of a still-owned lock protects nothing. Fix: drop `active()` from `renew`, or make the fault per-lease and reserve the global fault for token mismatch.
- **`link()` on the primary acquisition path.** `repo-lock.ts` publishOwner ~196. Hard links fail with EPERM on exFAT and several FUSE volumes; the old code used `open(wx)`. Under the guard there is no race, so always `rename`.
- **Abandoned guard wedges the repo with no recovery.** `repo-lock.ts` withMutationGuard ~162-183. SIGKILL or power loss inside any of the 20 s renewals leaves `repo-*.lock.guard`, and every later acquire, renew, and release throws after 2 s. Fix: write holder pid and token into the guard dir and ship an explicit administrative recovery command. Same command covers the daemon-crash case where the lock file names a dead pid and `recover_stale: false` returns Busy forever.
- **`release()` failure leaks permits.** `governed-execution.ts` ~80-88. `released = true` is set, then `lock.release()` throws on guard timeout or EACCES, and `releasePermits` is skipped. Wrap in try/finally, or quarantine the repo instead of leaking the global permit.
- **Standalone Loop gate crashes on localized git.** `packages/cli/src/bin.ts` 9991-10003 and 10142-10154. The rethrow condition matches the English "not a git repository" only. Set `LC_ALL=C` in the scope resolver env. The block is duplicated verbatim; extract it. Verify `--daemon` is actually routed before this point, otherwise the flag alone skips the gate.

## P2

- `executeReservedSessionTurn` and `loop.run` outer catches label every error `admission_denied`, including engine option errors and session persistence conflicts. Session start reports policy denial as `agent_failed`. Narrow the catch to the admission call.
- `checkHealth` now runs `ctx.autonomyHealth()` synchronously on every write admission, including every loop tick, where before only the cached value was read. Combined with about a dozen git spawns per tick across scope resolution and policy consults, measure against the tick budget.
- Removing `break` on terminal events means an adapter that yields a terminal event but never closes its generator holds the lease forever. Abort with a bounded grace after terminal.
- Policy gate: a prunable primary worktree makes `realpath` fail and denies with an ENOENT message. A nested `task.submit` from an adapter to the same repo now deadlocks on the repo semaphore. Verify no adapter re-enters the daemon.
- Rollout: old daemons lock under the OSSTACK_HOME root, new ones under commonDir, so mixed versions do not exclude each other.
- Test fixture locks under `osstack/repo-locks` while production uses `osstack/writer-locks`.
- `resumeGuardedAutonomy` reads `row.workspace_path` where the old code used `row.repo_id`. Verify the column exists.
- PID reuse after reboot makes a dead owner look alive forever; record process start time later.
- G08: a queued run at generation 0 cannot be projected to cancelled or failed because `checked(_, true)` demands a live lease, so the daemon must lease it first. `stoppedWorker.confirmedAt` is compared to `updatedAt`, which daemon projections also bump, so a valid receipt can be invalidated by an unrelated cancel projection; compare against the last lease mutation instead. Confirm `computeGraphInputDigest` includes `source`, otherwise a replay with a different `parentRunId` silently returns the old run.

## G08 and G09 decisions

**G08: approve.** Immediate transactions before reads, CAS on generation and revision, immutable identity and request triggers, stop evidence required even after expiry, counter overflow guards, failed-open connection close, and the cross-process SQLite tests all hold up. The two P2 items above are design notes, not blockers.

**G09: approve conditional** on two fixes before merge: replace `link` with `rename` in `publishOwner`, and provide an administrative recovery path for abandoned guards and dead-pid locks with `recover_stale: false`. The guard-serialized protocol, token identity, lease start at publication, and cross-worktree and cross-home sharing through commonDir are correct and the process-level tests demonstrate them. Renew rejecting an expired but still-owned lease is a G10 integration hazard rather than a G09 correctness defect, but it should be resolved in the same change.
