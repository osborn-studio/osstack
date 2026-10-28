# Exact published-head composition verification

Composition commit: `d31dc0b60c91883590f1f63ce69c1acb238679f3`; tree `9efad98d9560076ec33611ae75841c7ac85e0fc2`.
Parents: `2b8ef9b707b672ffd89c389d9abbc368e8e6b9ca` (PR291) and `fe9079a1c2f2ea7f9d61030a88bbd58b276ce56b` (PR292). The merge was conflict-free and matched the predicted tree. This is a new execution, independent of prior composition archives.

Fresh frozen install and build passed. Requested checks passed: headers14, method-export63, skills-driver25 and actual5 cases, hygiene1 and joint-docs241. Every command record includes exact HEAD, argv, environment, timestamps, exit code and raw-log hash. All seven commands exited0. Actual cases retain expected product exits0/1/2/1/0 while the verification driver exits0. All 49 driver manifest members were checked and the fixture directory is absent. Descendant termination is explicitly not attested.

`build-files.json` records the actual fresh generated files; the driver also retains its original source/build binding. No full repository suite ran on this composition. Each PR's remote CI is separate evidence, not a combined-suite claim.

After all checks, only the four tracked knowledge/dist generated files were restored, each matching its original Git blob. Worktree is clean. No checks ran after restoration. No product edits, PR writes, push or central-ledger edits occurred. The root owner can now remove the checkout; the merge commit remains on codex/joint-final-ci-composition.
