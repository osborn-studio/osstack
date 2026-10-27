BEGIN_AUDIT

**Verdict: REVISE.** No P0 found. The ledger content is mostly conservative and correct about the stale state. The validator does not enforce several of the guarantees the task depends on.

Scope: static review of the pasted files only. Nothing was executed, so test results are unverified.

**What is consistent**
- #272, #275, #277 and #280 are MERGED, and `main_sha` 4924d224 equals #277's merge commit.
- #273 is Draft with base `main`, and its slice has `base_branch: main`.
- #274 and #281 still have base `codex/joint-contracts` and are marked `stale_requires_revalidation`. Their `observed_base_sha` equals #273's `headRefOid` 6b822c6c, and their `base_sha` fad0dd45 is retained.
- Both stale slices and both nodes are `blocked`, `runtime_enabled` is false, and the `ci_scope` text correctly disclaims combined-tree coverage.

**P1: the old candidate SHA is preserved only by accident.**
- fad0dd45 exists only as `base_sha` inside the downstream J02a and J11 slices.
- The #273 slice records only the new `candidate_sha` 6b822c6c. There is no `superseded_candidate_sha` and no link to the CI evidence for the old head.
- The #273 PR row carries only the new head's check rollup.
- When #274 or #281 is rebased, the old SHA and its evidence vanish from the ledger. The validator never checks that a superseded SHA is retained.
- Fix: add `superseded_candidate_sha` and `superseded_evidence` to the #273 slice. Require them whenever any downstream `base_sha` differs from the observed head. Also require a retained `base_sha` to be a 40-hex string.

**P1: mixed-age PR snapshots with no validator check.**
- The #274, #276, #278, #279 and #281 rows have no `observed_at`. The other rows carry 08:08:43.
- #281's checks show `IN_PROGRESS` since 07:30, which is about 38 minutes older than the ledger's `observed_at`.
- The ledger's own `observation_rule` requires per-snapshot times, and the validator does not enforce it.
- The stale-marker logic compares `base_sha` only against #273's `headRefOid`. It never confirms that #274's and #281's own heads or bases are fresh.
- Fix: require `observed_at` on every PR row and reject any row older than `ledger.observed_at` without an explicit `snapshot_stale` flag.

**P1: stale candidates are not fully blocked at the node level.**
- J02 and J11 keep node `state: candidate_pr_open`, with only `board_status: blocked`. That can read as active progress.
- The validator checks `board_status` but not `node['state']`.
- J02a also still carries `audit.verdict: "PASS"` and `validation.passed: 6161` inline. Nothing marks them historical or superseded. The prose in `merge_blocker` does say they are historical, but that is not machine-checked.
- Fix: for a stale slice, require node `state == "blocked"`, require `audit.superseded: true` or an equivalent field, and require validation/audit evidence to be labelled `historical`.

**P2: slice and PR consistency is not checked.**
- Slice `state` is unvalidated except for stale slices. #273's slice uses `revalidating`, which is outside any enumerated set. A non-stale slice could be `ready` and pass.
- The validator does not compare a slice's `candidate_sha` or `head_sha` with the PR's `headRefOid`, or a slice's `base_branch` with `baseRefName`. It also does not require that #273 `isDraft` while its slice is `revalidating`.
- A new push to #273 would not trip any check on the J01 slice, so the J01 slice could silently describe a different head than the PR.
- `state == done` checks only acceptance, merged PRs and two evidence keys. It does not check that `depends_on` nodes are done. It also does not check that `merge_commit` is reachable from `main_sha`. This is an integrity check, not a scheduler requirement.

**P2: evidence references are only partly verified.**
- Only the handoff report hash is verified.
- `management.entry_sha256` is not checked.
- `validation.report`, `audit_binding`, `audit_archive` and `code_candidate` are never checked for existence or hash.
- Paths are joined to `ROOT` without confinement, so an absolute path or `..` in an untrusted ledger escapes the tree.
- Fix: resolve each path and require `is_relative_to(ROOT)`. Check that evidence files exist for any slice that cites them.

**P2: wording that could imply authority.**
- `handoff.acknowledgement` says "accepts sender COMPLETE report". It should be quoted and scoped, for example "sender's self-reported status; not verified completion".
- Handoff `state: accepted` is a hard gate in the validator. It reads as an approval gate, and it is required rather than informational.
- The handoff `prs` list [275–279] now mixes merged PRs with open PRs whose bases have merged. #276, #278 and #279 sit on merged or retargeted bases, and are not marked stale or blocked. They are outside the milestones, but the ledger neither says so nor flags them.

**P2: test gaps.**
- No test covers:
  - a tampered handoff hash;
  - a missing evidence file;
  - an empty `revalidation_required`;
  - a stale marker without drift (the validator branch exists, the test does not);
  - a stale node with `board_status` not blocked;
  - a duplicate card or an unknown PR;
  - the J11 slice.
- `stale_slice()` hardcodes `milestones[1]` and overwrites a slice that is already stale in the real ledger. The "explicit stale" test therefore proves little.
- `test_valid` runs against the live ledger, so it fails whenever the real ledger legitimately changes.

**P3**
- `prs[part['base_pr']]` raises `KeyError` instead of `ValueError`, because the unknown-PR check runs after the lookup.
- The owner thread ID and the count 32 are hardcoded. A legitimate handoff then requires a code change.
- `import hashlib` is placed mid-function.

**Required before PASS**
1. Add the superseded-candidate and evidence fields, with validation.
2. Require `observed_at` on every PR row.
3. Check node `state`, slice `state` and slice-to-PR head consistency.
4. Mark audit and validation evidence as historical on stale slices.
5. Add the missing negative tests.

END_AUDIT