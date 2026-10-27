BEGIN_AUDIT
**Verdict: REVISE (minor). No P0 or P1.** Static review only. Nothing was executed, and this is not runtime qualification. Draft/in-progress status is correctly marked, and J12 runtime, WAL/crash, trusted-auth and provider work is out of scope and not counted.

**Prior findings: closure check**
- **Round-4 P1-1 (digest-keyed sealing): closed as a documented host obligation.**
  - The doc now says J12 must recompute `recoverySubjectDigest(subject_json)` before INSERT, and that sealing is conditional on that check.
  - The test (`persist(...{subject_digest:'f'.repeat(64)})` → `SUBJECT_MISMATCH`) pins the check at the protocol layer.
  - `RecoveryReceipt` does recompute and compare the digest, so the pin is real.
  - The SQL-level limitation is stated in prose but not demonstrated by a test. That is acceptable (P3-1).
- **Round-4 P1-2 (replay vs conflict): closed.**
  - The test shows a same-PK, different-`input_digest` insert gets the same generic abort as a replay, and it reads back the stored `input_digest`.
  - The doc makes the host-side `recoveryRequestInputDigest` lookup mandatory.
- **P2-1:** closed. The doc states `applied_observed` over `abandoned_unknown` needs an existing exact completion row.
- **P2-2:** closed. The rollback cases are renamed "in-memory".
- **P2-3 (untracked state files): partially closed.** The `ls-files --others` check was added, but it has a fail-open defect (P2-1 below).
- **P2-4:** confirmed as intended pins.

## P2

**P2-1. The `freeze.mjs` git guards fail open when the working directory is not the repo root.**
- **Path:** `packages/core/fixtures/operator-recovery/freeze.mjs`, the `git diff --exit-code base -- packages/core/src/state/ ...` and `git ls-files --others ... -- packages/core/src/state/ ...` calls.
- **Counterexample:**
  - Run `node ../../fixtures/operator-recovery/freeze.mjs <sha>` from `packages/core`.
  - The pathspecs resolve relative to the cwd, to `packages/core/packages/core/src/state/`, which does not exist.
  - Git does not error on a non-matching pathspec, so the diff exits 0 and the untracked list is empty.
  - A modified `migrations.ts` or an untracked DDL helper then passes.
  - `pnpm --filter ... tsc -b --force` works from any workspace directory, so the script keeps running and regenerates a manifest from a divergent state source.
- **Impact:** The doc and dispositions describe these as base-lineage guards.
- **Minimal fix:**
  - Resolve the root with `git rev-parse --show-toplevel` and pass `{cwd: root}` to every git call.
  - Alternatively use top-anchored pathspecs: `:(top)packages/core/src/state/`.
  - Either way, assert the resolved root contains `packages/core/src/state`, so a vacuous match throws.

**P2-2. The illustrative persist helper pins `candidate_sha` to the base commit.**
- **Path:** `operator-recovery-spec.test.ts`, `joins host-loaded proofs...`.
- **What the test does:** It builds `candidate_sha:spec.base_commit` and rejects any receipt whose `candidate_sha !== spec.base_commit`.
- **Contradiction:**
  - The doc says J12 binds the *qualified candidate commit* and the "exact pinned MigrationSpec and qualified candidate SHA".
  - `base_commit` is main `69859eec`, the base the fixture is frozen against, not the PR or candidate head.
- **Counterexample:** A correct J12 receipt carrying the candidate head SHA would be rejected by the helper as `MIGRATION_SPEC_MISMATCH`.
- **Impact:** A J12 implementer copying this helper would pin the wrong identity. The comment calls it illustrative, but this assertion encodes a false equivalence and the manifest has no candidate-SHA field.
- **Minimal fix:**
  - Drop `candidate_sha` from the manifest-equality list and replace it with a comment saying J12 compares it to the authenticated build's commit.
  - Or take the candidate SHA as an explicit input to `persist` and assert it is a valid GitId, not that it equals `base_commit`.
  - Keep the `candidate_sha:'f'...` negative only if it is tested against that input.

## P3

- **P3-1. No test pins the SQL-level forged-digest limitation.** Add one assertion that SQL itself accepts a second terminal row under a different 64-hex digest with the same `subject_json` (`prior_revision=0`). That proves the host recompute is load-bearing. The doc covers it in prose only.
- **P3-2. `ls-files --others --exclude-standard` skips gitignored files.** A gitignored `.ts` under `state/` would not be flagged. Add `--ignored` or fail on any non-tracked file there, if cheap.
- **P3-3. `legacy_unknown` + `abandoned_unknown` is SQL-allowed for `preserve_unknown`.** This is consistent with the protocol's `UNKNOWN_CANNOT_RESOLVE` and needs no action.

## Confirmed, no action
- **Envelope joins:** `verifyRecoveryProofEnvelopes` checks all six context fields, `PROOF_AFTER_RECEIPT`, one-to-one refs, canonical proof content and the subject digest.
  - The test enumerates the six field mismatches plus missing and duplicate refs.
  - It also covers a wrong-kind decode, a rebound subject, and a spec-field mismatch before any INSERT.
  - The zero-row assertion before the final successful persist is correct.
- **SQL guards:** BEFORE INSERT duplicate and revision guards cover IGNORE, REPLACE and upsert. UPDATE and DELETE are blocked. Terminal sealing is keyed on digest and tested.
- **40-combination test:** The enumeration is consistent with the CHECK predicate: reserved only with `preserve_unknown` or `proven_not_started`+`none`, committed excludes `proven_not_started`, and legacy allows only `preserve_unknown`. The test is scoped to Attention subjects and does not claim proof validity.
- **Doc scope statements:** J12, WAL, trusted auth and current generations are deferred, with no registered migration. Future storage templates are separated from `schema_spec_digest`, and the doc states there is no active-pointer CAS trigger. I found no false PASS claim.
- **Python vector script:** The `--check` path is independent, and the recovery-root checks cover the raw DDL, fixture and future-storage hashes. The frozen vector input must equal `manifest.spec`.
- **Contract compatibility:** The `JointContract` union and `decodeJointContractAs` kind guard are unchanged and consistent with the receipt/request/envelope kinds used by the tests.

## Net
There is no unsafe behavior in this producer/spec slice. The remaining items are the freeze guard that passes vacuously from a non-root cwd (P2-1) and the illustrative helper that conflates base and candidate SHA (P2-2). Both are small, local fixes. After them I expect PASS, and host validation remains separate.
END_AUDIT