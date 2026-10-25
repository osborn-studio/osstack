# Restart reason contract alignment

Local release-qa and CI40114963208 both reported the same single stale expectation in loop-candidate-cli.test.ts630. Test intent is that a producer lacking confirmed termination retains lease, batch claim and worktree and can never automatically retry. Those assertions are unchanged.

Current LoopEngine.runIteration reads persisted state, then checks the host containment marker and implementation_unconfirmed before discovering/executing work (loop-engine.ts517-521). That common guard emits stopPayload; stopPayload1476-1477 explicitly emits execution_containment_pending for any pending containment/contamination/unconfirmed implementation. Existing loop-engine.test.ts1351 already requires this exact reason on restart. The older execution_unconfirmed helper remains for a different completion path and is not this early restart event.

Minimal test-only change: replace the exact reason string execution_unconfirmed with execution_containment_pending. No union, weakened assertion, or production change. First-run outcome/escalation, implementation_unconfirmed, final_preflight_failed, lease retention, unreleased lease, batch claim, retained worktree branch, one builder invocation, and zero reviews remain asserted.

Related containment tests14 passed (45 intentionally name-filtered skipped). Whole CLI candidate file36/36 passed; logs cli-candidate-restart-contract.log and cli-candidate-restart-related.log. Source and test hashes in cli-candidate-restart-contract-manifest.json.
