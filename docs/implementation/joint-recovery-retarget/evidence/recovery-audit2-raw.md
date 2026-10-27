BEGIN_AUDIT
Verdict: REVISE (static review only; nothing executed, no tests run; this is not runtime qualification)

Scope honored: J11 is a spec and SQL fixture. J12 WAL/crash, trusted auth, current generations and provider tests are deferred and not counted against it. The findings below are defects in what J11 itself claims or pins.

**P1-1: Terminal sealing depends only on `decision<>'preserve_unknown'`, so the chain can be sealed by a row that was never a valid resolution.**
Path: `packages/core/fixtures/operator-recovery/bootstrap.sql`, `operator_recovery_insert_guard`.
Counterexample: the guard reads existing rows by `subject_digest` only. Two different `(principal_ref, request_id)` pairs share a subject digest only if `subject_json` matches, which is enforced. But the guard never checks `post_state` against the prior phase carried in earlier rows. A `preserve_unknown` row with `prior_phase='reserved'` followed by `proven_stopped` with `prior_phase='dispatch_committed'` for the same subject is accepted, because the phase is validated per-row against its own receipt and never across the chain. The subject moved from reserved to committed between revisions with no continuity check, and the ledger records it as a normal sequence.
Minimal fix: either assert in the guard that `prior_phase` is non-regressing across the chain (reserved → dispatch_committed only, legacy_unknown fixed), or document explicitly that cross-row phase continuity is a J12 obligation and add it to the acceptance list. The spec currently lists "stale subject revision" but not phase regression across the chain.

**P1-2: The `proven_stopped`/`applied_observed` SQL check cannot distinguish the proof type that justified the decision.**
Path: `bootstrap.sql` table CHECK, and test `joins host-loaded proofs...` in `operator-recovery-spec.test.ts`.
Counterexample: the table CHECK never inspects `$.proofs` or `$.proof_refs`. A receipt with `decision='applied_observed'`, `prior_phase='dispatch_committed'`, `proofs:[]`, `proof_refs:[]` satisfies every SQL constraint and is insertable. Only `RecoveryReceipt.parse` rejects it, and the test-local `persist` is not production code. The spec says SQL is "not a complete protocol validator", but also advertises the matrix as enforced "independently of the TypeScript parser" (matrix test title). That title overclaims: the SQL matrix covers phase/decision only, not proof presence.
Minimal fix: add `json_array_length(receipt_json,'$.proofs')=CASE WHEN decision='preserve_unknown' THEN 0 ELSE 1 END` and `json_array_length(receipt_json,'$.proof_refs')=json_array_length(receipt_json,'$.proofs')` to the CHECK, or rename the test and state that proof cardinality is parser-only. The first is cheap and removes a bypass for any caller that skips the parser.

**P1-3: Reserved + `abandoned_unknown` is not blocked for `proven_not_started` at the SQL layer in the intended way, and the frozen test does not pin it.**
Path: `bootstrap.sql` CHECK clause `decision='proven_not_started' AND prior_phase='reserved' AND prior_resolution='none'`.
This is correct as written. However the 40-combination test uses `base` with `binding_generation:null` and `support_profile_digest:null` for every combination, including `effect`-style phases, so it never exercises an effect subject with real identities. A mutant that dropped the `prior_resolution='none'` conjunct would be caught, but a mutant that mishandled effect subjects with non-null identities is not covered.
Minimal fix: parametrize the matrix test over both subject kinds, or state in the dispositions that the SQL matrix is verified for the Attention subject only.

**P2-1: Freeze provenance check compares only two source files.**
Path: `freeze.mjs`: `git diff --exit-code base -- migrations.ts db.ts`.
Counterexample: a migration helper module imported by `migrations.ts` that changed since `base` leaves the diff clean for these two paths while the compiled `dist` differs. The manifest then freezes a catalog from a lineage that does not match the stated base. `dist` is also never checked to be built from HEAD; the README says "build before freezing" but nothing enforces it.
Minimal fix: diff the whole `packages/core/src/state/` directory, and record the dist build's source hash or refuse to run if `dist` is older than `src`.

**P2-2: `schema_spec_digest` excludes `future_storage_digest`, yet the doc presents future templates as covered by the pinned lineage.**
Path: `docs/design/operator-recovery-schema.md` ("It excludes future receipts/builds") versus `manifest.json` `future_storage_digest`.
The future-storage hash is verified by the Python script but not bound into the schema-spec digest, so a changed template does not invalidate any receipt. That is acceptable if intended, but the text should say so. Currently a reader could infer the template is frozen into the recovery identity.
Minimal fix: one sentence stating the template digest is a separate pin and intentionally outside `schema_spec_digest`.

**P2-3: Replay semantics are specified but only half-pinned by tests.**
Path: doc "Within the current owner transaction, resolve `(principal, request_id)` first".
The tests prove that SQL rejects a duplicate key, including under `INSERT OR IGNORE`, `OR REPLACE` and upsert. Nothing demonstrates that `input_digest` differences are surfaced as conflict; the tests always use `'a'.repeat(64)` as the input digest, and `recoveryRequestInputDigest` is never connected to the ledger. The idempotency-conflict path is therefore entirely untested. The dispositions call it host behavior, which is fair, but the J12 acceptance list says "duplicate and conflicting requests" without naming the digest comparison.
Minimal fix: add a test-local lookup that reads `input_digest` by key and distinguishes replay from conflict, mirroring the persist illustration.

**P2-4: Journal permits `failed` from `fenced` with `{}` evidence and a later `verified` is impossible, but nothing prevents `installed_inactive` without any recovery-ledger linkage.**
Path: `operator_upgrade_insert_guard`.
Already documented as ordering-only and inadmissible for J12. Flagging only that no CHECK requires non-empty evidence for `verified`/`installed_inactive`; a cheap `json_array_length`-style or key-presence check would make the `{}` case fail in SQL rather than relying on prose.

**P3-1: `ddl_digest` covers `bootstrap.sql` only; `source-hold.sql` and `future-storage.sql` are covered by separate fields.** Consistent, but the doc's phrase "frozen raw SHA256 of SQL and fixture bytes" is slightly broad. Clarify.

**P3-2: Test file import order.** `execFileSync` and `fileURLToPath` imports precede the header comment and the other imports; cosmetic, and does not match surrounding style.

**P3-3: `legacy()` interpolates table names into SQL.** Names come from `sqlite_master` on a trusted in-memory database, so no practical risk. A quoted identifier would be tidier.

Checked and found sound:
- Insert guard ordering is correct with respect to IGNORE, REPLACE and upsert, since BEFORE INSERT triggers run before conflict resolution.
- Update and delete triggers cover the immutability claims for both ledger tables.
- Envelope-context join covers all six fields plus subject, content, timing and reference cardinality.
- `decodeJointContractAs` rejects wrong-kind decoding, and the test pins `recovery_request` against a receipt.
- Catalog and lineage digests are consistent across manifest, Python vector and TypeScript spec digest.
- Broker subjects are rejected by the local-home SQL CHECK (`subject kind IN ('effect','attention_action')`).

Required before PASS: P1-1 through P1-3 resolved either in SQL or by explicit scope statements, plus P2-1.
END_AUDIT