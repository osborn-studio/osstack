# Session terminal fence after PR #282

Revalidation base: `ede5aadced37ac9dc29dd21f0e307ad2c46d2976` (PR #282 merged). Final product/test candidate: `cb76b6432d597d1c057d241f17e652308286b8ee`. This archive records fresh execution and fresh Claude CLI review; the prior `joint-terminal-retarget` archive remains unchanged.

## Integration and changes

Merging #282 produced no conflicts. The terminal-fence patch was initially byte-identical before and after merge. The new base changes core behavior-registry implementation/tests and its export; shared protocol/recovery contract source is unchanged. [Baseline analysis](baseline-impact.json) retains both patch hashes.

Fresh review found that late throw/failed terminal tests only exercised unconfirmed stop. We added four confirmed-stop variants across start/send. They require exactly one physical release and no retained lease, while the result and persisted receipt remain failed. Product runtime logic is unchanged by this follow-up.

## Fresh verification

- Full monorepo: **6,293 passed / 5 skipped / 0 failed**, 22 packages.
- Session/RPC/wait/command/drain/lifecycle focused run: **94 passed**, 6 files.
- Additional caller regression: **43 passed**, 2 files, covering collaborator RPC and Attention answer through Session RPC. A targeted terminal/lifecycle/engineering run passed 63 tests before committing the identical test change.
- Fresh install/build/typecheck/lint/inventory/changeset checks all exited zero. Tool versions, exact commands, timestamps and log hashes are in [verification.json](verification.json); package counts are in [test-summary.json](test-summary.json).
- The first complete final-candidate suite failed one installer test because the outer fixed OSSTACK_SOCKET overrode its per-fixture HOME. Installer implementation and test are byte-identical to the base. The same environment reproduced 1 failed / 11 passed; removing only the outer socket override passed 12/12, then a fresh full-suite run passed as counted above. Raw failed logs and [diagnosis](installer-environment-diagnosis.json) remain unchanged. Verification historical_runs preserves this genuine failed attempt; final effective commands and acceptance use only `test-full-final.log`.
- The next full-suite attempt stopped early at the governance documentation check: concurrent central-design edits linked to this archive entry before it existed. Creating a truthful in-progress README fixed both references; the focused hygiene check passed, then a fresh full run completed. `test-full-isolated.log` preserves that second failure. No product code changed between these runs.
- All CLI/test execution used explicit scratch homes and the shared scratch root. No serving/default control-plane database was opened.

## Fresh independent audit

Actual model: `claude-sonnet-5-5`, tool-less Claude CLI. Round 1 returned PASS with coverage notes. [Round 1 dispositions](round1-dispositions.json) record the confirmed-stop correction and reject the claim that whitespace/hung stop-verifier cases had no tests: the existing adapter-lifecycle suite already tests both.

Round 2 returned **PASS, no blocking P0/P1/P2**. It retained non-blocking notes about a cancelled-terminal branch, missing collaborator test context, and formatting. [Round 2 dispositions](round2-dispositions.json) preserve their exact status; the caller tests were then freshly executed. We do not rewrite this as a report with no comments. [Audit binding](audit-code-binding.json) records exact source, input and raw response hashes. Both original rounds are retained losslessly.

## Historical run and limits

The first candidate `d5754edb8635015d6f66a27c8b71575f80344b67` passed setup/build/focused/type/lint checks. Its full test process was deliberately stopped with SIGTERM to freeze the additional audit-driven test coverage first. That interrupted run is **not a passing result**; its original command record/logs and [reason](superseded-run.json) remain under `historical-candidate/`. All final counts above come from the new completed run on `cb76b6432d597d1c057d241f17e652308286b8ee`.

This PR still does not provide live-provider stop qualification, cross-process retained-hold recovery, or new runtime activation. Those remain DEBT02/J12. Trusted terminal completion and normal iterator exhaustion establish invocation completion; result validation can still fail. Start replay RPC ok only means the stored snapshot was read. Future positive stop proofs must bind the exact invocation; the inherited Session run_id interface is not that future qualification.

[Archive manifest](archive-manifest.json) hashes compressed bytes and decompressed original bytes separately. Later documentation-only commits may carry this archive without changing the validated product/test candidate.
