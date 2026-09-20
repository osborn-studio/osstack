# Graph upgrade final acceptance evidence

2026-09-20. This directory records the final G25–G29 checks against the implementation worktree, including earlier failed diagnostics where they explain a repair. The final manifest and completion report identify which runs are accepted. A `passed` flag from a narrow diagnostic does not by itself admit the complete product.

- `internal-pilot-batch.json`: actual DeepSeek provider, real OSStack clone, successful candidate/review/test/join, negative reviewer control and an intentionally unresolved cancelled request.
- `internal-pilot.json`: failed first real-repository pilot, retained to document the per-file Git process performance defect.
- `pilot-timing.json`: ledger action timings before/after the batch plumbing fix, including physical work and queue delay.
- `node20-accepted.json`, `node20-final-delta.json`: actual Node 20.6.0 with separately built native SQLite ABI; final delta contains 25 passed tests.
- `old-locks-*`: actual published 0.17.0 lock acquisition cannot steal the new retained managed lock.
- `import-proof-*`: a host loader rejecting all `@langchain` imports while the independent production graph worker reaches ready.
- `fable-*`: actual Claude CLI main model `claude-fable-5-1` responses and prompts. Only final result records are archived; no API keys or raw hidden reasoning stream.

## Review decisions

Initial consultation identified missing lock/upgrade/runtime/performance/pilot closure evidence; these were implemented and verified. Final lock/drain/upgrade/platform review returned accept. Batch artifact review requested an independent allowance for cat-file framing at the 256 MiB raw limit; fixed with exact-boundary, binary, repeated-object and missing-object regressions. The final boundary review returned accept.

We did not implement a suggested operator `not_applied` override based only on PID death. Process death does not determine whether an external effect occurred. Fable's final review accepted retaining unknown outcomes and locks within the original G25 requirements. Likewise, a SIGKILLed artifact operation leaves its lock held; unrestricted automatic cleanup is not a release requirement.

Actual cancelled inference homes remain outside Git with their retained state. Do not delete them merely because the validation scripts have exited. Monetary billing of the unknown request is not inferred from zero confirmed tokens.

JSON test data is copied without modification. Text/Markdown evidence may have trailing whitespace normalized for repository checks; final hashes refer to archived bytes. Source and distribution hashes in the fault report refer to the tested worktree, prior to the documentation commit. Remote GitHub CI has been configured but has not been run by this local task.
