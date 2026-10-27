BEGIN_AUDIT

**Scope and assumptions.** I reviewed only the supplied text. I did not see `fixtures/joint/*.json`, the generated `schemas/joint/*.json`, `digest-catalog.json`, `validation.md` or `migrations.ts`, and I executed nothing. SQLite behaviors below are from the documented semantics; the proposed tests will confirm them.

## A. Blocking defects (J01/J11 artifacts, no runtime needed to fix)

**1. HIGH: `INSERT OR REPLACE` silently bypasses "immutable" history**
- File: `bootstrap.sql:22-25, 36-39`; the same pattern is in `future-storage.sql:9-12`.
- Failure: the guards are only `BEFORE UPDATE` and `BEFORE DELETE` triggers. SQLite's REPLACE conflict resolution deletes conflicting rows without firing DELETE triggers unless `recursive_triggers` is ON, and the default is OFF.
- Exploit: `INSERT OR REPLACE INTO operator_recovery_decisions VALUES('operator','request',…,'applied_observed',…)` rewrites an earlier `preserve_unknown` row.
  - A different `request_id` with the same `(subject_digest, prior_revision)` also deletes the earlier decision. That is exactly the "decide the same revision twice" case `UNIQUE` was meant to prevent.
  - `operator_upgrade_journal` and `joint_method_objects` are open to the same attack.
  - The test (`operator-recovery-spec.test.ts:62-63`) only tries UPDATE and DELETE.
- Fix: add `BEFORE INSERT` guards that fire regardless of conflict clause. Add `REPLACE INTO` and `ON CONFLICT DO UPDATE` cases to the tests for every immutable table.
```sql
CREATE TRIGGER operator_recovery_no_replace BEFORE INSERT ON operator_recovery_decisions
WHEN EXISTS(SELECT 1 FROM operator_recovery_decisions WHERE principal_ref=NEW.principal_ref AND request_id=NEW.request_id)
  OR EXISTS(SELECT 1 FROM operator_recovery_decisions WHERE subject_digest=NEW.subject_digest AND prior_revision=NEW.prior_revision)
BEGIN SELECT RAISE(ABORT,'operator recovery history immutable'); END;
```
- Regenerate `ddl_digest` and `schema_spec_digest` after the change.

**2. HIGH: ledger columns are not bound to the receipt, and storage types are unchecked**
- File: `bootstrap.sql:2-20, 26-35`.
- Failure: the uniqueness key `(subject_digest, prior_revision)` is a free-standing column.
  - Nothing ties it to `receipt_json.subject_digest`, `if_revision`, `decision`, `request_id`, `operator_ref` or `owner_generation`, or to `subject_json`.
  - The test inserts `receipt_json='{}'` and `subject_json='{}'` successfully (`test:58`).
  - A writer can store `subject_digest='f'*64` for subject S, which consumes a different chain.
  - Types are unchecked on a TEXT/INTEGER-affinity column. A BLOB or REAL `prior_revision=1.5` passes the existing CHECKs, and BLOB and TEXT never compare equal, so UNIQUE collisions can be dodged.
  - `subject_json` and `evidence_json` have no size cap.
  - The SQL `owner_generation>0` contradicts the receipt shape `min(0)` (`joint-shapes.ts:130`).
  - Subject kinds `broker_lease` and `target='broker'` are accepted although only the local-home ledger exists in this batch.
- Fix: add CHECKs.
  - `typeof(col)='text'` for the text columns, and `typeof(...)='integer' AND <=9007199254740991` for `prior_revision`, `owner_generation` and `created_at_ms`.
  - `json_type(receipt_json)='object'`, plus `json_extract(receipt_json,'$.subject_digest')=subject_digest`, and the same equality for `$.if_revision`, `$.owner_generation`, `$.decision`, `$.request_id`, and `$.operator_ref` against `principal_ref`.
  - `json_extract(receipt_json,'$.target')='home'` and `json_extract(subject_json,'$.kind') IN ('effect','attention_action')`.
  - Compare per field, or drop `subject_json` and project it from the receipt.
  - Add a length cap on `subject_json` and `evidence_json`.
  - Make the receipt `owner_generation` `.min(1)`.

**3. HIGH: the revision chain is not enforced and terminal rows can be superseded**
- File: `bootstrap.sql:15, 21`, `operator-recovery-spec.md:28`.
- Failure: UNIQUE prevents duplicates only.
  - A fresh subject can get `prior_revision=7`. Whether "current revision" means count or max is undefined at the storage layer.
  - After `proven_stopped` or `applied_observed`, any later row (for example `preserve_unknown`, or a contradictory `applied_observed`) is accepted. This violates "do not revive a terminal disposition".
  - Legacy `attention_dispatch_phases` has no recovery revision column, so the ledger is the only CAS.
  - The test starts at `prior_revision=1` (`test:58`), which contradicts the `if_revision=0` fixtures.
- Fix: add a chain trigger (BEFORE INSERT) and fix the test to start at 0.
```sql
WHEN NEW.prior_revision <> COALESCE((SELECT MAX(prior_revision)+1 FROM operator_recovery_decisions WHERE subject_digest=NEW.subject_digest),0)
  OR EXISTS(SELECT 1 FROM operator_recovery_decisions WHERE subject_digest=NEW.subject_digest AND decision<>'preserve_unknown')
```
- Optionally add the journal state machine as a trigger (first row `fenced` at revision 0; `installed_inactive` only after `verified`). That removes reliance on host CAS for something SQL can express cheaply.

**4. HIGH: no registered digest domain or constructor for the idempotency `input_digest`**
- File: `joint-json.ts:6-11`, `bootstrap.sql:5`, `future-storage.sql:27`, `operator-recovery-schema.md:28`.
- Failure: the spec requires an input digest binding "entire canonical request and authenticated scope", and the ledger stores one. `jointDigest` throws `UNKNOWN_JOINT_DIGEST_DOMAIN` for anything unregistered.
  - J12 must therefore either amend the frozen domain set or hash ad hoc.
  - Two recovery builds can compute different digests, which turns replays into false `IDEMPOTENCY_CONFLICT` or false matches.
  - The same applies to the permit-consumption `input_digest`.
- Fix: register `recovery-request-input.v1` over `{schema_version:1, principal_ref, scope_id, tenant_id, request}`, with an exported constructor that takes the parsed request. Add a vector, ideally generated outside the TS implementation. Do the same for the permit-consumption input.
- Also add typed `trialRootEffectId({scope, idempotency_key, permit_id})`, and give `TrialPermit.root_effect_id` the regex `^trial-[a-f0-9]{64}$` (`joint-shapes.ts:68`).

**5. MEDIUM: bounds disagree between request, subject and receipt**
- File: `joint-shapes.ts:128` vs `:166` (effect_id is 256 vs 512); `joint-recovery.ts:13` (`request_id: Ref` is 512 vs receipt `:135` at 256).
- Exploit: a subject with a 300-character `effect_id`, or a 300-character `request_id`, passes `RecoveryRequest`. The receipt then cannot represent it. The decision is either permanently undecidable, or J12 commits the CAS and fails to emit the receipt.
- Fix: align the bounds (256 everywhere the value flows into a receipt) and add a table-driven test asserting Request, Subject and Envelope field bounds are no wider than the Receipt's.

**6. MEDIUM: receipt proofs are not linked to `proof_refs`, and the decision/proof check is too loose**
- File: `joint-recovery.ts:47-48`.
- Failure:
  - `proof_refs` and `proofs` are independent. There is no `record_ref` on a receipt proof, and no length or equality check.
  - `preserve_unknown` accepts any proofs. The matrix test relies on that with an `invocation_contained` proof (`joint-foundation.test.ts:60-63`).
  - `proven_stopped` passes with extra contradictory proofs because the check uses `some`.
- Exploit: a `proven_stopped` receipt with `proof_refs:['x']` and an unrelated proof from `producer_ref:'operator-self'` is structurally valid. An auditor cannot tell which host record backs which proof.
- Fix: add `record_ref` to the receipt proof element. Require `proof_refs` to equal the unique set of proofs' `record_ref`. Require `proofs.length===0` for `preserve_unknown`. For the other decisions require exactly one proof, of the required type.

**7. MEDIUM: acceptance tests do not support the README's claims**
- File: `operator-recovery-spec.test.ts`, `joint-foundation.test.ts:57-65`.
- Gaps:
  - `future_storage_digest` in the manifest is never checked against `future-storage.sql`.
  - `operator_upgrade_journal`, its CHECKs and its triggers are never exercised.
  - `legacy()` snapshots table rows only. A bootstrap that does `DROP TRIGGER attention_dispatch_no_rewind` or adds a trigger or view on an original table passes. Compare full `sqlite_master` `(type,name,tbl_name,sql)` before and after, and assert the added objects equal exactly the bootstrap set and that every `operator_*` trigger targets only `operator_*`.
  - The broker case in the matrix test uses an `effect` subject, so all four decisions fail via `TARGET_PHASE_MISMATCH`. No `broker_lease` happy path, no `INVALID_BROKER_DECISION`, no `attention_action` null-identity path, and no `prior_resolution` case is covered.
  - There is no end-to-end test: build a `RecoveryReceipt` in TS, canonicalize, insert, read back, then `decodeJointContract` and recompute the subject digest.
  - `LIKE 'sqlite_%'` at `test:17` treats `_` as a wildcard, so a table named `sqlitexfoo` is invisible to the lineage and row-preservation checks. Use `substr(name,1,7)<>'sqlite_'`.
  - The manifest is read with plain `JSON.parse` (`test:21`), contrary to the README rule. Duplicate keys in the authoritative pin would be silently last-wins. Use `parseJointJson`.
  - There is no vector-count or category assertion for "24+5".

**8. MEDIUM: `OracleLifecycle` `frozen` cannot be produced honestly**
- File: `joint-lifecycle.ts:6, 19`.
- Failure: the `frozen` variant requires `candidate_sha` and `candidate_created_at_ms` while also requiring `frozen_at_ms < candidate_created_at_ms`. A candidate SHA cannot exist at freeze time, so the record is either assembled after the fact with a self-asserted, backdatable `frozen_at_ms`, or never used. There is no host-immutable reference for the freeze, so the pre-registration guarantee reduces to an unverifiable number.
- Fix: `frozen` carries `pinned_digest`, `frozen_at_ms` and a `freeze_record_ref` (host custody receipt). Move candidate and profile binding to `executed`, or to a new `bound` state. Host verifies the timestamp from the ref.

**9. MEDIUM: `SourceSnapshot` accepts path hazards (this is the digest root of materialized method source)**
- File: `joint-evidence.ts:5-11`.
- Failure: only exact-duplicate paths and `.`/`..`/empty segments are rejected. Not rejected:
  - `.git` segments, so `.git/hooks/*` can be materialized and executed;
  - case-fold and NFC/NFD collisions, so `Skill.md` and `skill.md` collapse on APFS (this environment is darwin);
  - file-versus-directory prefix conflicts (`a` and `a/b`);
  - mode `120000` symlinks, whose blob content may escape the root;
  - non-canonical file ordering (the same tree yields different digests).
- Fix:
  - reject `.git` segments case-insensitively;
  - reject paths colliding under casefold plus NFC, and prefix conflicts;
  - reject `120000` and `160000` unless explicitly supported;
  - require ascending path order;
  - restrict path characters.
- Apply the `.git` rule to `SourcePin.subdir` too.

**10. MEDIUM: "complete lineage" is table names only**
- File: `joint-lifecycle.ts:37-52`, manifest, `operator-recovery-schema.md:9`.
- Failure: `schema_spec_digest` covers table names, not definitions. A schema-47 database with the right table names but altered CHECKs, or a missing `attention_dispatch_no_rewind`, matches the spec. The recovery path then runs on weaker invariants than the fixtures assume.
- Fix: add `source_schema_digest` and `target_schema_digest` (sha256 over ordered `sqlite_master` `type|name|tbl_name|sql`) to `MigrationSpec` and to the `schemaSpecDigest` input, and test both sides. `MigrationSpec` is `.strict()` v1, so changing it now is free.

## B. Non-blocking defects and gaps (fix before the first consumer)

**11. MEDIUM: shared digest and decode inconsistencies**
- `subject_digest` is verified in the schema, but `MethodBinding.binding_digest` is not (`method-binding.ts:9-12`). `decodeJointContract` accepts a Binding whose digest does not match its body. Either enforce it in `superRefine` (the function is pure) or document that decode does not verify it.
- Typed digest constructors exist for only 4 of the 16 registered domains. The exported raw `jointDigest` invites hashing unvalidated objects.
- `schemaSpecDigest` sorts the lineage tables (`joint-lifecycle.ts:50`), but the approved design says only `role_materials` is sorted. Reconcile in `digest-catalog.json`.
- The domain `Set` in code is not tested against `digest-catalog.json`, which the design calls the sole registry.

**12. MEDIUM: semantic holes in other shapes**
- `SupportProfile` (`method-binding.ts:33-36`): `stop_proof_level:'contained'` with `containment_domain:null` or `can_request_stop:false` is accepted. `proven_stopped` trust depends on these fields.
- `ArtifactRequirements` (`method-binding.ts:20-22`): `independent_review` may have `producer_role:'builder'` or `required:false`. Add a kind-to-role compatibility table.
- `CheckRegistry` (`joint-evidence.ts:15-18`):
  - `ref` and `command_bytes_sha256` have no defined relation, so the lookup key is ambiguous;
  - `command_bytes_sha256` need not be unique, which defeats "唯一 AcceptanceCommandSpec";
  - `pass_codes` is not forced to `[0]`, although the design says it is exactly `[0]`.
- `Ref` allows control characters, whitespace and case or normalization variants (`joint-primitives.ts:2`). Oracle independence compares raw strings, so `'impl'` versus `'impl '` is a trivial alias. Restrict the charset.

**13. MEDIUM: `future-storage.sql` templates are weaker than the design**
- `trial_permit_consumptions` has no immutability or forward-only trigger. A `DELETE` resets a permit, contradicting "not restored".
- Digest checks are `length=64` only, with no hex check (`:3, 27, 34`), unlike bootstrap.
- `joint_method_active.qualification_digest`, `binding_digest` and similar columns reference `joint_method_objects(digest)` without a kind constraint, so an active pointer can reference any object kind. Use a composite FK with a `kind` column.
- `content_ref` is unvalidated, which is a path-traversal risk if the host resolves it as a path.
- `trial_permit_consumptions.permit_id` is global, with no scope or tenant column.

**14. LOW: smaller items**
- Package scripts (`package.json:17-19`) do not wire `generate-joint-schemas.mjs`, so there is no `check:joint-schemas`. The only drift check is the vitest, which ignores orphan files.
- `canonicalJointJson`'s hole check (`joint-json.ts:103`) is dead because `Array.prototype.some` skips holes. Rejection currently happens only because `encode(undefined)` throws.
- Shared-reference DAGs of depth ≤ 64 expand exponentially before the 1 MiB check at `:114`. Enforce the budget incrementally.
- `decodeJointContract(raw: string)` cannot detect invalid UTF-8 already replaced with U+FFFD. Add a bytes entry point using a fatal `TextDecoder` that also rejects a BOM.
- Material `Text` is bounded in UTF-16 units (16384), not bytes.
- Hashing fixtures through `readFileSync(...,'utf8')` is not raw-byte hashing. Read Buffers and pin `.gitattributes` `-text`.
- The index at `bootstrap.sql:21` duplicates the UNIQUE index.
- Fixtures and the manifest digest were recomputed by the code under test. Add at least one recomputation by an independent tool (`sha256sum` or Python) for `recovery-subject`, `schema-spec` and `method-binding`.

## C. J12/J17 obligations (deliberately outside this batch; not defects)

- Fencing and fault tests:
  - file-backed WAL/FULL subprocess kill tests;
  - old-owner and already-open old-writer fencing;
  - the `recovery_target_version` open path;
  - FULL synchronous (current `openDb` uses NORMAL).
- Trusted-state checks:
  - proof loading and authentication, including candidate/build/schema/profile binding (the envelope has no such fields, so these must come from the host record);
  - requiring each subject's `home_id` to equal the trusted `daemon_owner` home;
  - requiring the subject kind to match the trusted record's kind. Otherwise the same hold addressed as `effect` and as `attention_action` forks into two revision chains, and the same applies to non-key fields such as `mission_id`.
- Stored JSON and migration equivalence:
  - ledger JSON must be read back through `parseJointJson`, since `json_valid` accepts duplicate keys;
  - the migrated 48 and the bootstrapped 48 must be schema-identical, otherwise a later registered migration 48 skips on bootstrapped databases;
  - a user_version-48 collision with a different future main fails closed only via the lineage check.
- Broker handling: `broker_lease` rows need a broker-side ledger. Receipt `owner_generation` currently means broker generation for broker targets and home generation otherwise. Split the field before J17.
- Coupling: the `CURRENT_SCHEMA_VERSION===47` assertion (`test:23`) will turn every unrelated schema PR red. Make sure the state-owner checklist names this test.

## Verdict

**REVISE.** Findings 1–10 are cheap, spec-only changes that must land before the DDL, manifest digest and `MigrationSpec` are treated as frozen, because each change regenerates `ddl_digest` and `schema_spec_digest`. Findings 11–14 can follow in J01b or the first consumer PR.

The codec itself (`joint-json.ts`) looks sound for what it claims:
- duplicate keys, `-0`, bounds and lone surrogates are handled;
- `__proto__` is retained as data;
- depth indexing is symmetric between parse and encode.

The stated test totals are unverified here, and the full typecheck/test run must be green before merge.

END_AUDIT
