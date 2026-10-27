BEGIN_AUDIT

**Verdict: REVISE**

This is a static read of the pasted text only. I executed nothing, and none of it is runtime qualification. I found no P0 and no P1 under the stated scope (J11 is an isolated spec, and J12 trusted-state validation is deferred). I found several P2 gaps where the "required join" the spec illustrates is weaker than the doc claims, plus cheap SQL defense-in-depth that schema 47 already makes possible.

I checked these and found no defect:
- The insert guard is correct for revision sequencing, terminal sealing, and OR IGNORE/REPLACE/upsert bypass. It is a BEFORE INSERT trigger, so it fires before conflict resolution.
- `IS 1` makes NULL JSON paths fail closed.
- The 40-cell predicate matches `RecoveryReceipt` for Attention subjects.
- `verifyRecoveryProofEnvelopes` compares all six context fields. It also checks one-to-one refs, content equality via canonical JSON, subject digest, and observed-at ≤ receipt.
- The Python vectors recompute `schemaSpecDigest` independently and use `SystemExit`, so they survive `-O`.
- The catalog digest canonicalization is consistent between JS and Python for ASCII keys.

---

**P2-1: The ledger insert is not bound to the live owner or home, though `daemon_owner` exists in schema 47**
- Path: `packages/core/fixtures/operator-recovery/bootstrap.sql` (`operator_recovery_insert_guard`, receipt CHECK)
- Counterexample: on an empty DB, or on `fixture()` (`daemon_owner` = `fixture-home`/gen 1), insert a receipt with `owner_generation=999` and `target_home_id='other-home'`. Both internal equalities hold, so it commits. A stale or already-open old writer with a cached generation can append a decision row the same way. The doc admits version checks cannot fence an existing connection, but SQL could turn this race into an abort.
- Fix: add to the guard `OR NEW.owner_generation <> (SELECT generation FROM daemon_owner WHERE singleton=1) OR json_extract(NEW.receipt_json,'$.target_home_id') <> (SELECT home_id FROM daemon_owner)`. Do the same for `operator_upgrade_journal.owner_generation`. Seed `daemon_owner` in the tests that currently run `ddl` on an empty DB. Re-freeze. Keep the host check authoritative.

**P2-2: Subject identity is not tied to source rows, so the terminal seal is per-digest only**
- Path: `bootstrap.sql` (guard seals by `subject_digest`)
- Counterexample: the Attention action `action` exists with mission `mission` and message `msg`. Insert `proven_stopped` for subject `{attention_action, mission_id:'mission', action_id:'action', message_id:'msg'}`. Then insert `applied_observed` for `{..., mission_id:'bogus', action_id:'action', message_id:'msg'}`. That has a different digest, a fresh chain at revision 0, and an unsealed history. SQL accepts both, so two contradictory terminal decisions exist for one action. The doc defers this to J12 "re-read subject facts", but the ledger has no natural-key uniqueness to catch a host bug.
- Fix: for `subject.kind='attention_action'`, require in the guard `EXISTS(SELECT 1 FROM attention_dispatch_phases WHERE action_id=json_extract(NEW.subject_json,'$.action_id') AND message_id=… AND mission_id=…)`. Effect subjects have no table in schema 47, so leave them to J12. Add a negative test with the bogus mission_id.

**P2-3: The J12 join test omits the receipt↔manifest binding it claims to illustrate**
- Path: `packages/core/src/state/operator-recovery-spec.test.ts` (`joins host-loaded proofs…`); `packages/protocol/src/joint-recovery.ts` (`verifyRecoveryProofEnvelopes`)
- Counterexample: the test sets only `schema_spec_digest` from the manifest. The receipt keeps the base fixture's `ddl_digest='aaa…'`, `fixture_digest='bbb…'`, `actual_target_schema=48`, and `candidate_sha`, none of which match `manifest.spec`. The helper and the SQL both accept and persist it. A reader would take this as the canonical required join.
- Fix: in `persist`, assert `receipt.ddl_digest===spec.ddl_digest`, `fixture_digest===spec.fixture_digest`, and `actual_target_schema===spec.target_schema`. Build the receipt from the manifest and add one negative case per field. Optionally take a `{ migrationSpec }` parameter in the helper. Also list these three fields in the J12 acceptance obligations; the doc names only the six envelope fields.

**P2-4: The "mutant" test is vacuous with respect to the bootstrap**
- Path: `operator-recovery-spec.test.ts` (`detects a bootstrap mutant that changes original state`)
- Counterexample: it runs `ddl` and then an arbitrary DROP/DELETE/UPDATE, and asserts the state differs from before. That holds for any DDL, including an empty file. It tests the comparison helper, not that `bootstrap.sql` leaves original state alone. The real protection is the first test's `legacy(db)` and catalog equality.
- Fix: delete it, or rename it to "comparison oracle detects mutation". Better, add a real mutant: append `UPDATE attention_actions SET state='x'` to the ddl text, run the first test's equality, and assert it fails.

**P3-1: The doc claims bootstrap creates indexes and requires an allowed-statement manifest, but neither exists**
- Path: `docs/design/operator-recovery-schema.md` (storage section and algorithm step 4); `bootstrap.sql`
- Counterexample: `bootstrap.sql` has no `CREATE INDEX`. Only PK/UNIQUE autoindexes exist, and the catalog excludes `sqlite_%`. The "closed allowed-statement manifest" appears in no fixture or manifest key.
- Fix: say "tables and triggers; indexes are implicit via PK/UNIQUE". Mark the statement manifest as a J12 deliverable, or pin it in `manifest.json` as an ordered list of statement hashes.

**P3-2: Replacement resistance is tested only with recursive triggers OFF**
- Path: `operator-recovery-spec.test.ts`
- Counterexample: with `PRAGMA recursive_triggers=ON`, REPLACE would fire delete triggers. The BEFORE INSERT abort should still win first, but the dispositions claim coverage and no test sets the pragma ON.
- Fix: parameterize the replace/ignore/upsert loops over `recursive_triggers` ∈ {OFF, ON}.

**P3-3: A ledger chain can regress phase in SQL**
- Path: `bootstrap.sql`
- Counterexample: rev0 `preserve_unknown` with `prior_phase='dispatch_committed'`, then rev1 `preserve_unknown` with `prior_phase='reserved'` and `prior_resolution='none'`. Both are accepted. The row-level continuity argument (reserved→committed is legitimate) is fair, but committed→reserved is never legitimate: `attention_dispatch_no_rewind` forbids it in schema 47.
- Fix: optional, with a re-freeze. Reject a `reserved` NEW row if any prior row for that subject has `dispatch_committed`. Otherwise keep it as a J12 obligation, which the doc already states.

**P3-4: The upgrade journal permits parallel operations and is not bound to the recovery ledger**
- Path: `bootstrap.sql` (`operator_upgrade_insert_guard`)
- Counterexample: two different `operation_id`s both reach `installed_inactive` for the same `schema_spec_digest` and owner generation. Neither references any ledger revision.
- Fix: either a partial unique index `ON operator_upgrade_journal(schema_spec_digest) WHERE state IN ('fenced','verified','installed_inactive')`, or a J12 obligation that "at most one non-failed operation exists" with a test.

**P3-5: The freeze helper's provenance check is narrower than the schema surface**
- Path: `packages/core/fixtures/operator-recovery/freeze.mjs`
- Counterexample: the `git diff` is scoped to `packages/core/src/state/`. Schema-affecting code outside that directory (for example a module that lazily ensures tables such as `follow_up_*`) is not checked against the base. Separately, `tsc -b --force` rebuilds core but not `@osstack/protocol`. A stale protocol `dist` would feed a wrong `schemaSpecDigest` into the manifest.
- Mitigation already present: the spec test's catalog equality and the Python `--check` would catch drift afterward.
- Fix: also `git diff` any directory that defines tables. Build protocol with `--force` in the helper, or assert the protocol dist mtime/hash.

**P3-6: Wording and doc consistency**
- Path: `docs/implementation/joint-recovery-retarget/audit-dispositions.md`; `docs/design/operator-recovery-schema.md`
- Issues: item 5 says "tested with recursive triggers OFF", which is only the default and not a deliberate test. The bootstrap section says "Candidate source: main 69859eec", but nothing in the tests binds the checkout to that SHA. Only the string literal and the catalog match are checked. State that explicitly, so it is not read as provenance.

---

**Not findings, because they are explicitly deferred or out of scope:**
- Authentic proof and producer authentication.
- Current-generation CAS.
- WAL/FULL process-kill tests.
- Active-pointer and goal phase monotonicity triggers.
- Broker ledger.

The deferrals are stated consistently in the doc, in the test comments, and in the dispositions, and nothing in J11 claims runtime recovery.

**Minimal path to PASS:** fix P2-3 and P2-4 (test-only, no re-freeze). For P2-1 and P2-2, either adopt the guards and re-freeze the manifest, schema vector, and Python input, or record in the doc why the host-only enforcement is intentional. Apply the P3 doc corrections.

END_AUDIT