# Adversarial review: JP-17a broker recovery storage candidate

**Scope and limits.** I had no tools and executed nothing. Line numbers are counted from the supplied text and may be off by ±1. The BASE..CODE diff, `digest-catalog.json`, `execution-gates.json` and `independent/oracle-freeze.json` were not in the bundle. SQLite behaviour below is taken from its documented semantics, not from a run.

## P0 blockers

**P0-1. `INSERT OR REPLACE` / `REPLACE` on `broker_leases` deletes a held orphan without firing `broker_lease_no_delete`, and releases its slot.**
- Evidence: `schema.sql:37` (partial unique index `broker_one_held_resource`), `:38-42` (insert guard), `:43-44` (`no_delete` trigger).
- Why it works:
  - The insert guard only aborts on an existing `lease_id`, a non-initial state, or a stale generation. A new `lease_id` reusing `(broker_id, resource_key)` passes it.
  - REPLACE then resolves the unique-index conflict by deleting the existing row.
  - With `recursive_triggers=OFF` (which the test sets, `broker-recovery-spec.test.ts:17`), REPLACE-driven deletes do not fire DELETE triggers.
  - The FK from `broker_recovery_decisions` blocks the delete only if a decision row exists and `foreign_keys=ON`. For a fresh orphan, the exact fixture state, nothing blocks it.
- Predicted result: `INSERT OR REPLACE INTO broker_leases VALUES('lease-b','broker-fixture','home-b','scope-b','tenant-b','exclusive-resource-a','invocation-b',NULL,1,'held_orphan',0)` erases `lease-a`. That removes its identity, its invocation reference and its exclusive slot, and the replacement may carry a different home, scope and tenant. This is exactly the history rewrite and slot release the candidate claims is impossible.
- Overclaims:
  - `broker-recovery-schema.md`: "SQL rejects … history mutation and replacement".
  - `broker-recovery-schema.md`: "no … lease-row deletion".
  - `broker-recovery-schema.md`: the partial index "demonstrates non-release of an orphan's exact slot".
- Test gap: the only lease-side probe is a plain `INSERT … SELECT` clone (`test ≈L79-80`). The OR-variant test (`≈L114-123`) targets `broker_recovery_decisions` only.
- Minimal fix: add a clause to the `broker_lease_insert_guard` WHEN, which fires before REPLACE resolution:
  `OR EXISTS(SELECT 1 FROM broker_leases WHERE broker_id=NEW.broker_id AND resource_key=NEW.resource_key AND state='held_orphan')`
  This changes SQL bytes, so refreeze all digests.
- Tests to add:
  - `INSERT OR REPLACE`, `REPLACE`, `ON CONFLICT DO UPDATE` and `ON CONFLICT DO NOTHING` on leases, with and without existing decisions.
  - Each run under `recursive_triggers` ON and OFF.
  - Each run under `foreign_keys` ON and OFF.
  - Assert the original row is byte-identical afterwards.

## P1 blockers

**P1-1. The decisions-table REPLACE test never exercises the PK or UNIQUE-triple conflict paths.**
- Evidence: test `≈L116-120`. Both attempts reuse the same `(principal, request_id)`; only `input_digest` varies.
- The REPLACE path that would delete a decision row via `UNIQUE(broker_id, lease_id, prior_revision)` is protected only incidentally, by guard clause 3 (`recovery_revision=NEW.prior_revision`).
- Upsert is claimed in the doc and never tested.
- Fix: add cases with a different principal or request_id and the same `(broker, lease, prior_revision)`, plus `ON CONFLICT DO NOTHING/UPDATE`.

**P1-2. The negative tests can pass vacuously.**
- Evidence: bare `.toThrow()` throughout; `args(input)` is evaluated inside the thunk (`≈L103`).
- Any exception counts as success: a canonicalizer error, a bind-count error, or an unrelated SQL error.
- Several mutations are rejected by multiple controls at once. For example, `owner` trips both the insert guard and the receipt CHECK, so deleting either control would not fail the test.
- The `it.each([-1,0,1.5,9007199254740992])` test passes through the `owner_generation<>OLD+1` trigger, not the CHECK, so its title is misleading.
- Fix:
  - Build args outside the thunk.
  - Assert the SQLite message or code per case.
  - Run a mutation-kill check: dropping each trigger or CHECK must fail at least one test.

**P1-3. SQL accepts receipts the protocol parser rejects, and the terminal release rests on them.**
- Evidence: `schema.sql:59-92`.
- Type and shape gaps in the CHECKs:
  - There is no `json_type='text'` on `request_id`, `operator_ref`, `subject.broker_id/lease_id`, `proofs[0].record_ref`, `proof_refs[0]`, `producer_ref` or the proof's `broker_identity.broker_id/lease_id`. Comparing JSON numbers against TEXT columns coerces under column affinity.
  - `subject_digest` has no hex or length check.
  - `schema_spec_digest`, `ddl_digest`, `fixture_digest` and `recovery_build_digest` have no checks at all.
  - `$.effect_id` may be present, though `RecoveryReceipt` rejects it (`UNEXPECTED_EFFECT_ID`).
  - Extra keys are accepted, though the protocol is `.strict()`.
- A row can therefore commit, flip the lease to the terminal `resolved_stopped`, and later fail `RecoveryReceipt.parse` on replay lookup.
- Duplicate JSON keys: SQLite does not define which duplicate wins, and `JSON.parse` takes the last. Stored bytes can diverge between the SQL view and the host view.
- Fix: add `json_type(...)='text'` and hex or length CHECKs on the fields above, and `json_extract(receipt_json,'$.effect_id') IS NULL`. Require the host to store `canonicalJointJson` output and read it back with the strict parser.
- Test: add a parity test where SQL-accepts implies `RecoveryReceipt.parse` accepts, over mutated broker receipts.

**P1-4. No offline test composes the real contracts.**
- Evidence: `RecoveryRequest`, `recoveryRequestInputDigest` and `verifyRecoveryProofEnvelopes` are never called. `input_digest` is the constant `'d'.repeat(64)` in every test.
- These are pure functions already in-repo, so deferring them is not justified by the host/runtime deferral.
- Fix: one test running request → input digest → receipt → envelope verify → SQL insert, with a tamper variant at each hop.

**P1-5. The oracle pre-freeze claim is unverifiable offline.**
- Evidence: `manifest.json` `oracle_prefreeze.path = independent/oracle-freeze.json` and its sha256. That file is not in the supplied bundle, and neither `freeze.py` nor any test hashes it.
- `freeze.py` hardcodes the oracle sha. Regenerating after SQL changes keeps the old oracle digest attached to new bytes, and `schema_change_id` stays `…-v1`.
- The doc's "independent agent froze its oracle before receiving the candidate" is not offline-checkable.
- `identity_independence_certified:false` is honest. The attachment of the digest to the current bytes is not.
- Fix: ship the file and test its hash, or drop the claim. Make regeneration null the oracle fields when `ddl_digest` or `fixture_digest` change.

## P2 (should fix, not blocking)

1. **`freeze.py --check` is not byte-exact.**
   - `read_text()` applies universal newlines and a locale-dependent encoding. `.gitattributes` protects only `*.sql`.
   - Fix: `read_bytes()` plus an explicit LF encoder, and `*.json`/`*.py` `-text` or `eol=lf` in `.gitattributes`.
2. **No SQLite version or feature pin.**
   - The candidate depends on STRICT (≥3.37), the JSON functions, `json_valid` strictness and `changes()` inside triggers.
   - Python's bundled SQLite and better-sqlite3 can differ, and the test shells out to `python3`.
   - Fix: assert `sqlite_version()` against a minimum in the test and `freeze.py`, and record it in the manifest.
3. **The header does not distinguish a broker from a home.**
   - `schema.sql:124` sets only `user_version=1`, and `application_id` is unset. The empty source (`[]`, version 0) matches any empty file.
   - Fix: set a constant `application_id` and include it in the manifest and the host open check.
4. **`schema_spec_digest` covers none of the manifest `storage` block.**
   - `allocation`, `deployment_qualified` and `namespace` are protected only by `freeze.py` constants.
   - `source_schema_digest` and `target_schema_digest` are bare SHA-256 with no domain prefix. I could not verify these against `digest-catalog.json`.
   - The test uses `actual_target_schema=48` as a negative, which is arbitrary rather than a home-schema discriminator.
5. **Identifier hygiene.**
   - `length(trim())` accepts padded values, so `'x '` and `'x'` are distinct resource keys.
   - SQLite `length()` counts characters and stops at NUL, while zod counts UTF-16 units.
6. **`OR IGNORE` suppresses CHECK failures silently.**
   - A bad-shaped receipt inserted with `INSERT OR IGNORE` is dropped with `changes=0` and no error. Fail-closed holds, but silently.
   - Fix: the doc must mandate plain `INSERT` plus `changes===1`, with a test.
7. **Owner history is overwritten.**
   - `owner_ref` is replaced on takeover, and decisions carry no broker `owner_ref`. The authority behind a generation cannot be reconstructed later.
   - Fix: an append-only `broker_owner_history`, or `owner_ref` in each decision.
8. **Proof envelopes are not pinned.**
   - Only inline `proofs[]` is stored. No envelope digest pins `observed_at_ms`, the producer `authorization_ref`, or the build digest.
   - A terminal release depends on external record immutability.
9. **No correction path for a wrong `resolved_stopped`.** This should be an explicit documented limitation, not silent.
10. **Stage declarations are free-form strings in the manifest.** Nothing cross-checks them against `execution-gates.json`, and `manifest.paths` is not enforced against the actual diff. "No runtime changes" is therefore not provable from this bundle.
11. **Proofs carry no `invocation_ref`, `grant_generation` or `resource_key`.**
    - `broker_identity` in the proof binds only `broker_id`, `lease_id`, `schema` and `owner_generation`.
    - The stop proof's tie to the stored invocation rests entirely on host-loaded evidence bytes. The doc's host item 4 covers this, but the storage layer cannot assist.
12. **Cross-database gaps are all deferred.**
    - Envelopes carry no `scope_id`/`tenant_id`.
    - File-backed WAL/FULL behaviour, multi-connection races and `BEGIN IMMEDIATE` are untested.
    - Replay logic is unimplemented; SQL only rejects duplicates.

## Assessments requested

- **Deferred boundaries:** honest in the doc and manifest (`not_run`, `not_asserted`, `deployment_qualified:false`, in-memory-only tests). Exceptions: the lease "replacement/no deletion" overclaim (P0-1), "upsert" for decisions (untested), and "independently reproduce" (same author, same `sqlite_master` query) plus the oracle claim (P1-5).
- **Unreserved 0→1 candidate vs deployed broker/home48:** distinguished adequately in prose and manifest flags. The data-level discriminators are only the `broker_identity` row, the CHECK text inside the catalog, and `schema_change_id` (see P2-3 and P2-4). `MigrationSpec` itself carries no namespace.
- **Python freeze freshness:** it regenerates `catalog.json` and `manifest.json` from `schema.sql` and `held-orphan.sql` and compares them. That detects stale JSON, but not newline-only drift (P2-1) or an oracle detached from new bytes (P1-5).
- **Test counts:** 26 tests pass, but P0-1 shows the suite does not cover the guard's central invariant.

VERDICT: REVISE
END_AUDIT