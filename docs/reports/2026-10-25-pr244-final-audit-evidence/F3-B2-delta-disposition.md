# F3 r4 B2 and final-stage delta

## B2 execution-selection probes
`selectExecutionAgent` rejects an explicit agentId also in verifierAgentIds before invoking it. Automatic routing filters verifier IDs before both routeCapability and availablePolicyCandidates receive their adapters. No reviewer capabilities or availability are queried in that selection path. When only reviewer adapters remain, or filtering leaves no eligible router match, fail closed instead of local-noop. Multi-capability adapters can still serve as reviewers; their role for this invocation is fixed by verifierAgentIds. executeCommand bypasses adapter selection, as before; its reviewer probes occur only inside verifyRun's integrity boundary.

Tests use a real writing isAvailable implementation. Exact capability and kind routing with only the dual-role reviewer refuse before probe/invoke or builder writes. Mixed builder/backup/reviewer routing verifies the probe only runs after the builder writes its output, once, inside verification; its attempted candidate mutation stops before reviewer invocation and cannot trigger builder retry. Explicit override collision is refused before builder invocation, even absent enforceRoleSeparation.

## Candidate prepush/final coverage
Two real Git candidate-policy tests run a normal builder and generic reviewer, then mutate from reviewer invocation #2 (prepush) or #3 (final) in the main candidate. Both produce final_preflight_failed, never ready; main HEAD contains builder bytes while working-tree reviewer bytes remain uncommitted; host marker survives and restart executes zero tasks. No mocked verdict is used.

## Legacy hidden-index silent drop
Before guarded inspection, publisher, lesson draft or commit on a successful isolated worktree, assertCandidateIndexVisible rejects hidden index flags or inability to inspect. Rejection records verify.candidate_index_unconfirmed, escalates, sets candidateContaminated, retains the prearmed host marker, and skips cleanup, goal and self-improvement. This is an integrity condition, not a fabricated process-stop claim.

Two real legacy (no candidatePolicy) worktree tests run a builder that changes app.txt then applies assume-unchanged or skip-worktree. A generic reviewer succeeds. The new guard escalates before commit/merge, retains actual hidden bytes and worktree, leaves main bytes unchanged, and blocks both same-engine and new-engine retry. Sparse entries intentionally also refuse under the parent/graph accepted fail-closed scope.

## Validation history
Intermediate outputs are preserved honestly: initial fixture failed CANDIDATE_STATE_UNSAFE (symlink TMPDIR state path), then CANDIDATE_BATCH_SIZE (default queued task plus explicit input). Fixtures now use canonical state directory and explicit empty discovery sources. A pnpm test -- invocation unintentionally ran the whole package and produced a SIGTERM fixture timeout under concurrent work; that run is not counted as pass. Final validation is F3-B2-final-validation.json and corresponding three logs, with before/after hashes. Parent owns full repository QA and F3 agent owns the independent r5 Haiku closure.
