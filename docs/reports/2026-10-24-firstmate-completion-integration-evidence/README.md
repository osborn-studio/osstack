# Integrated completion evidence

The first focused run retained two failures: source observe was intentionally not wired into main yet; the missing-credential test reached its 1-second native-binary preflight deadline before credential rejection. The latter test now gives that real preparation 5 seconds to test the intended missing-credential boundary; production limits are unchanged.

After wiring source commands and final synchronous source revocation checks, the actual main/socket and source/context/viewer/log suites passed 74/74 tests. Real remote main tests and independent cross-review evidence are recorded separately. These are local evidence, not external backend qualification or a final Claude audit.

The native OSStack queue has twelve capability tasks plus explicitly separate code-QA tasks. A failed first-wave full run remains retained. The final fixed-source Loop execution and independent verifier will be appended after completion. Merely enqueuing a task is not evidence that it passed.

The fixed first-wave snapshot `cfca0901` completed eight checks: six passed; typecheck and the full test stage failed. OSStack recorded the task as `escalated`, not completed. Most failures came from restored tracked knowledge output combined with a stale ignored incremental cache; the clean final checkout rebuilds the package exports. Two timing-sensitive collaborator/Graph cancellation failures are also retained for independent investigation and final-suite revalidation, rather than being attributed to that cache without evidence.
