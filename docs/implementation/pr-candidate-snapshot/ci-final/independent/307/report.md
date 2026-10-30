# PR 307 completed CI record verification

- Run: 40929858660; head `8fd2891174964bb539f5ca9b094549a090517d5e`; recorded base `main` / `6c9a3e8f11f2664f15b4ce4a26c5014d68fdcd4b`.
- Actual checkout: `f98544d70774082c1e747b960a0148ec35563a94`. HEAD is now at f98544d7 Merge 8fd2891174964bb539f5ca9b094549a090517d5e into 6c9a3e8f11f2664f15b4ce4a26c5014d68fdcd4b. These are synthetic merge tests, not a claim that the bare PR head was checked out.
- Five jobs success; paid semantic smoke skipped. Lint, Build, Inventory freshness, Typecheck, Test and all subsequent applicable check steps succeeded.
- check/Test: 22 unique packages, **7189 passed / 7 skipped / 0 failed**. GitHub package: **154 passed**. Standalone PR snapshot CLI: **14 passed** (distinct from the CLI package's 2764 passed / 6 skipped).
- Standalone export: 94 total / 93 passed / 1 skipped; projection 88, journey 43, pagination 14, maintenance 24 all passed. Export skip is the absent global Codex skills-home case, preserved verbatim in report.json.
- Actual default and full journeys recorded expected product exits 0/1 and 0/1/2/1/0 respectively, with driver exit 0 and fixture removal. Both project/check pairs emitted matching packet hashes and valid status. Maintenance recorded consistent status, exit 0 and unchanged map. Engineering adoption and local Git skills-check smokes recorded passed.

This is independent parsing of complete CI records, not local test re-execution. Raw log bytes and lossless gzip are retained; ANSI is removed only in the parsing view. Logged packet hashes were not independently rehashed: no artifacts were downloaded. Fixture removal does not prove full-descendant termination. No model/native provider or formal gate qualification is inferred. PR state is only the collection-time snapshot; this task did not change it.
