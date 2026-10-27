# Adversarial review: JP-17a broker recovery storage candidate (CODE c454c0d)

**Limits.** I had no tools and ran nothing. I recomputed no hashes and did not see the BASE..CODE diff, `joint-json.ts` or `joint-primitives.ts`. SQLite behaviour is taken from documented semantics, not from a run. Line numbers are counted from the supplied text and may be off by ±1.

## Prior blockers, re-evaluated

- **P0-1 (REPLACE evicting a held orphan): fixed.**
  - `schema.sql:40` adds `EXISTS(... broker_id=NEW.broker_id AND resource_key=NEW.resource_key AND state='held_orphan')` to the `BEFORE INSERT` guard, so it fires before REPLACE resolution.
  - A REPLACE can only collide on three things. The `lease_id` PK and `UNIQUE(broker_id,lease_id)` are caught by `schema.sql:39`. The partial unique index is caught by `:40`. A resolved lease can therefore never be evicted, and a held one cannot either.
  - I found no remaining REPLACE path on `broker_leases`.
- **P1-1, P1-4, P1-5, P2-1, P2-6: acceptable as dispositioned.**
- **P1-2: only partly closed.** Requiring `SqliteError`/`SQLITE_CONSTRAINT*` and building args before the thunk removes the vacuous-pass problem. The mutation-kill concern is still open for non-redundant controls (see P1-A below).
- **P1-3 (SQL is not protocol-parity): accepted as a deferred host boundary.**
  - Doc item 3 states the boundary explicitly.
  - Residual: SQL cross-field comparisons use SQLite affinity coercion and first/last duplicate-key semantics that differ from `JSON.parse`. The doc covers this by requiring `canonicalJointJson` output from the host.

## P0

None confirmed.

## P1 (blocking)

**P1-A. The SQL controls that gate slot release are mostly unexercised. About 20 non-redundant conjuncts can be deleted with all 26 tests still green.**

This is an evidence gap against a stated guarantee. Doc § "Minimal persistence boundary" says SQL rejects "cross-tuple decisions, missing/mismatched stop proof structure". I found no code defect. The suite just does not demonstrate those guarantees.

The CHECKs and the lease/identity insert guards are the only SQL gate on these properties. No other control backs them up. `broker_recovery_insert_guard` checks only generation, revision, state and home/scope/tenant (`schema.sql:95-102`).

Surviving mutants, with the test that would need to kill each:

- **Receipt CHECK (`schema.sql:60-77`).** Only `prior_phase`, `subject.broker_id`, `subject.lease_id`, `actual_target_schema` and the `proof_refs` array type (via the OR IGNORE probe) are tested. These have no killing test:
  - `kind`, `schema_version`, `target`, `prior_resolution`, `subject.kind`.
  - `subject.home_id = target_home_id`. The `home` case sets both to `'other'`, so only guard clause 3 fires.
  - `if_revision = prior_revision`.
  - `receipt.owner_generation = owner_generation`. The `owner` case mutates both consistently, so only guard clause 2 fires.
  - `$.decision = decision`. This is the sharpest one. The projection is driven by the **column**, and CHECK 2 branches on the column. A receipt whose JSON says `preserve_unknown` but carries a valid proof, stored under column `proven_stopped`, is stopped only by `schema.sql:74`.
  - `$.request_id = request_id`.
  - `$.operator_ref = principal_ref`. This is the forged-principal path.
  - `proofs` array type.
- **Stop-proof CHECK (`schema.sql:78-93`).** Only `missing-proof` and `wrong-proof-generation` are tested. These have no killing test:
  - Proof `type`.
  - `record_ref` non-blank and `record_ref = proof_refs[0]`.
  - `proofs[0].subject_digest = subject_digest`.
  - `evidence_digest` length and hex.
  - `producer_ref` non-blank.
  - `broker_identity.broker_id` and `broker_identity.lease_id`.
  - `broker_identity.schema`.
  - A `preserve_unknown` receipt that carries a proof.
- **`broker_lease_insert_guard` (`schema.sql:41-42`).** A direct `INSERT` with `state='resolved_stopped'` or `recovery_revision>0` would forge a terminal or advanced lease with no decision chain. The same guard rejects `grant_generation > owner_generation` and an unknown `broker_id`. None of these is tested. The only lease probes are the clone insert and the two REPLACE forms.
- **`broker_identity_insert_guard` (`schema.sql:11-13`).** No test inserts a second identity, with or without `OR REPLACE`/`REPLACE`/upsert. This is the highest-impact REPLACE target after leases, and an FK-OFF connection is not protected by the FK.

Minimal fix (test-only, no SQL byte change, so no refreeze):
1. Take a valid `proven_stopped` receipt and generate one case per JSON path in the two CHECKs by deleting it, retyping it (number for text, string for integer) and setting a wrong value.
2. Add column-vs-JSON desync cases for `decision`, `request_id`, `principal_ref`, `prior_revision` and `owner_generation`, with a self-consistent forged column set.
3. For each case, assert `SQLITE_CONSTRAINT*`, an unchanged lease row and no decision row.
4. Add the lease and identity insert cases listed above, plus the lease `ON CONFLICT DO NOTHING/UPDATE` and `REPLACE` forms using an existing `lease_id`, under `foreign_keys` ON and OFF.
5. Add a scripted mutation-kill step: delete each CHECK conjunct and each trigger clause from a copy of the DDL, and require at least one test to fail per deletion. Failing that, drop the "SQL rejects … mismatched stop proof structure" claim down to what is tested.

## P2 (non-blocking, should fix)

1. **`PRAGMA ignore_check_constraints=ON` bypasses the whole proof gate.**
   - Triggers survive that pragma, but CHECKs do not. A `proven_stopped` decision with empty proofs would then insert and release the slot.
   - The "arbitrary SQL" disclaimer covers this. But the doc's host checklist lists neither this pragma nor `trusted_schema`.
   - Fix: add per-connection pragma verification at open to host item 1. Optionally add a test that documents which controls survive the pragma.
2. **`schema_change_id` was not bumped.** The SQL bytes changed after the earlier review but the change ID is still `…-candidate-v1`. `ddl_digest` and `schema_spec_digest` do change, so identity is distinct, but earlier evidence naming v1 is now ambiguous. Bump it, or state in the doc that v1 was re-frozen.
3. **`prior_resolution` is unbound.** The test's own revision-1 receipt carries `prior_resolution:'none'` after a stored `preserve_unknown`, and SQL accepts either value at any revision. Either derive it or document it as host-only.
4. **Digest-catalog drift.**
   - `digest-catalog.json`'s `schema_spec_digest` prose omits `source_schema_digest` and `target_schema_digest`, which `schemaSpecDigest` and `freeze.py` both include.
   - Neither field is registered in the catalog. They are bare SHA-256 over canonical `sqlite_master` rows, defined only by this candidate's own code.
   - The claim that they "match the existing home contract" cannot be checked from the bundle.
5. **SQLite version.**
   - Neither the test nor `freeze.py --check` records the engine version. `freeze.py` asserts only `>= 3.37` for Python.
   - The doc's "tests record actual Python and better-sqlite3 versions in validation evidence" is not backed by anything in the bundle.
   - `json_valid` strictness and JSON5 acceptance vary by version.
6. **Independence wording.**
   - The `describe` title "independent broker storage candidate" conflicts with the doc's own "not an independent-author oracle".
   - "An independent agent froze its oracle before receiving the candidate" is unverifiable offline: `candidate_created_at_ms` is null.
   - `identity_independence_certified:false` is the honest field; align the prose to it.
7. **Frozen-oracle generation criterion** (null/missing/fractional/oversize generations). It is exercised only on `UPDATE broker_identity`. `grant_generation` and the decision's `owner_generation` are untested.
8. **Doc/test claims worth tightening.**
   - The doc says the OR IGNORE probe shows "zero changes … never success". The probe does show that, but only for one CHECK shape.
   - `tests record versions` (item 5) is the only claim the bundle cannot support at all.
9. **Prior P2-3, P2-5, P2-7, P2-8, P2-9, P2-11 and P2-12 limitations stand as declared.** They are documented deferrals, and I do not escalate them.

## Assessments requested

- **Deferred boundaries.** Honest. `deployment_qualified:false`, `allocation:not_reserved`, the `not_run` entries, the in-memory-only statement and the host checklist are consistent with each other and with `execution-gates.json`. The exceptions are P2-5 and P2-6 above.
- **Separate DB / unreserved 0→1 vs deployed broker and home48.** Adequately distinguished by namespace CHECK, `schema_change_id`, the catalog digest, `allocation` and `actual_deployment_path:null`. The empty-source/version-0 ambiguity (no `application_id`) is disclosed and left to the deployment freeze. I accept that.
- **Python freeze freshness.** It detects stale `catalog.json`/`manifest.json` byte-exactly. Both oracle digests are hard-coded, so consistency with the oracle file is by construction, not independent.
- **Manifest identity.** It is fully derived from `freeze.py` constants and is not self-hashed. `manifest.paths` is not enforced here. The doc defers binding to the audited SHA, which is acceptable for a spec-only PR.
- **Unsafe mutation paths I probed and found closed:**
  - `INSERT OR REPLACE`/`REPLACE`/upsert on leases, decisions and identity.
  - Lease deletion, and direct `UPDATE` release (the update guard requires a decision at `OLD.recovery_revision`, which no longer exists after projection).
  - Obsolete-generation decisions.
  - Skipped revisions.
  - Append after terminal.
  - `changes()` CAS inside the trigger.
- **Test results.** 26 passing tests plus typecheck and Biome show the happy path and the listed negatives work. They do not show the release-gating CHECK controls work (P1-A).

VERDICT: REVISE
END_AUDIT