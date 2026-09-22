# Graph guarded physical write authority

Baseline: `083bdec`; branch `codex/graph-decision-development`. Graph only, Jev paused.

## Delivered

The bounded applier needs synchronous authorization at each filesystem boundary. The existing physical repository lock only exposed asynchronous checks; caching an earlier successful check was not an adequate bridge.

`RepoWriteLock.withActiveGuard` now holds the existing filesystem mutation guard while a **trusted synchronous** host callback runs. It checks the exact owner and expiry before entry, exposes an `assertActive` closure that checks expiry, and permanently revokes that closure when the callback exits. It checks again before returning. The closure cannot be reused outside its scope. A Promise/thenable result is rejected and its rejection is contained; this is a runtime contract check, not cancellation or sandboxing of trusted code.

`ExecutionLease.withWriteGuard` is supplied only for actual writer leases. It requires the exact canonical workspace path, retains capacity on guarded errors, and rejects concurrent guarded calls, release, or reconciliation while work is active. A guard cannot start while reconciliation verification is pending. Failed admission remains held until the existing trusted reconciliation path proves release is safe.

Timer renewal is deferred while the guarded phase is active. Already queued renewal is drained before entry. The owner is renewed before and after the guard; these renewals still reject expiry and never revive an expired owner. A callback that exceeds its lease fails closed. The guard flag remains set through post-work renewal, preventing premature release.

`applyGraphChangesetWithLease` connects this real physical authority to `GraphChangesetApplyHost`. It snapshots input and fence, checks cancellation plus current grant/profile/registration authority at each applier check, and retains on any thrown or non-applied/uncertain result. It never releases the lease/admission on success: its single trusted owner carries both through freeze.

No production executor or registry version is enabled. Legacy adapters and broker settlement semantics remain unchanged.

## Evidence and important boundaries

- Real Git three-file create/replace/delete apply runs inside a real `GovernedExecution` repository lock, followed by real artifact freeze under the same lease. Capacity stays occupied until the test explicitly releases it.
- A database completion failure quarantines the candidate and ordinary release is rejected; only explicit fixture reconciliation releases capacity.
- A real child is killed with SIGKILL inside guarded work. Both the owner file and mutation guard survive; restart acquisition fails closed instead of guessing away the crash.
- Scoped proof escape, in-callback expiry, asynchronous return rejection, thrown callback, release ordering, pending reconciliation and timer ticks have focused tests.
- Test model transport and grant/health/producer predicates are fixtures. Real filesystem locking does not turn those into production authorization.
- A post-commit expiry or guard-teardown failure means **possibly applied**. Callers must inspect the durable apply ledger and must not resend or blindly reapply.
- Cooperating binaries must honor the lock protocol on a trusted local root. This does not sandbox same-UID arbitrary mutation or a callback that schedules unrelated background work.
- The host that owns the lease must serialize its complete invocation/apply/freeze lifecycle. This patch supplies the physical write primitive; the existing production broker does not yet manage a changeset lifecycle across all three stages.

## Opus 5 audit decisions

Claude CLI was called read-only with exact model `claude-opus-5`, tools disabled. The first review requested timer/guard coordination and exclusion of new guards during pending reconciliation. Both were adopted, with focused regressions.

Other review points:

- A long synchronous callback cannot itself overlap a JavaScript timer callback. Async guard acquisition and teardown can still overlap renewal, so deferral plus boundary renewals are useful.
- Post-commit failure ambiguity: accepted and documented; no rollback or non-execution claim.
- Prechecking all grants before entering the guard: rejected as a replacement for per-boundary authorization. Revocation after partial work must retain uncertainty.
- Normalizing workspace aliases: rejected. Exact canonical registration is intentional; an alias must not broaden a writer capability.
- Objects with a `then` property: intentionally rejected conservatively. The applier returns plain result objects without that property.
- Guard teardown failure may mask an earlier error: safety remains retention; richer error aggregation is diagnostic debt rather than authority to release.

## Remaining work

1. Versioned changeset registration and real disclosure/token-bound authority.
2. A broker-owned lifecycle spanning invocation, guarded apply and freeze, with durable outcomes and admission release after the freeze result is committed.
3. Complete reviewer transport, independent review/tests, join, and daemon-to-ready acceptance.
4. Restart recovery for retained physical ownership and remaining evaluation/delivery work from the Graph plan.

No production daemon, default control-plane DB, Jev API, paid writer API, push, merge or release was used. Claude review calls used the user's requested CLI.


## Validation

- Autonomy repository lock suite: **26 passed**, including real process contention and SIGKILL under the guard.
- Governed execution suite: **19 passed**.
- Graph invocation/apply/freeze host suite: **46 passed**.
- Existing Graph broker and boundary suites: **53 passed**.
- Total: **144 distinct passing tests**, 14 newly added cases.
- Autonomy build, CLI build and strict CLI typecheck passed. Biome, diff whitespace and generated inventory freshness passed.
- New guard tests failed before the implementation was added, then passed. No production execution, relaxed health limits or full-monorepo acceptance is claimed.


## Final audit result

The second Opus 5 review reported **no remaining blockers in the changed logic**, confirmed timer/guard ordering and bidirectional exclusion with reconciliation, and agreed that exact workspace matching and per-boundary authorization should remain. This was source review, not test execution. Its request to confirm a synchronous apply signature is satisfied by `GraphChangesetApplyHost.apply(...): GraphApplyResult` and the real guarded-apply integration test.

Non-blocking notes retained: rejected thenables lose their eventual error diagnostics; retaining an already retained lease is safe but may duplicate a log line. Neither permits admission release.

| Review | Actual model | is_error | Response SHA-256 |
| --- | --- | --- | --- |
| Initial | claude-opus-5 | False | `c1f2024eba916c8c01ef328b03ffe54463f02300ee503bf42bac55d11fd02c4e` |
| Delta | claude-opus-5 | False | `b5256b7acce1749db01dc6acd9c669bc20eb91e0a891ba972c7c1d54d152249d` |

Raw responses are in `/tmp/graph-write-guard-opus.json` and `/tmp/graph-write-guard-opus-final.json`; those temporary files may be removed by the OS. This document preserves the actionable findings and decisions.
