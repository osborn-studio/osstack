# Adversarial review: JP-17a broker recovery storage candidate (CODE e8770e3)

**Limits.** I had no tools and executed nothing. SQLite behaviour is taken from documented semantics, not from a run. Line numbers are counted from the supplied text and may be off by ±1. I did not see the BASE..CODE diff, so "SQL/fixture/catalog/manifest byte-identical to c454/858" is taken as the host's statement. The only full-verification record is for 812080a. For e8770e3 I have only the reported 89 tests and typecheck.

## P0

None confirmed.

## P1

None confirmed. I could not find a violated stated SQL or spec guarantee. I re-derived closure of each mutation path from the DDL rather than relying on the tests.

- **`broker_leases` insert paths.**
  - `INSERT`, `OR IGNORE`, `OR REPLACE`, `REPLACE` and upsert all hit the BEFORE INSERT guard (`schema.sql:38-43`) before conflict resolution.
  - The guard covers every uniqueness conflict REPLACE could resolve. Clause `:39` covers the PK and `UNIQUE(broker_id,lease_id)`. Clause `:40` covers the partial index.
  - A held, resolved or orphan row therefore cannot be evicted by a statement-level conflict strategy.
- **`broker_leases` update and delete paths.**
  - Any external UPDATE, including `UPDATE OR REPLACE`/`OR IGNORE`, needs a decision with `prior_revision = OLD.recovery_revision`.
  - That row cannot persist, because the AFTER INSERT projection advances the revision in the same statement. The update guard (≈`:103-111`) is therefore unconditional for outside callers.
  - DELETE is blocked by `broker_lease_no_delete`.
- **Decisions.**
  - A REPLACE could only delete a decision via the PK or the `(broker,lease,prior_revision)` triple.
  - The PK case is caught by guard clause 1.
  - The triple case is caught by clause 3. An existing row at revision p implies the lease is already at ≥ p+1, so `recovery_revision=NEW.prior_revision` fails.
  - UPDATE and DELETE are blocked by the `no_update` and `no_delete` triggers.
- **`broker_identity`.**
  - Insert is blocked once a row exists. Delete is blocked.
  - Every update must be exactly +1 with immutable keys. The NULL case falls to NOT NULL, which the FK-OFF test exercises.
- **Recursion.** `recursive_triggers=OFF` does not disable the nested guards. The projection UPDATE fires a different trigger.

## Host dispositions

- **P0-1, P1-1, P1-2, P1-4, P1-5, P2-1, P2-6:** accepted.
- **P1-3:** accepted as a host boundary. Doc item 3 and the "defensive subset" wording state the boundary explicitly.
- **Prior P1-A and third-review P1-1(a)-(c):** closed.
  - The count reconciles: 25 receipt predicates + 2 existing-id guard mutants + 2 cardinality + 6 integer-type = 35 mutation instances.
  - The test blocks enumerate to 89.
  - The counterexamples diverge as claimed. `"0"`/`"2"` against INTEGER-affinity columns are coerced to equal. `1.0=1` is true in SQLite. `JSON.stringify` cannot emit `1.0`, and the test injects it as raw text.
  - Mutants assert admission and release, so these are not syntax-error or redundant kills.
- **P2-2 through P2-12:** accepted as limitations. The doc states each, and the manifest flags are consistent with it.

## P2 (non-blocking; should fix or track)

1. **Lease creation is not owner-generation fenced.**
   - The guard uses `owner_generation >= NEW.grant_generation` (`schema.sql:42`).
   - A deposed owner holding a connection could add a `held_orphan` lease with a stale `grant_generation` and consume an exclusive slot.
   - The doc's "obsolete broker generations" rejection holds only for decisions, and the doc does not say so.
   - Minimal fix for this slice: add one sentence to the doc saying lease creation relies on host writer fencing.
   - If you tighten SQL to `=`, the post-stop clone insert in "retains the exclusive slot…" and `new-lease` would need `grant_generation=2`, and all digests would refreeze. I do not recommend that now.
2. **SQLite floor is slightly low, and the TS test does not enforce it.**
   - `freeze.py` asserts `>= (3,37,0)`. Built-in JSON is default only from 3.38, and `freeze.py` never executes a JSON path.
   - Fix: require ≥ 3.38 in `freeze.py`, and add a `json_valid('{}')` smoke check there.
   - Fix: add one `sqlite_version()` floor assertion to the TS test, so the doc's "freeze helper refuses older SQLite" is not Python-only.
3. **Error-class shadowing (documentation or test only).**
   - The BEFORE INSERT guard calls `json_extract(NEW.receipt_json, …)`. On malformed JSON this should raise a generic SQLite error before the `json_valid` CHECK runs.
   - The result is `SQLITE_ERROR`, not `SQLITE_CONSTRAINT`, and the `json_valid` CHECK is effectively shadowed.
   - It is still rejected, so this is fail-closed.
   - A host that classifies rejections by `SQLITE_CONSTRAINT*` would mis-bucket it.
   - Fix: add one malformed-JSON case asserting a throw, and note the code class in the host checklist.
4. **Optional coverage that is not required to close the stated guarantees.**
   - The receipt size cap `<=1048576`.
   - The `input_digest` length and hex CHECK on INSERT.
   - The identity `schema_namespace` and `schema_version` CHECKs on an empty DB.
   - `UPDATE OR REPLACE`/`OR IGNORE` on leases and identity. The guard is unconditional, so risk is low.
   - A documenting test of which controls survive `ignore_check_constraints=ON`.
5. **Digest registry drift (parent-owned).**
   - The `digest-catalog.json` `schema_spec_digest` input omits `source_schema_digest` and `target_schema_digest`. `schemaSpecDigest` (`joint-lifecycle.ts`) and `freeze.py` both include them.
   - The two implementations agree with each other and with the operator-recovery doc. This broker doc's "registered … covers" statement matches the code, not the registry.
   - An independent implementer following the registry prose would compute a different digest.
   - Fix, outside this PR: correct the registry and add a protocol test that fails when registry prose and function inputs diverge.
6. **Byte-exactness and manifest hygiene.**
   - The TS test hashes `readFileSync(..., 'utf8')` strings. Python hashes bytes. They are equal for valid UTF-8, but hashing the Buffer would match the byte-exact claim.
   - Manifest `oracle_prefreeze.frozen_at` (`…16:16:01Z`) is hard-coded and truncated relative to the file's microsecond timestamp, with no cross-check.
   - No test asserts the `.gitattributes` contents. A digest mismatch would catch drift anyway.
   - `manifest.paths` is not enforced here. "No runtime product source changed" must be bound to the real diff at merge.
7. **Verification binding.**
   - The only full-verification record is for 812080a and is correctly labelled as such.
   - Merge needs the final archived core and affected checks bound to e8770e3.
   - The report states SQLite 3.53.1 for both engines, but no test asserts that version. It lives only in the archive.
8. **`invocation_ref` is not unique per broker, and proofs carry no `invocation_ref`.**
   - A stop decision for one lease says nothing about another lease sharing an invocation.
   - This is not a stated guarantee. It stays covered by host checklist item 4, but keep it explicit for J17.recovery.

## Nonblocking limitations (stand as declared)

- The owner row is only the current projection; election history is not retained.
- There is no `application_id`.
- SQL is a defensive subset of the protocol. That includes affinity coercion, duplicate-key semantics, padded identifiers, and the unbound `subject_digest` and `input_digest`.
- `ignore_check_constraints=ON` bypasses the proof gate.
- Proof envelopes are not pinned.
- There is no correction path for a wrong `resolved_stopped`.
- There are no file-backed, WAL, crash, multi-connection or replay tests.
- The oracle chronology is agent-reported.
- The SQL gates do not enforce or test JA47 omission-matrix parity at the parser level. They are host or parser scope, and the composition test covers only the subject-digest tamper.

## Requested assessments

- **Deferred boundaries:** honest.
  - `deployment_qualified=false`, `allocation=not_reserved`, `actual_deployment_path=null`, the `not_run` entries, and the in-memory-only statement are consistent with each other.
  - They are also consistent with `execution-gates.json`. `runtime_storage_requires` now equals the `J17.scoped` requires.
  - The doc hedges the independence, oracle, bounded-mutation and `OR IGNORE` scope claims.
- **Separate DB and unreserved 0→1 candidate vs deployed broker and home48:** adequately distinguished.
  - The distinguishers are the namespace CHECK, `schema_change_id` as a family label, the exact catalog and spec digests, the manifest flags, and the empty source catalog.
  - `user_version=1` plus no `application_id` is weak on its own, but doc host check 1 requires the full catalog check.
  - `actual_target_schema=48` is only an arbitrary receipt-value negative, not a home discriminator.
- **Python freeze freshness:** byte-exact for `catalog.json` and `manifest.json` from `schema.sql`, `held-orphan.sql` and the hard-coded oracle hash.
  - It proves freshness and cross-engine digest agreement, not qualification.
  - It does not hash the doc, the test, `.gitattributes`, or the diff paths.
- **Manifest identity:** fully derived from `freeze.py` constants. It is not self-hashed and is bound by the audited SHA, as documented. This is acceptable for a spec-only PR.
- **Test adequacy:** the suite substantiates its stated bounded guarantees. It does not show mutation exhaustiveness, and the doc does not claim it. The items in P2-3 and P2-4 are optional additions.

This is not a J11/J17 gate PASS. It means only that no blocker remains against the stated offline guarantees.

VERDICT: PASS
END_AUDIT