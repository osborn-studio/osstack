# C3 repository lease recovery boundary

C3 is an integration prerequisite, not production Graph rollout. Current-version cooperating processes must use the canonical `commonDir/osstack/writer-locks/<repoId>.lock`. Stop older daemons before switching versions: legacy HOME-based locks do not exclude these locks. Supported scope is a trusted, stable local filesystem with atomic rename and exclusive directory creation. Network/shared-host filesystems and adversarial same-user filesystem mutation are not supported.

## What an unresolved lease means

Abort delivery, `done(cancelled)`, iterator closure, worker/daemon PID exit and lease expiry do not prove every descendant or remote action has stopped. Missing or late `confirmStopped(runId)` evidence retains the repository file lock and its occupied write capacity. Other repositories can use remaining capacity, and unrelated reads remain available. If all write slots are occupied by unresolved work, further writes wait; this is an explicit resource limit, not an assertion that the producers have disappeared.

Renewal or release failure marks the affected repository unresolved. Expired leases cannot be renewed through the live-lease API. Current managed admission never uses the legacy dead-PID takeover option. A crash inside a lock mutation can leave a `.lock.guard` directory; new mutations fail closed after a bounded wait. There is no automatic force-unlock API in C3. Automated evidence-backed reconciliation belongs to G14/G15.

## Offline recovery procedure

1. Quiesce every current and legacy daemon, foreground Loop/delivery, graph worker and other cooperating writer using the repository or any sibling worktree, including other OSSTACK_HOME instances. Prevent automatic restart during inspection.
2. Independently identify and stop all adapter-owned subprocess descendants and outstanding remote work. Record actual exit/completion receipts and inspect affected worktrees/artifacts. A dead PID, timeout or absent socket alone is insufficient. If external work cannot be accounted for, retain the lock and do not resume writes.
3. Resolve the repository's actual Git common directory. Save the exact lock file, owner token/run ID, relevant state/evidence and any guard metadata to an audit location. Check that the inspected path and token have not changed and that no writer has restarted.
4. Only after the above stop evidence is complete may the operator remove that specific stale lock and its empty guard. Do not recursively remove the common directory, the lock root or an unknown/nonempty guard. Do not clear an active lease or rely on expiry as authorization.
5. Restart one compatible owner, verify the policy root and scope, and acquire a fresh lease. C3 provides no resume of unknown graph actions; do not replay such actions until G15 reconciliation exists.

This procedure is documentation for an operator; the implementation task did not execute recovery, clear user locks or stop serving processes.

## Compatibility

- `osstack serve --workspace <repo>` supplies the trusted root for direct write adapters. Without it (or an equivalent embedding `adapterWorkspaces` registration), direct write tasks fail closed. A supplied write `repo_path` must match that exact registered checkout; reads retain their requested checkout.
- Local socket session paths and persisted resume paths are checked against real Git identity and repository policy. An embedding registration additionally pins the exact checkout, including for resumable native sessions. Fake/nonexistent repository fixtures are no longer accepted for writes.
- Foreground Git Loop, guarded delivery/resume, daemon Loop, direct writes, session/collaborator execution and the registered in-process graph port share canonical repository exclusion. Nongit foreground Loop retains its existing local mode and is outside Graph's managed Git scope. This is orchestration, not a filesystem sandbox for arbitrary shell code.
- Foreground Loop keeps the lease around checkpoint, implementation, verification, cleanup and report finalizers. Daemon Loop refuses client checkpoint/governance/report/scorecard/proof flags until daemon-owned exports exist; use their foreground equivalents. Daemon RPC no longer runs client-side automatic probe observation or lesson-learning writes. `--neat-finalize` remains daemon-owned.
- `context.repo_id` is a checked canonical hint, never an authority. Historical logical labels are rejected when supplied as canonical hints; omit them or use the canonical resolver result. Logical autonomy row identifiers remain intact.
- The 1-second adapter cancellation grace and bounded 1-second receipt query can produce conservative false negatives. Shipped adapters without `confirmStopped` require offline recovery after uncertain cancellation; C3 does not fabricate that capability. Foreground abrupt termination and machine sleep can likewise require recovery.
- Queue admission rechecks health and authorization. Expensive production health probes and Git policy resolution still require the G28 latency/tick-overhead evaluation; CLI startup passing does not establish daemon tick performance.
