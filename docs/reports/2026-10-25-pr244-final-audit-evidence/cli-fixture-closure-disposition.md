# CLI reviewer fixture and production default-output closure

Original evidence: ready-qa-logs/test.log reported seven CLI failures during a mixed-source run.

- daemon-loop and loop-cli were already committed Git repositories. Their real ds-review default wrote workspace/reviews/ds-review/latest.md, correctly triggering generic reviewer mutation detection. The initial fixture-only override would have hidden a production default regression and was superseded: production DeepSeekCommandAdapter now allocates default output under core createScratchDir(runtime, ds-*-output), retaining only the default basename. Both default ds-review and ds-verify are covered. Existing explicit adapter outputPath and task review_output_path/verify_output_path precedence remains unchanged; full Loop integrity checks still reject candidate/Git modifications from such overrides.
- Adapter progress phase <id>.output exposes JSON {path} as a planned destination, not evidence that a file already exists. Actual successful regression checks read the generated output after done. Production output artifacts persist under the normal runtime scratch cleanup policy.
- CLI real-default tests no longer override output: their fake command receives production --output and records that argument outside the candidate, then tests verify an absolute external destination and actual diff contents. No production validation is bypassed.
- loop-defaults beforeEach had git init but no commit/HEAD. snapshotReviewerWorkspace invokes rev-parse HEAD/diff HEAD before adapter invocation. A real initial empty commit fixes the fixture; verifier behavior is unchanged.
- local-ledgers source.inspect missing-repo failure came from the run spanning an active source edit: QA started09:44:46, the error mapping was changed09:49. This test imports source daemon (not directly dist), so we do not assert a stale dist binary was uniquely responsible. Current frozen source has passed this case repeatedly, and no production relaxation was made for it.

Validation: real-default CLI four files124/124 passed after agents rebuild. Agents entire suite24 files358/358 passed (including9 DeepSeek tests). CLI typecheck and targeted Biome passed; agents build passed. Raw logs use cli-fixture-default-output-* and cli-fixture-agents-suite.log. Original mixed-source QA failures retained unchanged.

Scope review pending: cli-default-output-reaudit-* contains exact hashes for production, test and reviewer-isolation context. This is independent of F3's Loop audit and F2's source audit.

## Follow-up findings and final source freeze

The initial review returned NEEDS_FIX (cli-default-output-reaudit-result.json). Preserved that result; no approval is claimed for that version. Follow-up changes:

1. Scratch allocation exceptions emit deepseek_output_unavailable and failed done before external invocation. They no longer become false stop-unconfirmed outcomes.
2. Loop verifierAgentTask strips repository task review_output_path and verify_output_path. Standalone adapter API precedence remains supported, while constructor options remain host-owned. The real CLI integration supplies malicious external destinations for both task keys and proves neither exists. Generic reviewer integrity checks remain in force for explicit host paths into the candidate.
3. Output progress is raw JSON, preserving long/spaced paths. Successful done.result_summary includes the actual selected destination; Loop summarize appends successful adapter summaries. Real CLI and daemon run results expose the file destination; tests also read actual output.
4. Abort after allocation is checked before diff/main spawn, and runCommand has an early aborted guard. Allocation and evaluation artifacts are retained in normal runtime scratch; operators clean them using the normal scratch policy.
5. Blank output overrides fall back to allocated output; outside-workspace assertions require exact parent path segments.

Validation after follow-up: DeepSeek12/12, verifier39/39, CLI4 files124/124, then real malicious-context CLI1/1, agents and Loop builds, CLI typecheck, Biome7 files passed. Final agents suite initially360/361: unrelated controlled-session first test exceeded its existing5000ms timeout at5046ms; log preserved and unchanged suite retry in progress. Scope follow-up review cli-default-output-r2-reaudit-* is in progress. No claim of passing full repository QA is made here.

Unchanged full agents retry also360/361, now a different controlled-session test (unknown native session/persistence) timed out at5000ms while the prior failed first test passed. Both logs remain. This supports a load-sensitive timeout hypothesis but is not proof of root cause. No timeout or production change was made. Parent final whole-repository run uses20s test timeout and2 workers; await its evidence rather than increase concurrent test load.

## Final scope review result

cli-default-output-r2-reaudit-result.json returns PASS_SCOPED: all prior blocking findings resolved. CLI process exit0; tool-less static review only, not reviewer-executed tests. Manifest freezes full source hashes/excerpt hashes and prompt hash. Residual accepted items: failed reviewer partial-output path is progress-only, error allocation details are deliberately generic, start progress is abbreviated while output event is authoritative, and runtime output artifacts persist until scratch:clean. The test setup sets TMPDIR per worker but preserves explicit OSSTACK_SCRATCH_ROOT, so default-output fixtures also leave runtime artifacts under that root; do not claim worker cleanup removes them. Required imports were checked in current files and their passing integration tests exercise them. Parent owns final full-suite/CI acceptance.
