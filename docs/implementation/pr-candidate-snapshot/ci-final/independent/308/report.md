# PR 308 completed CI record verification

- Run: 40930144304; head `b4a2fc30711d9c3ad5cddbc846839948f1810c56`; recorded base `codex/pr-candidate-snapshot-delivery` / `8fd2891174964bb539f5ca9b094549a090517d5e`.
- Actual checkout: `c323e040a627a3e97f67e39987e061ca7e6852a0`. HEAD is now at c323e040 Merge b4a2fc30711d9c3ad5cddbc846839948f1810c56 into 8fd2891174964bb539f5ca9b094549a090517d5e. These are synthetic merge tests, not a claim that the bare PR head was checked out.
- Five jobs success; paid semantic smoke skipped. Lint, Build, Inventory freshness, Typecheck, Test and all subsequent applicable check steps succeeded.
- check/Test: 22 unique packages, **7207 passed / 7 skipped / 0 failed**. GitHub package: **172 passed**. Standalone PR snapshot CLI: **14 passed** (distinct from the CLI package's 2764 passed / 6 skipped).
- Standalone export: 94 total / 93 passed / 1 skipped; projection 88, journey 43, pagination 14, maintenance 24 all passed. Export skip is the absent global Codex skills-home case, preserved verbatim in report.json.
- Actual default and full journeys recorded expected product exits 0/1 and 0/1/2/1/0 respectively, with driver exit 0 and fixture removal. Both project/check pairs emitted matching packet hashes and valid status. Maintenance recorded consistent status, exit 0 and unchanged map. Engineering adoption and local Git skills-check smokes recorded passed.

This is independent parsing of complete CI records, not local test re-execution. Raw log bytes and lossless gzip are retained; ANSI is removed only in the parsing view. Logged packet hashes were not independently rehashed: no artifacts were downloaded. Fixture removal does not prove full-descendant termination. No model/native provider or formal gate qualification is inferred. PR state is only the collection-time snapshot; this task did not change it.
