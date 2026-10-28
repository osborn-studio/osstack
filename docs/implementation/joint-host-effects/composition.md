# PR288 + PR289 applicable composition verification

Tested composition commit: `d461b059c5cb475f11ac11acd35134be3a771938`.
Exact parents: PR289 `48f5a9f1a6bfc5c4a82645dfd8bcc96a3125c69e`, PR288 `10629495aafe7b3aca0de4c920bcaec40b083d7b`.
Tree: `827495237d56c84a49f7785eda373c1771ff0eca`, independently equal to git merge-tree of the two parents.

The supplied worktree began clean without node_modules. Fresh `pnpm install --frozen-lockfile` and `pnpm build` both exited0. `node --test scripts/smoke-engineering-decision.test.mjs` passed all27 tests with0 failed/cancelled/skipped. Exactly one subsequent real smoke invocation with a new explicit evidence directory exited0. No retries or full repository test run were performed.

The real smoke receipt and saved receipt are equal; status passed, action receipt applied, completion observed_turn, provider_qualified false. Cleanup confirms actual process exit and fixture removal; the original fixture path no longer exists. All4 retained evidence files match manifest byte lengths and independently recalculated SHA256. Source/build bindings remained unchanged during the run and identify the original composition HEAD. Evidence remains under live-evidence/ after fixture cleanup.

Only the4 tracked knowledge/dist files changed by this fresh build were restored. Restoration required exact comparison with the recorded postbuild hashes before copying the saved prebuild bytes. No unknown change was overwritten. Final git status is clean. Ignored installation/build files stay in the supplied worktree for owner removal; this agent did not remove the worktree or change PRs/ledger/management state.

## Separate post-merge tree observation

After the user merged PR288, main commit `4d31c3f540672c81a6c5d65b3a2b090dc32da027` was independently observed to have the same Git tree as tested PR288 head10629495. A fresh git merge-tree of that exact main commit with PR289 head48f5a9f1 yields the same827495237d56c84a49f7785eda373c1771ff0eca tree tested above. The commands and outputs are retained. This is content-equivalence evidence only: the original test records remain bound to d461b059, and no claim of test execution at the new main commit is made.

## Scope and records

This is applicable combined-candidate revalidation: fresh build, the27 regression cases and one real local deterministic smoke. It is not a combined full repository suite, a live-provider test, formal runtime/principal qualification, approval or a release gate. Commands, exact cwd, minimal PATH, explicit scratch home, original outputs, Git object bindings and local runtime version are retained. OSSTACK_SOCKET was unset for execution, and no default OSStack home or management instance was used. The script's isolated fixture credentials are sanitized in its evidence.


## Later published-head CI observation

PR289 head `48f5a9f1a6bfc5c4a82645dfd8bcc96a3125c69e` completed run40651082036 with five applicable SUCCESS checks and the conditional paid smoke SKIPPED. The three native recovery cases passed (reported totals21,249/21,112/21,513ms, including hooks). This does not establish the original failure's cause or prove a performance gain. The PR is Ready pending user approval/merge. [CI/board receipt archive](pr289-ready.tar.gz) is indexed by [its manifest](pr289-ready-manifest.json); earlier observations remain historical.
