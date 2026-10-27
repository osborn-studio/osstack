# Session terminal-fence validation after retargeting

PR #279 is tested against main `28d116f3f8c15f64bebb314308adf320d8380b2b` after #278 merged. Product/test candidate: `c60850c4461f42c76508ae7f63c0c3b17b951733`. Later documentation commits only archive this exact candidate's evidence.

Session start now rejects iterator exhaustion without a completed terminal. Session send already rejected the result; it now waits for the existing trusted adapter stop confirmation before releasing the writer lease. Unconfirmed stop retains admission. A trusted completed terminal followed by normal exhaustion proves invocation completion, independently of later result validation. Completed streams with a missing native session ID still return failure but do not retain a completed invocation.

## Verification

- Full monorepo: **6,276 passed / 5 skipped / 0 failed**, 22 packages, Node 22.22.1.
- Focused Session/RPC/wait/command/drain/lifecycle tests: **90 passed**, 6 files.
- Build, full typecheck, lint, inventory and changeset coverage passed. Build preceded the final adjacent-test/changeset-only commit; [source binding](build-source-binding.json) confirms identical runtime source. Final typecheck/lint/focused checks and the full suite cover the final committed candidate.
- [Full result](test-summary.json), [commands and scope](verification.json), [lossless archive index](archive-manifest.json).

## Independent audit

Claude CLI actual model `claude-sonnet-5-5`, tool-less, completed two rounds. Round 1 returned PASS with testing/documentation concerns. We removed an assertion on an unused adapter fixture, added completed-without-native-ID coverage, documented invocation/result separation, and strengthened failed Session/run/card/receipt/turn assertions. The proposed native-ID uniqueness collision was rejected against the actual schema, which has no such UNIQUE constraint. [All original dispositions](round1-dispositions.json) remain available.

Round 2 returned **PASS, no confirmed P0/P1/P2**, and accepted all six dispositions. [Audit/code binding](audit-code-binding.json) records exact source hashes. The archive retains both complete prompts, raw JSON responses, raw reports, stderr and run metadata; audit conclusions do not replace execution evidence.

## Boundaries

No schema or recovery API is added. Restart tests use the same process; cross-process retained-hold visibility and recovery remain DEBT02/J12. Fixture subprocesses are local deterministic executables, not live providers. Existing stop confirmation still receives Session run_id; future adapters returning positive stopped proofs need exact invocation identity before they can claim that support. Start replay reads a stored snapshot, so RPC ok does not itself mean the stored state succeeded.

The full run is new evidence for this exact main-based candidate. Earlier 89-test runs and initial audit input belong to `f35360a15edef924d84870855a279d3275798b23` and are historical. The final audit and 90-test/full-suite evidence bind `c60850c4461f42c76508ae7f63c0c3b17b951733`. The uncommitted knowledge dist files produced by the build are generated output and are restored only after validation completes.
