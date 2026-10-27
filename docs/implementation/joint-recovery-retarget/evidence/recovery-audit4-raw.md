BEGIN_AUDIT
Verdict: REVISE (minor; no P0). Static review only. Nothing was executed, and model review is not runtime qualification. The Draft/in-progress status is correctly marked and I do not count it against the PR.

Scope: J11 SQL and verification specification only. J12 runtime, WAL/crash tests, trusted auth and provider qualification are explicitly deferred and are not findings.

## P1

**P1-1. Terminal sealing is not keyed to the per-subject chain, and the matrix does not require it.**
Path: `packages/core/fixtures/operator-recovery/bootstrap.sql`, `operator_recovery_insert_guard`.
The guard seals on `EXISTS(... subject_digest=NEW.subject_digest AND decision<>'preserve_unknown')`. That is correct for the same digest. But `subject_digest` is caller-supplied, and the receipt-equality CHECK only ties it to `$.subject_digest` inside the same receipt. It is never recomputed from `subject_json`.
Counterexample: after a terminal `proven_stopped` row for subject S, insert a row with the same `subject_json` but a different 64-hex `subject_digest` and `prior_revision=0`. The guard sees no prior chain and the CHECK passes, so a contradictory second terminal decision lands. The doc says SQL "is not a complete protocol validator" and that `verifyRecoveryProofEnvelopes` recomputes the digest. Even so, the sealing guarantee advertised in the doc ("a terminal decision seals this subject chain") is weaker than stated at the SQL layer.
Minimal fix, either one:
- Add a J12 acceptance bullet: "host recomputes `recoverySubjectDigest(subject_json)` and compares it with the row digest before INSERT", plus a negative test where the same subject carries a forged digest.
- Or add a second `UNIQUE`/guard on a canonical `subject_json` text column.

The first is sufficient for this slice. A short test pinning the limitation is better than silence.

**P1-2. The replay lookup order in the doc is not enforced or tested anywhere, including the illustrative join.**
Path: `docs/design/operator-recovery-schema.md` ("Within the current owner transaction, resolve `(principal, request_id)` first").
The test-local `persist` helper never performs the idempotency step. Its INSERT with the same `(principal,request_id)` and a different `input_digest` is rejected only by the PK trigger, which gives a generic abort with no idempotency-conflict versus replay distinction. That is correctly deferred. But the "40 combination" and "typed mismatch" tests never assert that `input_digest` participates in any decision.
Counterexample: the same PK with a different `input_digest` and an otherwise identical receipt throws the same error as an identical replay.
Minimal fix: add one assertion documenting that SQL cannot distinguish replay from conflict, so `recoveryRequestInputDigest` comparison is mandatory host logic. A single added line in the J12 obligations is enough. This is not a defect in the SQL itself.

## P2

**P2-1. The `prior_resolution` check allows `abandoned_unknown` with `dispatch_committed` and `proven_stopped`/`applied_observed`.**
Path: `bootstrap.sql` CHECK.
This is consistent with the doc ("CHECK deliberately allows stopped resolution from dispatch_committed"). The source fixture itself is committed plus `abandoned_unknown`. However, `applied_observed` on an abandoned-unknown row is accepted by SQL alone. The matrix says to project an existing completion, which is host-verified. That is acceptable as long as the doc states it. The doc says SQL is only a subset, so this is documentation clarity only.
Fix: one sentence in the J12 obligations: "applied_observed over abandoned_unknown requires an existing exact completion row."

**P2-2. The test `rolls back interruption` covers the SQL transaction only, and its names could be read as crash coverage.**
Path: `operator-recovery-spec.test.ts`, `it.each(['before_ddl','after_ddl','after_version'])`.
`db.pragma('user_version=48')` inside better-sqlite3's `db.transaction` is correct for rollback. In-memory databases do not exercise journaling. The doc already says this. Rename the cases to `…(in-memory rollback)` so a log reader does not mistake them for J12 crash tests.

**P2-3. `freeze.mjs` diff check is not hermetic to untracked or non-HEAD state.**
Path: `freeze.mjs`.
`git diff --exit-code base -- packages/core/src/state/` compares the working tree to the base commit. That is good for modified tracked files. Untracked new files under `state/` (a new `.ts` DDL helper, for example) are not detected by `git diff`.
Counterexample: an untracked `state/extra-migration.ts` that `migrations.ts`, itself unchanged, imports and registers would pass the check. The `tsc` build would then include it and the catalog could diverge from the base.
Minimal fix: also run `git status --porcelain --untracked-files=all -- packages/core/src/state/` and fail if it is non-empty (excluding tests). Alternatively, use `git ls-files --others --exclude-standard`.

**P2-4. The manifest `status`, `base_commit` and the test's hard-coded SHA are three separate pins.**
Path: `operator-recovery-spec.test.ts` (`toBe('69859eec…')`) and `manifest.json`.
This is intentional, since the rebase must re-freeze. A stale fixture fails loudly, which is the right behavior. No action beyond keeping the existing comment.

## P3

- **P3-1.** `joint-reference-vectors.py --check` verifies `frozen['input']==manifest['spec']`. Because freeze.mjs and Python both derive from the same manifest, an error in the shared `canon` could in principle pass both. The Python canon uses `ensure_ascii=False`, matching the TS ASCII-key restriction. Fine for now.
- **P3-2.** `operator_upgrade_insert_guard` for `revision=0` requires `state='fenced'` and no prior rows. It does not forbid `owner_generation` regression across different `operation_id`s. That is deferred to J12 serialization, and the doc says so.
- **P3-3.** `future-storage.sql` `trial_consumption_forward` permits `consumed→reconciled` directly, skipping `unknown`. The doc says the transitions are "consumed → unknown/reconciled → reconciled", so this is intended.
- **P3-4.** `.gitattributes` has no `future-storage.sql` -text rule beyond the `*.sql` glob. The glob covers it.

## Confirmed fixes and decisions (no action)

- The re-freeze on `69859eec` is consistent across manifest, vectors and test, and the schema digest vectors align.
- The envelope-context join checks all six fields and `PROOF_AFTER_RECEIPT`. The wrong-kind decode test is present.
- The `INSERT OR IGNORE`/`REPLACE`/upsert bypass is blocked by the BEFORE INSERT guard and tested.
- Broker receipts are rejected in the SQL CHECK, and the guard-removal mutants are pinned.
- Doc scope statements (J12 deferred, no migration registered, test-local persist is illustrative) match the code. I found no falsely claimed PASS.

## Net

No unsafe behavior exists inside this producer/spec scope that the doc fails to disclose, except the sealing-by-digest dependence in P1-1 and the `freeze.mjs` untracked-file gap in P2-3. Both need small, local fixes: a doc/test pin for P1-1 and P1-2, and one extra git check for P2-3. After those, I would expect PASS.
END_AUDIT