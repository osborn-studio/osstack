# F3 r7 F4/F2/F5 closure

F4: If armLoopContainment rejects, runCycle checks the actual host marker. Present or unreadable/unknown marker sets containmentPending before rethrowing the original arm failure. The finally lease logic then retains persisted-containment reconciliation. If the marker is confirmed absent, no effects started and release remains appropriate. Successful arming does not set a sticky containmentPending flag, so a normal completed cycle can release normally.

A real partial-arm test in loop-containment.test.ts mocks only fsyncSync: marker file fsync succeeds, immediate parent directory fsync succeeds, the next ancestor fsync throws. It asserts actual JSON marker retained, lifecycle retain instead of release, execution sentinel absent, and a new-engine restart executes zero tasks while retaining again. The failed-arm original error is preserved. Existing helper write/file-sync/directory-sync negatives remain.

F2: Engine lease, runTask verifier escalation, implementation uncertainty decisions, active stop reason, and compatibility stop reason now state possible preflight refusal, that this does not prove a process remains alive, and the need for reconciliation. This keeps owner-accepted conservative classification; it does not assert an actual running process or authorize cleanup/retry. Graph separately owns all verifier wording.

F5: The completion compatibility branch comment is one line stating current stopPayload intercepts first. It does not claim another active caller.

No changes to filesystem persistence scope or execution authorization. Scoped final-source test/typecheck/Biome exit codes and before/after four-file SHA are recorded in F3-r8-arm-validation.json. Graph and root own the combined final source manifest, full-package review, global QA and CI. No deployment.
