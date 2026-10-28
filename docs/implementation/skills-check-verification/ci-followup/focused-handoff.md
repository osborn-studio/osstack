# PR291 focused CI follow-up

Product commit: bcc4c732a99e5bf36d7aa3210b06784cc9c81765 (parent7228af77). Only watcher.ts and its new six-case test committed. Root owns CI upload changes, changeset, merge-main, full regression and actual Sonnet audit.

Confirmed defect: watcher parsed git ls-remote at process exit, which does not guarantee drained stdout/stderr. The controlled reproduction uses a real local Git repository/result and a direct shim that exits before a child finishes inherited stdout. Old compiled code resolves no_matching_ref before the correct head arrives; corrected code waits for close and reports the correct head/drift. Event-order tests also reproduce lost trailing stderr and a prematurely cleared deadline. The minimal fix changes exit to close, without changing concurrency, retries, expected product statuses or smoke predicates.

This does NOT establish the cause of historical CI40658708716. Its mixed raw stdout/artifacts were unavailable; only the summary shows drift mismatch plus two summary mismatches. No platform-specific or clone/cache cause is claimed. Preserve original-ci-failed.log and both controlled outcomes.

Final targeted results: skill-registry43/43, smoke-driver25/25, registry build/typecheck, standalone actual compiled CLI all five cases passed (0/1/2/1/0), evidence hashes/receipt bytes/fixture absence checked. Baseline frozen install/build passed. Full suite was intentionally not repeated by this worker. The all-five run recorded Git HEAD7228 with final modified product bytes; verification.json proves those individual source hashes equal bcc. Never relabel this run as a later root merge-head run.

Raw evidence and exact inputs are under this directory. Reproduction Git fixtures are disposable and not part of the archive; script, real Git command/output records, shim, timeline and outcomes are retained. Generated build outputs remain in the worktree for root full tests; do not restore knowledge/dist before those complete. No PR push or metadata changes made here.
