> 历史执行器交接，非最终验收结论。最终状态与可复核证据见 [C3 报告](../2026-09-14-graph-admission-completion.md)。早期系统临时目录日志已不可用；本目录的新验收日志为重新运行所得。

# G10 executor report — partial, not accepted

Read repository AGENTS, Functional C2 decision, G09-interface.md and supervisor.md (including parent Claude adjudication). No commits, agents, recursive Loop, production/default DB, push or merge. All executed tests use temporary homes/repos. Work stayed in assigned CLI/Loop files plus the standalone bin.ts callsite explicitly assigned by supervisor.

## Implemented integration

- New CLI GovernedExecution extracts read/global-write/per-repo semaphore and file-lock admission. Writes require G09-resolved actual workspace identity; caller repoId is only a checked hint. Canonical locks use commonDir/osstack/writer-locks through G09's existing acquireRepoWriteLock, recover_stale:false. This protects independent admission instances/homes and sibling worktrees. Local filesystems only; mixed old binaries and shared network hosts are unsupported.
- Health and host authorization run before admission and again after all queues/locks. Failed/aborted acquisition releases permits. Same run reentry rejects before its non-reentrant queue.
- A single serialized 20-second heartbeat renews each active file lease; errors are logged and poison future admission. Retention refuses later release, keeps permits and the durable lock, and rejects following writers pending reconciliation. There is deliberately no reconciliation API claiming external stop evidence.
- daemon direct task.submit now calls the service, using a host adapterWorkspaces registration (also binds task.context.repo_path). Arbitrary caller repo_id cannot grant a lock. Unscoped daemon writes fail closed. Normal iterator exhaustion is required before normal release; abort/throw after producer start retains. Registration is a trusted host assertion that the registered adapter honors the supplied execution path, not a worker assertion.
- daemon guarded autonomy resolves the durable row workspace, preserving its logical repo_id rather than comparing a historical label with a canonical hash. Blocked/thrown guarded results retain conservatively.
- Optional Loop-local lifecycleLease hook surrounds runOnce/runCycles, including worktree create, execute, verify, commit, cleanup and Loop final state persistence. Absent hook preserves standalone engine behavior. implementationUnconfirmed and runtime throws retain. Both daemon direct Loop and scheduled cycles inject admission; session abort cancels queued acquisition. A running cycle is allowed to finish naturally; stop does not pretend its external producers have stopped.
- Direct loop.run holds the captured lease through daemon knowledge finalization and run-evidence persistence. Scheduled cycles hold through engine effects/finalization; scheduler counters/session-file bookkeeping occur afterward.
- Session start/send and actual reserved resume (including collaborator) refuse under managed configuration/active managed conflicts when they lack confidently scoped integration.
- In-process DaemonHandles.acquireGraphAdmission requires reference identity registered by the host, an explicit present non-observe policy, and the host authorization callback. Worker principal/scope fields cannot grant identity. Graph RPC/runtime is NOT implemented.
- Standalone bin Loop refuses repository execution and points to daemon RPC; this is conservative fail-closed behavior until a standalone host identity/exit-reconciliation port is implemented. Non-Git standalone behavior remains.

## Evidence

Directory: /var/folders/97/wmwg4qzx02j74c3n73nh438w0000gn/T/osstack-graph-admission-btizzez0/G10-evidence

- red-cli.log: new missing-service regression fails before implementation.
- red-loop.log: lifecycle persistence test fails before hook implementation.
- red-reentry.log: same-run admission times out before explicit reentry rejection.
- green-admission.log: 5/5 pass using real temporary Git repositories and sibling worktrees. Covers missing/forged scope, genuinely queued health/policy revocation, abort permit cleanup, retained lease/follow-up rejection, same-run reentry, independent admission instances sharing one canonical lock.
- green-loop-regression.log: 39/39 pass (8 policy/lifecycle + 31 existing Loop engine regressions, including real worktree effects).
- typecheck-cli.log: CLI strict typecheck passed. Loop and autonomy builds passed. git diff --check passed.
- daemon-final-attempt.log: all 30 daemon tests fail at Unix socket listen with EPERM in this restricted executor. This includes two added graph admission/Loop contention tests. These are NOT passing integration evidence. No escalation was attempted; approval policy is never.

## Required parent integration / material gaps

1. G08 owns core index. Export resolveRepositoryScope/RepositoryScope and rebuild core. To validate without editing G08 source, I built core and temporarily appended resolver reexports ONLY to ignored generated dist/index.js and dist/index.d.ts. Tests/typechecking used that generated bridge; parent must validate the actual source export. No core source/index edits were made by G10.
2. Run real daemon acceptance outside this executor's socket restriction. Requested direct-adapter versus Loop same-repo contention, stop/abort identity, graph denial and full finalization lifetime have not all been proven end-to-end. The added daemon tests cover graph/Loop canonical contention and denied trusted graph authorization but are unexecuted beyond listen. Existing non-Git daemon Loop fixtures now need conversion to real Git fixtures (three policy tests were converted); this is a deliberate fail-closed compatibility change and remaining daemon tests may expose it after sockets work.
3. Parent B5 is not fully solved: daemon Loop still accepts its existing local socket workspace option. A persistent trusted registration binding canonical policy root, execution root and sibling-worktree policy lookup is needed to reject policy-free subdirectory/sibling bypasses. Do not accept G10 until that is resolved.
4. Legacy sessions allowed before any local managed configuration/active writers can still exist when a separate daemon/home starts managed work. Cross-home prevention for those unintegrated session/collaborator paths is not proven. Direct daemon writes are denied when unscoped, but the product must supply trusted adapterWorkspaces for useful writes.
5. Autonomous external callers of the old lock root are outside these edits. Parent must ensure all managed runtime owners use canonical admission or refuse; historical logical-id locks cannot fence canonical managed execution by themselves.
6. Lease renewal failure is visible and blocks new admission, but does not yet terminate or fence an already running external producer. Retention intentionally sacrifices liveness until trusted reconciliation. Exact adapter confirmStopped(runId) integration and its bounded cancellation test are still needed.
7. Standalone CLI refusal is at the engine construction branch, not a completed audit of every earlier special execution branch. Parent must finish that audit and prove no earlier repo write escapes.

No claim that G10 or C3 is complete; no production graph-runtime claim. Parent owns final integration and Claude review.

## Final ownership handoff

Final supervisor reread completed. Current-snapshot findings 1 and 2 were fixed: producerSettled is assigned only after natural iterator exhaustion; terminal events no longer break the iterator; socket write errors request abort. An initially denied Loop admission now latches the deny reason for that engine, so observe -> execute cannot turn the no-effect refusal into an unlocked run. These race fixes still need focused daemon tests in the parent environment. Finding 4 fixed: retain clears its heartbeat without releasing the durable lock. B5 trusted policy-root binding remains open for parent integration as above. No further G10 edits after handoff.
