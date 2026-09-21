# G19 bounded node contracts + trusted verification service

## Scope
Implemented only the six owned graph node files, CLI graph-verification.ts + test, and optional graph-verification-store.ts. No broker/runtime/index/package/protocol/core/migration edits by this actor. Parent and G18 work is concurrently visible in this shared checkout. No agents spawned, commits, pushes, full-suite tests, or cleanup of retained workspaces.

Interface was published before implementation: G19-interface.md. This coding turn is the parent's actual LoopEngine/CodexCliAdapter G19 actor (`actor.mjs`). That actor's diff-only verifier is not acceptance. Parent must inspect its eventual result/outcome/executedTaskCount and run C6 full acceptance + independent Claude review.

## APIs
- Pure graph nodes export VerificationBinding / VerificationBranch / VerificationRequestInput; parseVerificationBinding; validateVerificationBranch; verificationBranchFromResponse; createReviewRequest / validateReviewResponse / parseReviewReport; createTestsRequest / validateTestsResponse.
- Protocol-only dependencies; bounded JSON rejects accessors before reading them, extra keys, wrong binding/candidate/kind/state, wrong response correlation. Actual effectKey/attempt copied only from worker action response. Rejected actions have no attempt. Pending execution maps to unknown, never a code-failure report.
- Host `prepareGraphVerification(options)` takes trusted GraphArtifactStore/candidate/binding/source workspace, canonical private root, G10 acquire, synchronous live authorize, acceptance registry, writerIdentity/reviewer adapter+identity, independent verifyReviewer, and effectIdentity(kind) reading the currently RUNNING actual ledger row. Optional slots supply compiler nodeId/effectSlot/workspaceLeaseRef/tokenReservation. Returns immutable binding/workspaces/actions.
- Host `loadGraphVerificationEvidence(root, ref, expectedBinding, expectedEffect?)` returns the validated stored envelope, exact effect/attempt/command/exit/identity/workspace and report or verificationFailure. Parent verifies this against the durable ledger result/digest/reference, not worker claims. `expectedEffect` is strongly recommended for every recovery/load tied to a response.
- Public graph subpaths needed are already in parent's package changes: nodes/branch, nodes/review, nodes/tests.

## Guarantees and integration details
Preparation checks authority before/after awaits and uses canonical G10 source admission while verifying/restoring. Source manifest scope/run/path/SHA must match. Both roots are independently initialized restores from the SAME verified artifact, with separate objects/index and no alternates, hardlinked metadata or symlinked metadata. Raw file bytes/modes/links are verified against actual Git blob objects BEFORE recording the baseline; HEAD/tree/index and complete filesystem inventory are checked immediately before invocation. Reviewer post-stop inventory detects tracked, ignored, untracked and metadata-isolation mutation. External candidate symlinks are conservatively refused. Tests can create build/scratch output in their own root. Same UID remains NOT an OS sandbox.

Generated plans have fresh task/plan/session identity and no writer conversation/context. Independent configured identity verifier is required at preparation, pre-invocation and persistence. Inputs, adapter methods, callback references and executor evidence are snapshotted before awaits. Parent broker's host-only workspace/verifyWorkspace/stopped/verificationFailure interfaces are consumed directly.

Acceptance command/allowed pass+fail exit codes are snapshotted from trusted registry. Actual stopped nonzero allowed failures persist tests passed:false (CONFIRMED by parent broker). Malformed structured review summaries are OUTPUT_CONTRACT_INVALID; valid changes_requested is a confirmed review. Infrastructure/undeclared command exits use INTERNAL_ERROR. Reviewer mutation is INTERNAL_ERROR retrySafe:false. Actual executor stop uncertainty and contradictory surviving-descendant evidence throw and remain unknown/retained through broker. Persistence exceptions also remain unknown.

Evidence is host-owned canonical JSON, digest-addressed, exclusively created, fsynced, made read-only, atomically published with a no-overwrite link and directory fsync. No callbacks are persisted. Load checks digest/binding/attempt/report vs original executor summary/actual command. No arbitrary removal or automatic candidate cleanup. Only service-owned publication temp file is unlinked after durable publication. Preparation lease is released after restore operations settle even if authority was revoked during acquire; release failure retains the lease.

Retry note: immutable registered workspaces are not reset. If a stopped tests invocation leaves scratch/build output, the exact inventory gate can refuse reuse; parent must explicitly prepare/register a fresh workspace for a retry as its host lifecycle permits. No automatic cleanup/reset is introduced. This conservative behavior does not weaken lease/recovery rules.

## Evidence
- G19-nodes-red.log -> G19-nodes-accepted.log: 7 focused pure tests pass.
- G19-host-red.log: initial missing service RED.
- G19-race-red.log: actual failing restore-baseline mutation + acquired-lease revocation leak reproductions; both fixed.
- G19-host-complete.log: 14 host tests passed, including real G04 broker/command/reviewer two-way observable overlap, actual ledger attempt binding and code-failure confirmation.
- G19-host-timeout.log: default 5-second timeout under concurrent load; real filesystem tests now explicitly allow 15 seconds, without weakening assertions.
- G19-host-accepted.log: 15 host tests passed after timeout adjustment.
- G19-host-final-verified.log: final source validation (status appended below).
- G19-biome-final.log: 9 owned files clean.
- G19-cli-typecheck-final.log: passed (empty log).
- G19-graph-typecheck-final.log / graph-build-accepted.log: parent-owned join.test.ts:40 assigns `tampered` to review|tests; no G19 source errors. Parent owns correction.

Tests use explicit OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/gc6/home and TMPDIR=/Volumes/AIMATE_WORK/tmp/gc6. Each host fixture allocates a unique g19-* root, its own explicit control.sqlite, artifact/evidence roots and isolated source/review/tests repositories. Fixtures remain for inspection, including unknown execution resources. No default home opened.

## Final status
Final source host run: **15/15 passed**, 26.9 seconds (`G19-host-final-verified.log`). Pure nodes: **7/7 passed** (`G19-nodes-accepted.log`). CLI typecheck and owned-file Biome passed; git diff --check passed. Source hashes recorded in G19-source-sha256.txt. The unknown-stop test intentionally emits the existing retained-admission message and does not fabricate a stop/release. G19 implementation/handoff complete; parent full acceptance and graph join-test type correction remain parent work.
