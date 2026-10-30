# PR308 actual-main revalidation

PR307 was user-merged at de43f47c29d5c08ae6e6c5eb366767320ffcdd0c on 2026-10-30T00:05:05Z. Its tree equals published 8fd28911. Candidate 6d978973 has parents b4a2fc30 and actual main de43f47c; its complete tree equals b4a and full main delta is byte-identical to the original parent-based delta. This equality does not relabel historical test runs.

Fresh Node22 install/build, GitHub 172 tests, candidate CLI 14 tests, lint, inventory, typecheck, 241 document tests and one hygiene test passed at 6d978973. The fixed three-PR responses were consumed through newly compiled public ingestion/drift/topology with no live forge or DB write. Four fresh knowledge/dist files were saved with bytes/hash/patch before restoration; the validation checkout was then clean.

Actual tool-less Claude CLI Sonnet5.5 static review returned PASS. Its limits about unseen fresh validation and Git equality are independently answered by the raw command receipts, not by claiming the model ran them. Non-blocking test suggestions remain optional. Confirmed documentation mismatch was fixed by incorporating the latest central control and CI-final evidence: both ledger and rollup now mark PR307 merged, PR308 actual-main validation in progress. Parent PUBLIC_EXPORTS wording is explicitly historical. Historical snapshots under publication/ci-final retain their observation times and are not current PR status.

This documentation reconciliation changes no product/test source relative to 6d978973. A scoped documentation closure review and current-head CI are still required before Ready. The new CheckRun policy repair is a separate downstream candidate and is not in this PR. No formal milestone, native host effect or merge authority is claimed.
