# PR308 final-head CI independent record review

Run 40979169462, head `4a7ee75de6394a6dd8c3fdb24ecf8700be5e0bf3`, base `main` / `de43f47c29d5c08ae6e6c5eb366767320ffcdd0c`. Actual synthetic checkout `25bb08b59939d7573d73cbe6594ce7e12a6af89b`; `HEAD is now at 25bb08b5 Merge 4a7ee75de6394a6dd8c3fdb24ecf8700be5e0bf3 into de43f47c29d5c08ae6e6c5eb366767320ffcdd0c`. This is not a bare-head checkout claim.

Five applicable jobs succeeded; paid smoke skipped. Lint, Inventory freshness, Build, Typecheck, Test and subsequent applicable smoke steps succeeded. check/Test contains 22 unique packages: 7207 passed / 7 skipped / 0 failed. GitHub package 172 passed; CLI package 2764 passed / 6 skipped. The separate offline candidate CLI step passed 14. Export contracts:94 total/93 passed/1 skipped; projection88, journey43, pagination14, maintenance24 passed.

Logged actual two- and five-case journeys passed with expected product exits 0/1 and 0/1/2/1/0; driver exits all0, fixture removal recorded. Default/full projection and check each emitted matching logged packet SHA and valid status. Five-case maintenance was consistent, exit0, with unchanged map. Engineering decision and local Git skills-check smokes passed. Full structured values and source log line numbers are in report.json.

Old run40977980388 on6d978973 completed cancelled after supersession, not a test failure. The final run was not re-run or modified by this reviewer. Raw full logs plus lossless gzip and command/metadata records are retained. No artifacts were downloaded or independently rehashed. This is evidence parsing, not independent product test execution; no native-host, formal-gate or full-process-tree qualification is implied. PR metadata is a collection-time snapshot; only root changes Ready.
