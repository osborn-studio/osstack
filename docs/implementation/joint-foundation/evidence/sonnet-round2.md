# Incomplete CLI report: missing beginning; not accepted as approval

live `src` still catches drift, so regenerate through a script that builds first and fails if `dist` is older than `src`.
- The three trailing `it` blocks in the spec test (lines 111 and 126) sit outside the `describe`. This is cosmetic, but they would be skipped by any `describe`-scoped filter.
- `joint_method_active` has no negative-path test that uses a correctly typed pointer, and no positive-path test either. Add a positive insert with a `binding` and a `qualification` object to prove the composite FKs accept the right kinds.
- `digest-catalog.json` says every domain's input is "see README", but the README does not spell out the input shape for `recoveryRequestInputDigest` or `trialConsumptionInputDigest`. List each domain's exact input keys in the catalog, since the design names it the sole registry.
- `decodeJointContract` uses a plain `z.union` over 23 schemas. Failures return a diagnostic from every branch, which is noisy. Switch to `z.discriminatedUnion('kind', …)` where the superRefine'd members allow it, or select the schema by `kind` before parsing.

## 4. J12/J17 obligations (outside this batch, not defects)

- The live-open path must verify the full catalog digest on every recovery open. SQL triggers cannot stop `DROP TRIGGER`, `DROP TABLE` or `writable_schema` from a connection that holds write access.
- Fencing, `synchronous=FULL` on the real open path, and file-backed WAL kill tests.
- Proof loading and authentication: candidate, build, schema and profile binding must come from host records, since the envelope carries none of them.
- Requiring each subject's `home_id` to equal the trusted `daemon_owner` home, and requiring the subject kind to match the trusted record. Otherwise one hold addressed as `effect` and as `attention_action` forks into two revision chains.
- Broker-side ledger, and splitting the overloaded `owner_generation` and `actual_target_schema` fields before J17. `broker_identity.schema` is currently compared with the home-target schema field.
- A migrated 48 and a bootstrapped 48 must be schema-identical. Otherwise a later registered migration 48 is skipped on bootstrapped databases. Today the lineage check fails closed, which leaves the recovered database stranded.
- The `CURRENT_SCHEMA_VERSION===47` assertion will turn unrelated schema PRs red, and the state-owner checklist must name this test.

## 5. Verdict

**APPROVE WITH CONDITIONS.** All fourteen prior findings are verified in the source as fixed or as accepted with a documented reason. Blocking before the DDL, manifest and vectors are treated as frozen:
- Finding 1 (legacy and broker identities).
- Finding 2 (JSON typing in the CHECK; this changes `ddl_digest`).
- Finding 3 (Python check wiring and PR placement).
- Finding 4 (mutation coverage).

Fixing findings 1-4 requires one regeneration of `ddl_digest`, `schema_spec_digest` and `reference-vectors.json`. Run `freeze.mjs` once, then the Python check, then the full protocol and SQL suites. Findings 5-11 can follow in J01b or in the first consumer PR. The codec itself (`joint-json.ts`) shows no remaining defect in the claims it makes.

I could not confirm the hash values, the 452 and 8 test totals, or the pending CLI re-run. Treat those as unverified until the full serial run is green.

END_AUDIT
