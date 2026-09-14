**Verdict:** No remaining P0. G08 approve (unchanged). G09 approve with the rename change and the documented offline recovery. G10 qualified approve, conditional on the four P1 integration bugs below, which are distinct from the accepted fail-closed tradeoffs.

## P1 integration bugs

**1. Engine retains on internal exceptions that precede any execution.**
`loop-engine.ts` `withLifecycleLease`: `if (this.implementationUnconfirmed || !settled) lease?.retain(...)`.
Trace: `loop.run` with `intervalMs: -1` (or any throw in `runOnceAdmitted` before a task starts: state file JSON corrupt, workspace unreadable, `persistBudgetStatus` write failure) → lease already acquired → `runCyclesAdmitted` throws at validation → `!settled` → `retain` → repo quarantined, global write permit held. In the local CLI (`bin.ts` `unconfirmed = true` → `repositoryLease.retain`) the process then exits leaving a lock file naming a dead pid, and `recover_stale: false` makes every daemon and CLI return locked until the offline procedure. A typo requires stopping all producers. The engine already owns the correct signal: retain only when `implementationUnconfirmed` or when a task execution had begun (`executedTaskCount > 0` or an `executionStarted` flag set before the first adapter/executor call). Exceptions before that point should release. This is an integration bug, not a tradeoff: no external work can exist yet.

**2. Read-only `task.submit` is silently redirected to the serving workspace.**
`daemon.ts` handleTaskSubmit: `if (registeredPath) task.context = { ...task.context, repo_path: registeredPath }` runs for every capability kind.
Trace: `serve --workspace /a`, client submits `code.review` with `context.repo_path: /b` → adapter reviews `/a`, response says nothing. For writes the overwrite is the designed scope pin (the test asserts `/forged` → repo), but it should still be a refusal on mismatch rather than a silent rewrite. For reads it is a correctness bug: a single-workspace daemon can no longer review any other checkout and reports success against the wrong tree. Fix: apply the pin only to `kind === "write"`, and refuse with `bad_request` when a supplied `repo_path` resolves to a different scope.

**3. Renewal fault blocks reads and every repository daemon-wide.**
`governed-execution.ts` `check()`: `if (this.fault) throw this.fault` before the kind test; `fault` is set by any single `renew` rejection and never cleared.
Trace: one repo's `renew` rejects (guard timeout under filesystem stall, EACCES, or expiry if `repo-lock.ts` still rejects expired-but-owned renewals, which I cannot verify from this diff) → every subsequent `task.submit code.review`, every session, every loop tick for every repo returns "repository lease renewal failed" until restart. Losing ownership of one lease justifies quarantining that repo, not refusing reads elsewhere. Fix: on renewal failure, quarantine `scope.repoId` and mark that lease retained; keep the global `fault` only for token mismatch, if at all. Confirm `renew` no longer rejects a still-owned expired lease.

**4. Guarded autonomy confirmation criteria disagree between daemon and CLI.**
Daemon `resumeGuardedAutonomy`: `confirmed = status === "completed" || status === "needs_approval"`. CLI `bin.ts` resume and delivery: `confirmed = result.status !== "blocked"`. Same `runtime.resume`, two liveness interpretations. If the runtime can return `failed` or `rolled_back` after the agent has fully exited (ordinary verification failure), the daemon quarantines on every failed run while the CLI releases. One of them is wrong. Pick the criterion from the runtime's actual semantics: which statuses guarantee no descendant is still running, and use it in all three sites.

## Fail-closed tradeoffs (accepted, with consequences to document)

- **Cancel without `confirmStopped` quarantines.** Any production adapter lacking `confirmStopped` turns `task.cancel`, client disconnect, and schema parse failures into offline recovery. Whether cancel is operable at all depends on which shipped adapters implement it; state that in the C3 delivery note. The 1 s bound in `confirmAdapterStopped` is tight for a real SIGKILL plus `close`; a false negative here is permanent quarantine, so consider 5 to 10 s.
- **Queued waiters behind a retained lease hang forever.** Retain keeps the repo permit, so a `loop.run` RPC queued on that repo (no signal) never responds. Consider rejecting pending `FifoSemaphore` waiters at retain time so callers get "reconciliation required" instead of a silent hang.
- **Foreground CLI SIGINT leaves a dead-pid lock.** No signal handler in the local loop or delivery path; Ctrl-C is the common CLI exit and now costs an offline recovery. A SIGINT/SIGTERM handler that runs the same confirm-or-retain logic is cheap and does not weaken the contract.
- **`serve` without `--workspace` refuses all write `task.submit`.** Intentional, but a behaviour change for existing deployments; log it clearly at startup.

## P2

- `release()`: `released = true` then `lock.release()` throws → `releasePermits` skipped, `activeRuns` entry and global permit leak with no quarantine marker. Wrap in try/finally or quarantine explicitly so the operator sees it.
- Legacy `context.repo_id` such as `example-web` is passed as a `repoId` expectation and rejected as mismatch. Ignore non-`repo-<sha>` values with a warning.
- `--daemon` loop results silently lost `probe_observation` and `learned_lessons` (the diff removed those calls, not just artifact writing). Confirm intentional.
- `acquireSessionAdmission` rejects another worktree of the registered repo since it compares `workspacePath`, not `repoId`. Fine if intended; document.
- `bin.ts` `"not a git repository"` match is still English-only; now fails closed, so downgrade from prior P1.
- `resumeGuardedAutonomy` reads `row.workspace_path`; verify the column exists after the migration in this batch.
- Prior P2 on per-tick `autonomyHealth()` cost stands; measure against the tick budget.

## Decisions

- **G08:** approve.
- **G09:** approve. Guard-serialized `rename` resolves the exFAT/FUSE concern. Verify `renew` on an expired but still-owned lease (see P1 3).
- **G10:** qualified approve for C3 prerequisite scope. Nested `runCycles` and unregistered serve workspace are confirmed fixed. Merge after P1 1 through 4; P1 1 and 3 are the ones that convert routine errors into offline recovery and should not ship as-is.
