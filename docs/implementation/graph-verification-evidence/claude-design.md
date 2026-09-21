Reviewing the C6 design against the supplied broker, admission, worker runtime and protocol code. Findings are ordered by how much they change the work, with the change or test each one demands.

## Blocking holes

- **Epoch advance cannot happen on the current broker.** A binding carries one fixed epoch, `unregister` adds the connection to a permanent retired set, and `register` refuses retired connections. So a G20 repair route to epoch 1 has no legal path for the same worker connection. Add a fenced `advanceEpoch(connection, nextEpoch, actions)` that requires the run revision, checks every epoch-0 slot is settled or explicitly carried, and rejects if any retained lease exists. Do not solve it by registering a fresh token object per epoch, because `handle` then needs a mutable socket-to-token map that is itself unfenced.

- **A normal exit 1 from the tests command currently becomes unknown or terminal failed, never a confirmed `passed:false`.** The command wrapper emits a done event with status failed, and the line that throws on `candidate.execution.failure_code` turns that into an unknown outcome with a retained lease. Even if that line is relaxed, the outcome path ignores the mapper result whenever evidence status is failed. The mapper cannot fix this alone. The broker needs a structured termination record on the evidence with exit code, signal, timed-out flag and stop receipt, and a gate that accepts a `tests` result on failed evidence only when the exit code is an integer, signal is null, not timed out, and not aborted. Test the three sibling cases explicitly: exit 1, SIGKILL after the 120 second timeout, and abort mid-run.

- **Cancel after start is recorded as terminal failed, not cancelled.** When the signal fires after invocation and stop is confirmed, evidence status is failed and the ledger gets failed with retrySafe false. G20 cannot tell that from a crashed reviewer. The ledger already has a cancelled state. Record it, with the stop receipt as evidence, whenever `signal.aborted` is true at settlement.

- **The G20 join has no authoritative input source inside the worker.** The worker only sees `WorkerActionResponse` values cached in langgraph task writes. Nothing in the protocol carries a ledger snapshot with attempt or budget counters to the worker. And once the join runs inside `ctx.task`, replay after resume returns the cached verdict, so an unknown that was later reconciled to confirmed is never re-seen. Decide it now: the worker join is a proposal, the host recomputes the join from the ledger under the run fence, and the single effect is a host-written epoch transition row with revision CAS. Report the checkpoint copy as a cache, not as the recomputation.

## Two workspaces and evidence provenance

- **The override must reach five places, not one.** Today the binding path drives admission `acquire`, the `plan.worktree_path` equality check, the workspace object passed to `executeCandidateImplementation`, the shell `cwd`, and the retained reconciliation context. Miss any one and the reviewer adapter gets the writer worktree in its task while the lock is taken elsewhere. Restrict overrides to review and tests, reject them on implement, repair, freeze and workspace actions, and apply the same absolute-path, NUL and workspace-id checks as the binding.

- **Define repo identity for restored repos before claiming independence.** Read leases still resolve repository scope and `retain` quarantines by repoId. If repoId is content-derived, a stuck reviewer quarantines the writer repo and blocks the repair epoch, and the tests writer lock collides with the retained freeze lease. If it is path-derived, state that, and add a test where reviewer read, tests write and a retained writer lease coexist without deadlock.

- **Restore method decides whether `.git` is really unshared.** A worktree add gives a gitfile pointing at the writer's common dir. A local path clone hardlinks objects by default. The verify callback should assert the common dir is inside the repo, no alternates file, HEAD equals the action's candidateRevision, and a clean tracked tree. Clone from the artifact bundle with hardlinks disabled.

- **Post-stop re-verification is mandatory, and its timing matters.** The writer-authored test script runs as the same UID in parallel with the reviewer, so it can rewrite the reviewer repo mid-review. Re-verify after `confirmStopped`, not after the generator ends, and put pre and post tree hashes into the evidence blob so the digest covers them. Define the tests rule precisely: HEAD and tracked tree unchanged, untracked output allowed.

- **Review and tests results cannot say where they ran.** Those result kinds carry no workspaceLeaseRef, so the ledger records a verdict with no binding to the restored repo. Put the restored repo lease ref, path and HEAD into the evidence blob, and have the verify callback assert the override path is the repo leased under the action's workspaceLeaseRef.

- **Reviewer independence is an id string comparison unless you bind more.** Different `adapter.id` proves nothing about a shared session. Require a fresh session id never used by any implement or repair action in the run, forbid any feedbackRef or writer transcript in the reviewer plan, and record adapter id, session id and prompt digest in the evidence.

- **Pre-invoke verification must run before `beforeEffect`.** If it throws after `markRunning` the outcome becomes unknown with a retained lease instead of a not-started retry-safe failure.

## Classification, budgets, source binding

- **The ledger's failed record is a message string, so G20 cannot classify.** Not-started, adapter failed, verification failed and now cancelled all land in the same state with prose. Add a structured code on the failed outcome, and require an evidenceRef even for verification failures so the malformed output is retained. G20 then needs a fifth category beyond failure, skipped, unknown and wait: failed with retrySafe true, awaiting an explicit host retry. Do not let it be read as terminal or as a wait for reconciliation.

- **Deadline and action-start limits are not enforced on the retry path.** The broker fences lease expiry only. If `authorizeRetry` is the sole guard, any host loop can re-issue past the spec deadline. Enforce deadline, maxActionStarts and maxBranchAttempts inside the ledger `retry` and `reserve` transactions, and have the snapshot return remaining counts computed in that same transaction. Otherwise the pure join can route repair and the ledger then refuses it, leaving a run with no defined terminal state.

- **State the counting rule for starts.** Whether a not-started failure consumes maxActionStarts changes behaviour under quarantine. Either answer is fine, but the G20 snapshot and the BigInt accounting must agree, and a test should pin it.

- **The program digest binds bytes, not the compiler.** On resume the daemon must recompile the spec, compare against the stored digest and fail with CHECKPOINT_INCOMPATIBLE on drift. Pin the golden digest of the emitted epoch-0 source in a test so a compiler change is a visible test failure. Include a registry version in the identity.

- **Data URL imports still resolve `node:` builtins.** Self-contained is not enforced by the import mechanism. The compiler test should assert the emitted text contains no import statements, dynamic import, require, or process references.

- **Prove replay ordering with the real Functional API.** Task results are keyed by name and call order. Test resume where review is confirmed and tests returned unknown, then reconcile and resume again, and assert the program re-asks the ledger for the tests slot rather than treating the cached unknown as final.

- **The one second `confirmStopped` race on a reviewer adapter will produce spurious unknowns.** For a read lease that still quarantines a repoId. Either lengthen the window for adapter registrations or make the read-lease retain path not quarantine.

What already holds: slot replay never allocates an attempt, the retry path is host-only and claims exactly one ledger-issued key, persist IO throw stays unknown with the lease retained, and the freeze identity cross-checks are exact. The items above are the gaps between the C6 prose and what this code will actually do.