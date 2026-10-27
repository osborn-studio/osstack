BEGIN_AUDIT
Verdict: REVISE

Scope: static review of the supplied text only. Nothing was executed, and this is not runtime qualification. Out-of-scope items (J12 runtime, WAL/FULL crash tests, trusted auth, provider tests) are not counted as findings except where the J11 spec contradicts itself.

**P0 (blocks merge)**

1. `manifest.json` `base_commit` and the pins are stale against the retarget.
   - The manifest still says `base_commit: ce543535…`. The doc and README say the candidate is revalidated on main `69859eec…` (#273).
   - The doc states that "source version and full SQLite catalog must match the new base exactly before this pin can be reused".
   - `freeze.mjs` only writes `base_commit` from `git rev-parse origin/main`, so nothing in the PR proves a re-freeze happened on the new base.
   - Counterexample: if #273 changed any schema-47 DDL, `source_schema_digest` and `source_schema` in the manifest no longer match `runMigrations`. The spec test (`toEqual(manifest.source_schema)`) would fail; if it passes, the base_commit field is simply wrong.
   - Minimal fix: re-run the freeze on 69859eec, commit the regenerated manifest and `reference-vectors.json`, and add a test asserting `manifest.base_commit` equals the pinned candidate base. Otherwise drop the "revalidated" claim.

**P1 (must fix before relying on the spec)**

2. The terminal-seal trigger blocks `preserve_unknown` after terminal, but not terminal-after-terminal with a different decision at the same revision path.
   - `operator_recovery_insert_guard` forbids any insert when a non-preserve row exists for the subject. That is correct for sealing.
   - The guard does not check `post_state` against the receipt's `prior_phase`. SQL allows `proven_not_started` with `post_state='cancelled_before_dispatch'` on a subject whose receipt `prior_phase` is `dispatch_committed`. It also allows `applied_observed` on a broker subject (the broker subject kind is rejected only via the `IN ('effect','attention_action')` check).
   - Counterexample: an INSERT with `prior_phase='dispatch_committed'` and `decision='proven_not_started'` passes the SQL CHECKs. Only the TS `RecoveryReceipt` refinement rejects it.
   - The test-local `persist` does call the verifier first, but the SQL fixture is advertised as the executable storage spec.
   - Minimal fix: add `json_extract(receipt_json,'$.prior_phase')` and `prior_resolution` to the CHECK, with the same decision/phase matrix. Add a negative test per matrix cell.

3. The ledger `subject_json` check does not bind `home_id` to the serving home.
   - The CHECK only requires the subject kind to be `effect` or `attention_action`.
   - Counterexample: a receipt with `target='home'` and `subject.home_id='other-home'` is storable. `target_home_id` in the receipt is not checked against `subject.home_id` in SQL. It is checked only by the TS refinement.
   - The test named "kills removed ledger equality/home guards" probes broker/subject-kind but never `home_id` vs `target_home_id`.
   - Minimal fix: add `json_extract(receipt_json,'$.target_home_id')=json_extract(subject_json,'$.home_id')` to the CHECK. Add a probe and a mutant for it.

4. The upgrade journal does not bind evidence to the ledger.
   - `operator_upgrade_insert_guard` enforces transition order and an identical `owner_generation` and `schema_spec_digest` across rows. It does not require `verified`/`installed_inactive` rows to reference any recovery-ledger state.
   - Counterexample: `fenced → verified → installed_inactive` can be inserted with `evidence_json='{}'`. This contradicts the doc's claim that installation requires "every relevant hold accounted for".
   - The doc says the host enforces this. If so, the doc and test should say the SQL provides ordering only.
   - Minimal fix: state this explicitly in the doc, or require evidence keys (e.g. `json_type(evidence_json,'$.ledger_revisions')='array'`) for `verified` and `installed_inactive`.

5. Revision-fencing gap between the unique index and the trigger.
   - The trigger computes `MAX(prior_revision)+1` per `subject_digest`. The test's `receipt(3)` after revisions 0 and 1 expects 'revision conflict'.
   - `UNIQUE(subject_digest, prior_revision)` also exists. These agree, so this is fine. However, the trigger's `EXISTS(... principal_ref AND request_id)` clause is shadowed by the primary key, which makes it redundant. It is only reachable with `INSERT OR IGNORE`/`REPLACE`.
   - The tests do cover those forms. Low-risk, but note that `REPLACE` is blocked only because the BEFORE INSERT trigger fires first. This is correct but relies on trigger ordering. Document it.

**P2**

6. The idempotent-replay path is not representable in the ledger.
   - The doc says "Identical input returns the existing receipt".
   - `input_digest` is stored but has no unique constraint or lookup index keyed on `(principal_ref, request_id)` beyond the PK. That is sufficient for lookup.
   - The ledger cannot express a replay that arrives with a different `owner_generation`. The test never covers "same request_id, different input_digest → conflict" at the SQL level.
   - Minimal fix: add a test that selects by PK and compares `input_digest`, to pin the conflict contract.

7. Envelope-context test coverage covers six fields but one case is weak.
   - The `{binding_generation:17}` patch is accepted structurally and then rejected by the context comparison. Good.
   - There is no test that an envelope whose `subject` differs in `home_id` only is rejected (`PROOF_CONTENT_MISMATCH` via the subject digest). The protocol test covers a different `effect_id`.
   - Minimal fix: add a home_id variant.

8. `proven_stopped` on `attention_action` subjects.
   - The test fixture `valid-recovery-attention-subject` has `prior_phase` of presumably `legacy_unknown`. The test then overrides the decision and proof on a receipt whose prior_phase may not be `dispatch_committed`.
   - It parses today only because of the fixture contents, which I can't see. If the fixture is `legacy_unknown`, `RecoveryReceipt.parse` would reject `proven_stopped`.
   - Minimal fix: set `prior_phase:'dispatch_committed'` explicitly in the SQL-spec terminal test.

9. The doc claims "unknown finance stays reserved" and "release concurrency only", but no SQL or test covers accounting.
   - These are deferred to J12 per the PR scope. Label them explicitly as J12 obligations in the matrix table, not as persisted consequences of J11.

**P3**

10. `freeze.mjs` uses `origin/main` rather than the commit being validated. That is non-reproducible on a stale clone. Take the base as an explicit argument.
11. `.gitattributes` pins `*.sql` and `manifest.json` as `-text`, but `future-storage.sql` and the test fixtures are covered only by the glob. Confirm CRLF checkout is covered on Windows.
12. The README says "Claude CLI Sonnet 5.5 audit in progress". Model review is not qualification. Remove it from the validation-status wording, or label it advisory.
13. `joint_method_active` has no immutability or monotonic revision trigger. It is a template, but the doc says "active pointers update under a fenced transaction". Add a comment that this is deliberately unguarded.
14. In `engineering_goal_effects`, `cancelled_before_dispatch` requires `phase='reserved'`, but there is no CHECK linking `resolved_stopped` to `phase='dispatch_committed'` or `observed`. `applied_observed` with `phase='reserved'` is blocked, yet `resolved_stopped` with `phase='observed'` is allowed. Tighten, or document.

**Confirmed sound**

- Atomic DDL and version rollback tests at three boundaries.
- Original-row and catalog preservation checks, with mutant detection.
- Schema-spec digest excludes receipts and builds, so no circularity.
- `decodeJointContractAs` kind-mismatch handling.
- Broker proofs are bound to broker identity and generation.
- Legacy identity null-handling.

**Required before PASS:** fix 1 (re-freeze and pin the base), 2 and 3 (SQL-level phase and home binding with negative tests). Items 4 and 8 need either a code change or an explicit doc downgrade.
END_AUDIT