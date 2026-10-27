# Audit: joint-engineering checkpoint, validator and refresh script

**Verdict: REVISE.** The validator is mostly fail-closed and its tests are broad. The gaps below are in what it never checks and in what the refresh script writes as fact without deriving it. I reviewed the pasted text only and cannot independently prove forge, CI or board state.

## P0
None found.

## P1

1. **Code SHA vs PR head is never reconciled.** `ready()` checks `code_sha` against the audit binding and against `validation.code_sha`. Neither the validator nor the script relates `code_sha` to `head_sha`, so nothing checks that the head moved only by docs.
   - If head advances with a product change, the ledger can still show `current_for_code_sha` and `ready`. That contradicts the rule in `project-operations.md` §2 that code changes expire the old evidence.
   - Fix: record `head_sha` and `code_sha` as distinct fields, and require either equality or an explicit `docs_only_since_code_sha` with a recorded diff-stat or tree-hash proof. Add the tests.

2. **`base_sha` is stamped, not measured.** The script sets `base_sha=main` for every successor and then marks evidence "current". It never compares this to the base the binding or verification actually tested.
   - The validator then checks `base_sha == main_sha`, which is true by construction.
   - Pass/fail counts come from the binding's self-report. `v` (the verification JSON) is only checked for `code_sha` and a truthy `finished_at`, so a failed verification would still pass.
   - Fix: take the tested base and the exit code or counts from `v`, assert them, and fail if the tested base differs from the current main.

3. **Evidence is not content-pinned.** Only the handoff report has a sha256. Audit bindings and reports are checked for existence and path only.
   - They are copied with `copyfile` from sibling worktrees that are not pinned to a commit.
   - Receipts are copied only `if exists`, so missing ones are skipped silently. The ledger still claims "subagent dispatch" and "board final" management.
   - Fix: store a sha256 for each referenced evidence file, verify them in the validator, and require the receipts when the mode claims them.

4. **Hardcoded "Ready" narrative and "current" evidence on Draft PRs.** The obligations text for 276/278 always says "Ready after local final validation and Sonnet audit".
   - The state is `revalidating` when the PR is Draft, but the script still writes `evidence_status`/`audit.status = current_for_code_sha` and `validation.status = passed_for_code_sha`.
   - The validator skips evidence checks for `revalidating`. A Draft PR can therefore carry "current PASS" claims and the text "Ready".
   - Fix: derive the text from `prmap`, and for `revalidating` require non-current evidence statuses or at least a check against the binding.

5. **Historical evidence can be lost from the live ledger.**
   - The script resets `successor_deliveries=[]` and rebuilds only 276 and 278.
   - It overwrites `audit.status` and `validation.status` on merged slices 274 and 281.
   - Preservation relies on a once-only `ledger-before.json` copy, and `predecessor_history` is never validated.
   - Fix: append to history instead of resetting, require evidence URL/hash in `predecessor_history`, and snapshot the ledger with a hash on every run.

6. **Completion guards are truthiness only.** `done` requires `node.get('acceptance_evidence')` and `merged_candidate_ci_evidence` to be non-empty, but neither is resolved with `evidence()` or hashed. `acceptance == 'passed'` is self-asserted. This is the main false-completion path, so require real files and hashes.

## P2

- **Board state is unverified.** The script sets `node['state']='in_progress'` and `board_status='ready'` for 274/281 unconditionally, which can clobber a blocked or multi-slice node. It does so without reading the board, and the validator never cross-checks `board_status` against the snapshot JSON.
- **Management target is unrecorded.** The `rpc` helper is imported from another tmp directory, and the snapshot does not record which home or socket was used. Operations §2 forbids the default `~/.osstack`. Record the home and socket and assert them.
- **Observation window is incomplete.** Only `started_at` is recorded, and PR heads are not re-read after the second `origin/main` check. `mergeable` is not fetched even though §6 requires it, and `statusCheckRollup` is fetched but never evaluated. Nothing marks `ready` as "checks pending", so §2's pending-checks rule is unenforced.
- **`parallel_preflight` is unvalidated.**
  - `candidate_sha` is abbreviated (`4cdf36e3`).
  - `tests_passed` and `files` are hand-typed.
  - State and PR head are never checked.
  - The obligation text "Still Draft" is hardcoded and can go stale.
  - `packages: 22` is also hardcoded.
- **Cross-structure duplicates and age.** There is no check that a PR is not both a slice and a successor. There is no maximum-age or future-time check on `observed_at`, so an old checkpoint passes forever. This is acceptable only because it is documented as offline.
- **Authority wording in the operations doc.** §3 has the main entry convert PRs to Ready, retarget bases and edit PR descriptions. Your stated authorization covers progress/evidence and subagents, with approval and merge left to you. State explicitly whether Draft→Ready and retarget are pre-authorized.
- **Heartbeat and goal_dispatch wording.** The doc asserts the heartbeat exists and goal_dispatch is off. These are unverifiable by the validator and should be recorded as owner-asserted. The wording itself correctly avoids claiming runtime qualification.
- **Test gaps.**
  - The `setUp` fixture is a legacy snapshot patched to pass. Only `test_current_checkpoint` exercises the real ledger.
  - Missing tests: code-vs-head, Draft with current evidence, evidence hash mismatch, `done` evidence resolving to a file, and a missing `predecessor_history`.
  - The `json.loads` patch in `test_ready_revise_binding` is brittle, since it keys on `code_commit` only.

## Optional improvements
- Split the validator into a pure function plus a CLI, and return all errors instead of raising on the first.
- Make the refresh script idempotent: a `--dry-run` flag, versioned snapshot directories, and no hardcoded SHAs or PR lists.
- Add a validator mode that takes a fresh `gh` JSON dump, so the live-vs-ledger diff is checkable without trusting the ledger.

END_AUDIT