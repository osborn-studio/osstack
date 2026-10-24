# Integrated completion evidence

The first focused run retained two failures: source observe was intentionally not wired into main yet; the missing-credential test reached its 1-second native-binary preflight deadline before credential rejection. The latter test now gives that real preparation 5 seconds to test the intended missing-credential boundary; production limits are unchanged.

After wiring source commands and final synchronous source revocation checks, the actual main/socket and source/context/viewer/log suites passed 74/74 tests. Real remote main tests and independent cross-review evidence are recorded separately. These are local evidence, not external backend qualification or a final Claude audit.

The native OSStack queue has twelve capability tasks plus explicitly separate code-QA tasks. A failed first-wave full run remains retained. The final fixed-source Loop execution and independent verifier will be appended after completion. Merely enqueuing a task is not evidence that it passed.

The fixed first-wave snapshot `cfca0901` completed eight checks: six passed; typecheck and the full test stage failed. OSStack recorded the task as `escalated`, not completed. Most failures came from restored tracked knowledge output combined with a stale ignored incremental cache; the clean final checkout rebuilds the package exports. Two timing-sensitive collaborator/Graph cancellation failures are also retained for independent investigation and final-suite revalidation, rather than being attributed to that cache without evidence.

On the fresh integrated source, all three prior-failure files passed unchanged (52/52). Independent source review established that the collaborator deadline includes admission/runtime preparation and may correctly block before resume; Graph cancellation requires whole-run stop proof, not just the review branch. Shared-load timing is a plausible cause of those old two failures, not a proved unique cause because the original worker journals were not retained. Production deadlines and cancellation assertions were not relaxed. Final full-suite verification remains the gate.

Seven additional native queue tasks explicitly retain authentication, model, GitHub sandbox, SSH, terminal, managed-upgrade and cross-platform qualifications as queued/not executed. They do not authorize public messages or production-home changes.

## Integrated snapshot 84b406b4 — failed, retained

The eight native Loop QA checks completed: build, inventory generation, typecheck, lint, schema, inventory freshness and startup passed; the full test stage failed. Twenty package suites passed. Loop had one failed process fixture (444 passing); CLI had six failed read-model cases (2,529 passing, four opt-in cases skipped). The read model still rejected newly supported database schema 46; this is a production compatibility defect, not an external environment limitation. The process fixture now waits for child readiness and starts its 10ms drain timer only after the leader exits, without changing production timing or stop assertions. That entire executor file passed 116/116 after the fixture fix. A planned fixture-only composite retry was superseded without execution because the CLI production fix requires a fresh complete run.

The final Haiku invocation at the same frozen snapshot is retained in `final-haiku-audit/`: exit 1, `is_error:true`, zero tokens, expired OAuth. The misleading `subtype:success` is not a review pass. No final model audit occurred; subsequent schema/test fixes also require the eventual fresh authenticated audit.
