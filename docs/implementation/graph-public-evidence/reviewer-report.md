# G22–G24 independent adversarial review

**Verdict: REQUEST_CHANGES**

Reviewer: Codex, invoked through the real OSStack Loop / CodexCliAdapter. This is not a Claude review or Claude approval; the reported Claude Fable attempt failed with a quota error.

Baseline and HEAD: `a37b0065ea097d272c099f840617b3e6ceaba2b4`. Reviewed the working-tree diff, untracked `graph-rpc.ts`, `graph-execution-command.ts`, host-config tests, RPC/socket integration tests, protocol changes, G22–G24 task cards, and G21 completion/next-context handoff. Findings below are source-derived reproductions, **not executed tests**. No repository files were edited; no tests, builds, agents, or commits were run.

The actor changed files during review. I re-read the relevant paths before this report. In particular, the latest core projection exemption is restricted to preworker failed/cancelled settlement, and the public service now rejects adoption of an existing request without a public descriptor. Neither superseded issue is reported as a defect.

## Required changes

### 1. P1 — Source repository policy revocation is lost after cloning

**Location:** `packages/cli/src/daemon.ts:3847–3852`, especially line 3850; assembly at `packages/cli/src/graph-rpc.ts:195–196`.

The new daemon gate checks only `input.workspacePath`. After the first workspace action, this is `writer-0` or a verification clone, not the registered source repository. `GraphDelivery` creates an independent clone (`graph-delivery.ts:183–188`), and `makeRepositoryPolicyGate` discovers the primary checkout *of that independent clone* (`repository-policy.ts:23–35`). It cannot inherit the current policy of the registered source. The host grant recheck does not check repository policy.

**Minimal reproduction:** Use the socket integration fixture with a committed execute policy. Pause writer availability after `e0.workspace` has completed; change the registered source's `.osstack/policy.yaml` to `mode: observe`; release availability. The implementation and subsequent admissions still consult the clone's old execute policy and can continue to ready. No same-UID attack is needed: an ordinary owner policy revocation is ignored. Conversely, a legitimate source policy that is untracked or newer than `baseRevision` is absent/stale in the clone, making authorization depend on candidate content.

**Minimal fix:** Capture the registered source policy root separately from the physical execution workspace and check that current source policy at admission/invocation boundaries. Candidate workspace policy may impose additional restrictions; it must not replace the original authority.

### 2. P1 — `close()` permits live continuations to use SQLite after daemon DB close

**Location:** `packages/cli/src/graph-rpc.ts:223–238`, especially the race at line 237; database close at `packages/cli/src/daemon.ts:4129`.

The 15-second race returns success without retiring database access from outstanding driver work. Independently, `GraphRuntime.stop()` reports a bounded drain result rather than completion of pending operations (`graph-runtime.ts:159–174`), so even `entry.done` can finish with broker operations still pending. The daemon then closes the same database. `closed` prevents new RPC admission, but does not guard the continuation reads/writes at `graph-rpc.ts:198–217` or late admission release at `graph-action-broker.ts:405–408`.

**Minimal reproduction:** Hold the asynchronous `mkdir` in `GraphDelivery.run()` (`graph-delivery.ts:320`) after the service constructs the driver but before it claims a generation. Call `daemon.close()` with no client sockets left open. Cancellation records preworker cancelled; `driver.cancel()` has no handle and returns. After 15 seconds close proceeds to `ctx.db.close()`. Release the held mkdir. The driver eventually returns from its stopping path, then `graph-rpc.ts:212` reads the closed DB; its catch reads it again at line 215. A second concrete path is a lease `release()` delayed beyond runtime drain: it later calls `admissions.released()` on the closed DB. These are local lifecycle races, not a demand for G25 crash recovery.

**Minimal fix:** Give the daemon an actual database-user drain barrier, or explicitly retire every pending continuation from database access before allowing DB close. Keep unresolved effects/holds durable. A timeout may report unresolved shutdown; it cannot stand in for cessation of DB use.

### 3. P2 — Confirmed cancellation of review/tests is converted into unknown

**Location:** new cancellation path `packages/cli/src/graph-delivery.ts:294–315`; settlement wiring at lines 108–112 and 164–169. Existing callees expose the incompatibility at `graph-verification.ts:224–255` and `graph-action-broker.ts:357–359`.

The new cancel-specific authorization covers delivery receipts (including writer settlement), but review/tests retain `authorize: () => this.check()`, requiring execute authorization while persisting their stopped result. Revoking execute while retaining cancel therefore makes verification persistence fail and retain an unknown action. There is also a failure with execute still granted: a cooperatively cancelled reviewer gets a `verificationFailure` because its execution was cancelled, and a stopped cancelled test command gets an infrastructure `verificationFailure`. The broker explicitly rejects any such failure when `signal.aborted` is true. It marks the action unknown and retains admission. The new run-level G15 cancellation cannot settle it because its quiescence check rejects unresolved actions and it supplies `NO_EFFECT_RECONCILIATION`.

**Minimal reproduction:** Let implementation/freeze finish. Use a reviewer that waits for abort, then terminates cleanly with a valid terminal event and positive `confirmStopped` evidence within the grace interval. Cancel while it runs, leaving execute permission enabled. Verification persistence classifies its cancelled result as a failure; the broker's aborted-signal check rejects it. The process has stopped and the host possesses its evidence, but status remains cancel_pending and admission remains held. Revoke execute but keep cancel to also reproduce the missing cancellation settlement authorization.

**Minimal fix:** Connect verification's independently proven stopped cancellation to a nonretryable failed settlement (or an actual G15 effect decision) under current cancel authority. Preserve unknown for unproven stop. Do not treat aborted work as passing quality evidence. The current writer-only cancellation test does not exercise this path.

### 4. P2 — Invalid mutation acknowledgement is reported as rejection instead of ambiguous delivery

**Location:** `packages/cli/src/graph-execution-command.ts:97–117`.

Only a rejected RPC promise produces `GraphDeliveryUnknown`. If the server has committed the mutation but returns an invalid/mismatched acknowledgement, the CLI emits exit 1 with `OUTPUT_CONTRACT_INVALID` or `RESPONSE_MISMATCH` and `nextAction: fix_input`. Receiving an unusable acknowledgement does not prove the mutation was rejected. This drops the original retry binding precisely when the client cannot establish what happened.

**Minimal reproduction:** Wrap a real RPC dependency so it awaits a successful `graph.start`, then returns `{ ok: true, result: {} }`. The run is durably reserved and executes, but the CLI reports exit 1/fix_input. The same problem occurs with a valid status belonging to another run.

**Minimal fix:** After sending a mutation, classify absent/invalid/mismatched acknowledgements as delivery_unknown, retaining the exact original scope/key/input digest and retry_same_request. Keep definite server rejection and pre-send input validation distinct. Preserve an output-contract diagnostic if useful without claiming nonacceptance.

## Reviewed behavior that does not block this scope

- Persistent scope/key mapping and the public descriptor reservation prevent duplicate launch on concurrent submission and replay through a fresh service; source product, scope, registration ID and original business digest are checked.
- Current host configuration snapshots refs/commands and rechecks the non-grant binding digest. Same-binding grant renewal is allowed, while changed task/config bindings fail closed in the existing service. These checks do not resolve finding 1's separate repository-policy root issue.
- Ready projection and public candidate/join reference persistence share the SQLite transaction. Protocol parsing requires candidate/result/evidence references and available delivery for ready.
- Quality resume checks exact input/interrupt/revision/current authority, durable checkpoint/join identity and the same supervisor's observed stop, then uses G15 takeover. A missing supervisor is refused; no automatic unobserved daemon-restart resume is requested here.
- The latest core change preserves owner/generation/revision checks and live fencing for running/ready. Expired cancellation records intent without inventing stop evidence.
- Waiting beyond the roughly five-minute lease window fails closed. This is a product limitation, not an additional blocker for the stated acceptance scope.
- Pending grants are returned in the original scope, and boolean/model assertions do not mint grants. Unsupported caller identities are rejected.

## Snapshot hashes

SHA-256 at final source inspection (2026-09-15):

| File | SHA-256 |
| --- | --- |
| packages/cli/src/graph-rpc.ts | aa2d63c23bf066933df76a2bc69ca352596334da3d640e5dbbcd61a54983f82d |
| packages/cli/src/graph-delivery.ts | 6482a006e093e889a472243b8c22c35eaf9ba4ddffdc6fa19d55f9b1789abfff |
| packages/cli/src/daemon.ts | 170ce220661272ee462573e2a2fd7408c9e0029282b8ed619bda0f283ce32633 |
| packages/cli/src/graph-execution-command.ts | 3117f0c3b35f7e49a47d067c498aaa67321c6fbd1f171635bf46133bffb3d322 |
| packages/core/src/state/graph-runs.ts | 74cecc8aeeec533b65e9d98b9664ab0f0f8b3f5fcb47b4711816b9b41663b5d4 |
