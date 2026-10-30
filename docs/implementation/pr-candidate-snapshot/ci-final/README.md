# Final CI and readiness

PR307 run40929858660 on8fd2891174964bb539f5ca9b094549a090517d5e completed all five applicable jobs successfully; paid smoke skipped. Root changed307 to Ready and independently re-read isDraft=false/main/MERGEABLE. This is permission to request user review, not approval or merge authority.

PR308 run40930144304 onb4a2fc30711d9c3ad5cddbc846839948f1810c56 also completed all five applicable jobs successfully. It remains Draft on307 feature parent. User merge307 and actual-main/tree/diff retarget/revalidation must occur before Ready. Original failure runs remain in ci-repair/inventory-repair. Full logs and exact checkout/count extraction are stored separately under independent; no remote artifact was downloaded or rehashed.

Root independently parsed only the check/Test step, asserting22 unique package summaries per run:307=7189 passed/7 skipped/0 failed;308=7207 passed/7 skipped/0 failed. These CI populations are distinct from earlier local full counts. Final central docs validation passed241 tests.

Independent final manifest3a9c8db36cf34616ad84fa063ceffeb3b744d7d48d90869906878a3540c25731 covers34 original payloads, all root-verified. Two complete raw logs are stored losslessly as their verified gzip payloads with decoded byte/hash/mode receipts. Actual synthetic checkouts were f98544d70774082c1e747b960a0148ec35563a94 (307 into main6c9) and c323e040a627a3e97f67e39987e061ca7e6852a0 (308 into parent8fd). GitHub package154/172 and candidate CLI14 passed; exporter94 total means93 passed+1 skipped, not94 passes. Projection88/journey43/reader14/maintenance24 passed; real default/full/map/projection/check steps succeeded. No downloaded remote artifacts are claimed rehashed.
