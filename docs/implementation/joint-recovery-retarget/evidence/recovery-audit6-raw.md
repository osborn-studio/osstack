BEGIN_AUDIT
**Verdict: PASS for this producer/spec slice. No P0, P1 or P2.**

This was a static read of the supplied text only. Nothing was executed, and none of it counts as runtime qualification. Pending host validation is correctly shown as Draft/in progress, and I found no false PASS or qualification claim. J12 WAL/crash tests, trusted auth, current generations and provider tests are explicitly deferred, and I did not count them as defects.

## Closure of round-5 findings

**P2-1, `freeze.mjs` git guards failing open from a non-root cwd: closed.**
- `repositoryRoot` is `realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)))`.
- From `packages/core/fixtures/operator-recovery/freeze.mjs`, four `../` steps resolve to the repo root.
- Every git call, including `merge-base`, `diff` and `ls-files`, plus both `pnpm tsc -b --force` calls, uses `{cwd: repositoryRoot}`.
- The script compares the resolved root against `git rev-parse --show-toplevel` and throws `WRONG_REPOSITORY_ROOT` on mismatch.
- The counterexample from running in `packages/core` no longer applies: pathspecs are repo-root-relative, and a wrong root fails loudly.
- `git ls-files --others` without `--exclude-standard` does list gitignored files. That matches the disposition's claim, so my earlier P3-2 is also addressed.
- `git diff --exit-code <base>` compares the working tree, staged changes included, against the explicit base. Modified, deleted and untracked non-test state sources all fail closed.

**P2-2, illustrative helper pinning `candidate_sha` to `base_commit`: closed.**
- `trustedCandidateSha = 'c'.repeat(40)` is a synthetic authenticated-build input, deliberately distinct from `manifest.base_commit`. The comment says so.
- `persist` no longer compares `candidate_sha` to `base_commit`.
- A receipt carrying a real candidate head is not rejected on the basis of the base SHA.
- The negative `{candidate_sha:'f'.repeat(40)}` now tests against that independent input.
- The MigrationSpec equality covers ddl, fixture, target schema and schema-spec digest, matching the dispositions.

**P3-1, no SQL-level forged-digest test: accepted as documented.**
- The doc states that terminal sealing is conditional on the host recomputing `recoverySubjectDigest`.
- The test pins the rejection at the verifier layer (`SUBJECT_MISMATCH`) before any INSERT.
- Asserting SQL accepts a forgery would not add safety to a spec fixture.

## Independent re-check of the whole slice

- **Manifest and vector coherence:**
  - The `schemaSpecDigest` vector input in `reference-vectors.json` matches `manifest.spec` field by field: both digests, both schema digests, and the 98-name table list including the two `operator_*` tables.
  - The expected digest `85bfa681…` matches `manifest.schema_spec_digest`.
  - The Python `--recovery-root` path recomputes the raw DDL, fixture, source and target catalog, and future-storage hashes independently. It also requires the frozen vector input to equal `manifest.spec`.
  - I did not recompute the SHA256 values by hand.
- **SQL guards:**
  - The BEFORE INSERT guard rejects a duplicate PK, a skipped or duplicate revision, and any insert after a non-`preserve_unknown` row for the same digest.
  - It fires before conflict resolution, so `OR IGNORE`, `OR REPLACE` and upsert are all blocked, and the tests cover these variants.
  - UPDATE and DELETE are blocked.
  - The phase/decision CHECK matches the 40-combination test's `allowed` predicate:
    - `reserved` allows `preserve_unknown`, or `proven_not_started` with resolution `none`.
    - `dispatch_committed` allows every decision except `proven_not_started`.
    - `legacy_unknown` allows only `preserve_unknown`, and requires an `attention_action` subject with null binding and profile.
  - The journal transitions are ordered and keep owner generation and spec digest constant. Their scope is correctly stated as ordering only.
- **Envelope and context joins:**
  - `verifyRecoveryProofEnvelopes` checks all six context fields, `PROOF_AFTER_RECEIPT`, one-to-one refs, canonical proof content, and the subject digest.
  - The test enumerates each and asserts zero rows before the successful persist.
  - The persisted receipt round-trips through `decodeJointContractAs('recovery_receipt', …)`.
  - A wrong-kind decode yields `JOINT_KIND_MISMATCH`.
  - The doc matches the code on the legacy rule: only Attention subjects with null identities and `preserve_unknown`.
- **Contract compatibility:** `JointContract` is unchanged and still contains `RecoveryRequest` and `RecoveryProofEnvelope`. The kind-guarded decoders match how the tests use them. No shape in `joint-shapes.ts` conflicts with the SQL column extraction (`target`, `target_home_id`, `prior_phase`, `prior_resolution`, and so on).
- **Replay semantics:**
  - The doc and test agree that SQL rejects a same-PK replay and a same-PK conflict identically, and that the stored `input_digest` is read back.
  - The host lookup is explicitly mandatory and is not inferred from error strings.
  - `applied_observed` over `abandoned_unknown` requires an existing exact completion, as the doc states.
- **Future storage templates:**
  - They are outside `schema_spec_digest`, pinned only by `future_storage_digest`, and covered by the Python check.
  - Composite FKs enforce the object kinds.
  - The doc discloses that there are no active-pointer CAS or goal-phase triggers.
  - `joint_method_active` is mutable by design, and the doc leaves its transitions to J08/J10/J13.

## Remaining items (P3, no change required to merge)

1. **P3, `freeze.mjs` base-diff scope is `packages/core/src/state/` only.** `runMigrations` could in principle import helpers from elsewhere in core or protocol. The Python `--check` and the catalog equality test independently catch any resulting digest or catalog drift, and the doc already says this is not a hermetic build attestation. Optional fix: also diff `packages/core/src` excluding tests, or record `git rev-parse HEAD^{tree}` of the built sources in the manifest.
2. **P3, the Python canonicalizer uses `ensure_ascii=False` with codepoint key ordering, while the TS canonicalizer sorts by UTF-16 code unit.** Today every key and catalog string is ASCII, so the digests agree. Optional guard: have the Python check assert `catalog` is ASCII-only so the two cannot diverge silently.
3. **P3, carry-over: no test shows SQL itself accepting a forged digest.** This is accepted as documented and needs no action.

## Net

Both round-5 P2 items are closed in the supplied files, and I found no new concrete unsafe behavior inside the J11 spec scope. The `--check` run, the full test suite and the host validation are still outstanding and remain separate gates. The PR should stay Draft until the host reports those results.
END_AUDIT