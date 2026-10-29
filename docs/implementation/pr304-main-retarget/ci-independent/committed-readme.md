# Full five-case verification journey

The existing user journey covered only healthy and missing-ref even though its driver supported three more outcomes. Add `--scope full` to run healthy, missing-ref, drift, mixed and empty in that order. Default calls still use the existing pair and remain compatible with the unchanged evidence projector.

Each row checks raw CLI output, source cardinality, fixture Git old/current SHAs, source refs/blessed SHAs, unchanged input, receipt consistency and cleanup claims. Product exits are 0/1/2/1/0; a verified negative is not a healthy source. Empty means no source was checked. Failure stops later rows, preserving failed/not_run/unknown distinctions and raw records. Full means these five local cases, not all possible product behavior.

The existing two-case projection deliberately rejects the five-case result before creating its packet. A separately queued full-scope projection is needed for a model-safe five-row packet; this PR does not drop rows or broaden the old contract. No model/host task, provider, daemon or new method is introduced. Four entries and fourteen methods remain unchanged.

Use the actual checkout and supported build prerequisites in `osstack-methods-skill/references/skills-check-journey.md`. The CI keeps the default pair and projection checks and adds an independent full-journey run and retained artifact. Task card `card_ddf5e661` contributes to PS08/PS09, primary J03, supporting J06/J09. Formal joint qualification stays false.

## Verification scope

Author code `32a9a9e1` and docs `08c48fcb` are composed at root `6e4c6168`. Root standalone tests pass 186/186: 43 journey, 49 projection and 94 exporter contracts. The independent FJ01–10 criteria were frozen before author implementation; raw first failures are retained. Author actual full/default runs and unchanged projector outcomes are recorded with working-byte hashes, not retroactively relabeled as commit runs. Actual Claude CLI `claude-sonnet-5-5` static review returned PASS with optional suggestions; original input, response and source bindings are retained. Independent verification on the composed candidate passed: actual default and full journeys, seven source/receipt/cleanup records, 30 bounded interface/adversarial observations, and four failure seams. The original two-case projector succeeds on default output and refuses full output without writing or changing its input. This independently covers the actual-run suggestions in the static audit.

Package sources, package manifests and dependencies are unchanged from the immediately preceding 7,144-pass/5-skip package regression. That run keeps its original 14853→969da2df scope and fresh-dist limitations; it is not claimed to cover this new standalone implementation. Relevant standalone and actual journey checks cover this change, while published-head CI supplies a new full regression before Ready. No additional local whole-package rerun is attributed to this slice.

241 design checks and one documentation hygiene test passed. Retained failures include the author’s initial TDD failures, one test reason expectation corrected without lowering behavior assertions, and an invalid build-command flag before the successful normal build. These are recorded separately from product failures. No source correction was required by the final audit or independent review.

Archive: `evidence/raw-verification.tar.gz`, SHA256 `2bf810794c7509cf7a3f65ddc5865be7531f69bb46651a48b49170e82f937378`; 1258 members / 18798026 file bytes verified against their hashes, lengths and modes. Original audit input/response/bindings and unmodified frozen criteria are included.
