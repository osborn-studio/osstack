# Adversarial review: JP-17a broker recovery storage candidate (CODE 812080a)

**Limits.** I had no tools and executed nothing. SQLite behaviour is taken from its documented semantics, not from a run. Line numbers are counted from the supplied text and may be off by ±1. I did not see the BASE..CODE diff or the recorded SQLite 3.53.1 evidence.

## Host dispositions

- **P0-1:** Accepted for a new `lease_id` reusing a held resource key. The existing-`lease_id` REPLACE path is untested (P1-1a).
- **P1-1, P1-4, P1-5, P2-1, P2-6, P2-7, P2-8, P2-9, P2-11, P2-12:** Accepted as dispositioned.
- **P1-2:** Accepted. The 25 mutants do show non-redundancy, since the candidate rejects and the one-predicate mutant admits. Coverage of the conjuncts is incomplete (P1-1).
- **P1-3:** Accepted as a host boundary. The integer `json_type` conjuncts that do exist are unmutated (P1-1c).
- **P2-2:** Partly challenged. The sentence "tests record actual Python and better-sqlite3 SQLite versions" is still in the doc's host checks. Nothing in the test or `freeze.py` records a version, and the 3.53.1 evidence is not in the bundle (P2-1).
- **P2-3:** Accepted as disclosed.
- **P2-4:** Accepted for the code. The shared registry prose is stale (P2-5).
- **P2-10:** Overstated. The test cross-checks only two gate `requires` lists (P2-2).

## P0

None confirmed. I found no SQL path that releases or rewrites a lease or decision outside the guarded flows. That covers REPLACE, upsert, DELETE, direct UPDATE and takeover.

## P1 (blocking)

**P1-1. Three non-redundant guard conjuncts have no killing test.** This is test-only, so the fix needs no SQL change and no refreeze. The stated guarantee is the doc's "SQL rejects … history mutation and replacement" and "no … lease-row deletion". The second review asked for per-path cases, and these three remain unkilled.

**(a) `broker_lease_insert_guard` clause `EXISTS(… lease_id=NEW.lease_id)` (`schema.sql:39`).**
- It is the only control against `INSERT OR REPLACE` / `REPLACE` on `broker_leases` that reuses an existing `lease_id` with a different `resource_key`.
  - Clause `:40` checks only held orphans on the new key, so it does not fire.
  - Without `:39`, REPLACE would resolve the PK conflict by deleting the old row.
  - With `recursive_triggers=OFF`, no DELETE trigger fires.
  - The decisions FK is not independent protection, because the replacement row carries the same `(broker_id, lease_id)` key. I am reasoning from the documented FK semantics here, not from a run.
- For a `resolved_stopped` lease, `:40` also passes even on the same key. A fresh `held_orphan`/revision-0 row could therefore reopen a sealed lease.
- Removing `:39` leaves all 76 tests green.
  - Every lease-insert test uses a fresh id (`lease-b`, `new-lease`).
  - No test reuses `lease-a` as the new id.
  - There is no lease `ON CONFLICT DO NOTHING/UPDATE` test at all.
  - The 43 added tests (25+4+8+4+2) contain none of the existing-id lease cases the second review asked for.

**(b) Stop-branch cardinality (`schema.sql` ≈:78-79): `json_array_length(…'$.proofs')=1 AND json_array_length(…'$.proof_refs')=1`.**
- Cardinality is varied only on `preserve_unknown` receipts (`proofs-nonempty`, `refs-nonempty`).
- No `proven_stopped` receipt carries two proofs or two refs. Dropping either conjunct would still admit the row.
- The protocol parser rejects both shapes, but the SQL claims proof structure.

**(c) Six `json_type(…)='integer'` conjuncts in the receipt CHECK (≈`schema.sql:61-77`).** They cover `schema_version`, `if_revision`, `owner_generation`, `actual_target_schema`, `proofs[0].broker_identity.schema` and `.owner_generation`.
- All 25 cases are value-only wrong values, so none can kill these conjuncts.
- `"if_revision":"0"` and `"owner_generation":"2"` compare equal to the INTEGER columns through NUMERIC affinity coercion.
- `1.0` equals the literal `1` in the three literal-compared fields.
- Dropping a conjunct admits these shapes and releases the slot.

**Minimal fix (tests only):**
1. Existing-id lease cases:
   - Run `INSERT`, `INSERT OR IGNORE`, `INSERT OR REPLACE` and `REPLACE` with `lease-a` as the new id and `resource_key='other-resource'`.
   - Run each with the lease both `held_orphan` and `resolved_stopped`.
   - Add `ON CONFLICT DO NOTHING` and `ON CONFLICT(lease_id) DO UPDATE`.
   - Run all of these with `foreign_keys` ON and OFF.
   - Assert `sqlReject` and an unchanged row.
2. Mutant entries in the existing pattern, each admitted on the mutant and rejected on the candidate:
   - Drop the `:39` clause and run the REPLACE case.
   - Drop each of the two stop-branch cardinality conjuncts and use a receipt with two proofs, and one with two refs.
   - Drop each of the six `json_type` conjuncts. Use string-typed `"0"`/`"2"` for the two column-compared fields. For the other three, use raw-text `1.0` via string replacement of the serialized JSON, since `JSON.stringify` cannot emit it.

## P2 (should fix, not blocking)

1. **Doc/evidence mismatch on SQLite versions.**
   - The doc's host-checks sentence says the tests record versions, but no test or script does.
   - Fix: delete the sentence, or assert `sqlite_version()` ≥ 3.37 in the test.
2. **`manifest.dependencies.runtime_storage_requires` understates `J17.scoped`.**
   - The manifest lists `["J17.recovery"]`. `execution-gates.json` has `J17.scoped` requiring `J14.scoped`, `J12.scoped` and `J17.recovery`.
   - The test cross-checks only `J17.schema_spec` and `J17.recovery`.
   - Fix: set it from the gate and add an assertion.
3. **Host checklist gap.**
   - Doc item 3 does not require comparing the receipt's `schema_spec_digest`, `ddl_digest`, `fixture_digest`, `candidate_sha` and `recovery_build_digest` to the pinned tuple and running build.
   - `RecoveryReceipt.parse` and `verifyRecoveryProofEnvelopes` only check that the envelope and receipt agree with each other.
   - `J17.recovery.identity_fields` lists these fields, and the operator doc requires the comparison.
   - Fix: add the sentence to item 3.
4. **Unverifiable chronology wording.**
   - The doc says an independent agent "froze its oracle before receiving the candidate".
   - The oracle's `candidate_created_at_ms` is null and `identity_independence_certified` is false.
   - Fix: reword as "reported" or remove.
5. **Stale shared registry.**
   - `digest-catalog.json` `schema_spec_digest` prose omits `source_schema_digest` and `target_schema_digest`. `schemaSpecDigest` and `freeze.py` both include them.
   - The registry calls itself the sole registration, so the parent should fix it. The broker doc's "registered" statement matches the code, not the registry.
6. **Frozen oracle criterion "null/missing generations".**
   - It is not exercised on a decision's `owner_generation` or a lease's `grant_generation`.
   - The rejection there rests on NOT NULL. The identity update guard's WHEN evaluates to NULL for a NULL new value and does not fire.
   - Fix: add cases or state the criterion is only partly exercised.
7. **Masked guard conjuncts.**
   - The identity `broker_id` immutability test (`UPDATE … SET broker_id='other',owner_generation=3`) is also rejected by the leases FK under FK ON.
   - The lease update guard's immutable-field conjuncts are masked by the trailing NOT EXISTS conjunct. Any external UPDATE fails, because no decision exists at the post-projection revision.
   - Fix: add an FK-OFF run, or document these as defence-in-depth.

## Nonblocking limitations (stand as declared)

- `broker_identity` keeps only the current owner, so past ownership cannot be reconstructed.
- There is no `application_id`, so an empty version-0 file is ambiguous.
- SQL is a defensive subset of the protocol. Affinity coercion, duplicate-key semantics, padded identifiers and unbound `subject_digest` and `input_digest` all fall to the host.
- `ignore_check_constraints=ON` bypasses the proof gate. The doc covers it.
- There are no file-backed, WAL, crash, multi-connection or replay tests.
- Proof envelopes are not pinned.
- There is no correction path for a wrong `resolved_stopped`.
- The `manifest.paths` diff binding and the oracle result binding are deferred.

## Assessments requested

- **Deferred boundaries:** Honest, except P2-1, P2-3 and P2-4. `deployment_qualified=false`, `allocation=not_reserved`, the `not_run` entries and the in-memory-only statement are consistent.
- **Separate database and unreserved 0→1 candidate vs deployed broker and home48:** Adequately distinguished by the namespace CHECK, `schema_change_id`, manifest flags and `actual_deployment_path:null`. The data-level discriminator is thin and disclosed. The absent-table assertion is a weak negative.
- **Python freeze:** Byte-exact. It reproduces catalog, manifest and schema-spec digest with an independent engine, and it hard-asserts the oracle hash. It does not hash the doc, the test or `.gitattributes`, and `paths` is not enforced. It proves freshness, not qualification.
- **Previous P1-A:** Substantially closed.
  - The receipt predicates, stop-proof fields, new-lease guard cases and identity insert strategies are covered.
  - The surviving unkilled conjuncts are P1-1 (a)–(c).
  - No mutation exhaustiveness is claimed.

VERDICT: REVISE
END_AUDIT