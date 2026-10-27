# JP-17a broker recovery storage candidate

Baseline: `d3fa7ef681efc79a5fb2dff92172ef1be0978774` (PR #279 merged). This is executable specification material for JA20's missing future broker DDL input. It is **not** J11.scoped, J17.schema_spec, J17.recovery, or deployment qualification. No migration, DB opener, daemon route or runtime registration changes.

## Physical storage decision and exact candidate identity

Propose a **dedicated SQLite database per broker**, separate from every home control-plane database. The logical namespace is `osstack.resource-broker`. The future host must explicitly configure and authenticate the broker database identity/path; this candidate allocates no deployment path. Home ownership and home schema versions cannot confer broker ownership or release authority.

The executable candidate starts with an empty catalog and SQLite `user_version=0`, then applies `schema.sql` to candidate version 1. This is a precise **offline candidate tuple**, not a globally reserved number or an existing broker migration. It does not reserve home version 48, alter the current home schema, or assert a deployed schema-0 broker exists. Its machine-readable manifest says `candidate_spec_only`, `dedicated_sqlite`, `allocation=not_reserved`, `deployment_qualified=false`, `runtime_registered=false`, and `actual_deployment_path=null`.

Before adoption, the state-owner must serialize the actual broker schema queue against the composed main and chosen deployment identity. If the physical deployment, source catalog/version, namespace, SQL or fixture changes, freeze a new candidate and qualify the exact build/target again. No existing home recovery certificate qualifies this candidate. A generic MigrationSpec parses numbers and digests; the broker namespace/deployment identity must also be checked, not inferred from the number 1.

## Real fixture material

Files are under `packages/core/fixtures/broker-recovery/`:

- `schema.sql`: executable STRICT SQLite tables, indexes and triggers; no production migration registration.
- `held-orphan.sql`: an actual FK-valid lease row in `held_orphan`, granted by broker generation 1, followed by a broker-local takeover to generation 2. The lease, invocation reference and exclusive resource obligation remain held. These identifiers are synthetic fixtures, not real provider observations.
- `catalog.json`: complete target `sqlite_master` catalog ordered by `(type,name)`, excluding SQLite-internal names starting with `sqlite_`. The source catalog is empty.
- `manifest.json`: exact bytes, candidate tuple, deployment status, full expected table list, dependency-stage declarations and independent-oracle pre-freeze digest.
- `freeze.py`: standard-library Python SQLite reproduction/check, restricted to `:memory:`. It does not open a home or existing file database. Python and the TypeScript test independently reproduce raw hashes, catalog canonical bytes and the existing schema-spec digest domain.

The registered protocol `osstack.joint.schema-spec.v1` digest covers schema change ID, adjacent candidate versions, raw DDL/fixture digests, source/target catalog digests and sorted target tables. It excludes future candidate commits/build receipts to avoid circular identity. `schema_change_id=broker-dedicated-recovery-candidate-v1` distinguishes this object from the home bootstrap. SQL raw bytes are protected by the fixture directory's `.gitattributes`; the catalog hash includes original CHECK/index/trigger SQL.

## Minimal persistence boundary

| Table | Meaning and enforced boundary |
|---|---|
| `broker_identity` | One broker identity and schema namespace/version. Only adjacent positive safe-integer owner-generation changes are allowed; identity cannot be replaced/deleted. This is a generation counter, not authenticated election or proof that the previous process stopped. |
| `broker_leases` | Immutable broker/home/scope/tenant/resource/invocation/grant-generation identity, nullable original effect identity, plus recovery revision/state projection. Null effect identity is allowed for a pre-effect lease; no synthetic effect is invented. |
| `broker_recovery_decisions` | Append-only `(principal,request)` identity, input digest, broker/lease/revision/current generation, decision and receipt bytes. Duplicate inserts are rejected before IGNORE/REPLACE/upsert can rewrite or suppress history. |

A partial unique index holds one exact exclusive `resource_key` per broker while state is `held_orphan`. This demonstrates non-release of an orphan's exact slot. It is not capacity scheduling, path-overlap normalization, fairness, routing or full JA28 qualification. Future admission must derive the canonical resource identity from trusted storage; arbitrary worker strings are not resource authorization.

`preserve_unknown` appends one decision and advances the recovery revision while preserving the orphan and exclusive slot. `proven_stopped` requires the candidate's matching broker/lease/home/scope/tenant/current generation and structurally matching containment-proof fields, then changes the projection to `resolved_stopped`. An AFTER INSERT trigger performs that projection in the same transaction; a guarded projection update cannot independently release a lease. Stop resolution seals the chain, retaining the immutable original invocation identity and all receipts. No successful product completion or original-message replay is synthesized. This schema does not implement finance/budget accounting; inherited home and future broker accounting obligations remain outside this slice.

SQL rejects skipped revisions, obsolete broker generations, cross-tuple decisions, missing/mismatched stop proof structure, direct projection mutation, history mutation and replacement. A takeover does not release any slot. A recovered slot can be reused only after the stored stop decision resolves its old lease. There is no automatic restart, resend, expiry-based release or lease-row deletion.

## Host checks that SQL cannot establish

All rows are host-owned. This fixture is not a defense against a principal with arbitrary SQL/DDL rights. Before inserting, the future recovery host must:

1. Open only the declared dedicated broker DB using a pinned recovery build; reject empty/mixed/wrong lineage outside the exact supported source/target tuple. Check the complete catalog, namespace, SQL/fixture/spec digests and build/candidate qualification. Fence live and already-open incompatible writers before enabling writes.
2. Authenticate the current operator/grant, scope and tenant. Load broker-local generation and the exact immutable lease/invocation/resource facts inside the write transaction. A home-owner token never substitutes for broker ownership.
3. Strictly decode RecoveryRequest, construct and validate RecoveryReceipt, recompute `recoverySubjectDigest` and `recoveryRequestInputDigest`, load immutable proof envelopes by trusted refs and call `verifyRecoveryProofEnvelopes`. Validate all required fields and exact kind; SQL checks a defensive subset, not the complete protocol schema or canonical digest.
4. Independently authenticate containment provenance, exact invocation/attempt identity, producer rights, current source/binding generations, freshness and evidence bytes. A matching JSON broker tuple or nonempty evidence hash does not prove the invocation stopped. Synthetic proofs in SQL tests are not admissible runtime evidence.
5. Under an owner-fenced `synchronous=FULL` transaction, compare current authority/owner/revision and insert the receipt/projection. Look up `(principal,request_id)` first: identical input returns the existing immutable receipt only after current authority checks; different input is an idempotency conflict. SQL deliberately rejects both duplicate forms, so its error is not a replay implementation.
6. Preserve all outstanding accounting and completion obligations outside this broker schema. Dedicated broker/home DBs do not offer a shared atomic transaction. Cross-home reconciliation needs independently qualified broker receipts and a future durable protocol; do not copy a broker resolution into a home completion or claim cross-database atomic release.

## Dependencies and qualification limits

Candidate material production consumes existing recovery contracts and can provide bytes to JA20's contract/dependency investigation before J17 is qualified. The original gate order remains: J17.schema_spec requires J11.scoped; J17.recovery requires J17.schema_spec and J12.scoped; runtime broker storage/routing requires the broker recovery stage and the remaining J17 dependencies. **Recovery must not depend on starting the controller that installs this schema.** This manifest's stage declarations explain that separation; they do not edit or pass the central graph.

JA20's oracle still needs the home DDL/old Attention hold, this broker input, the reviewed dependency graph and its cycle-negative trace. Candidate presence is not a recovery certificate. The separately frozen oracle digest records prospective test inputs, not authenticated independent principals or a retroactive qualification of merged work.

Current tests execute real in-memory SQLite and rollback injected transactions. They do not test process death, file-backed WAL/FULL durability, old binary/open-writer fencing, real operator authentication, provider containment, deployment, or cross-home reconciliation. These remain J12/J17 recovery obligations. No J11/J17 gate is marked PASS.

## Reproduce this specification

With Node 22 and an explicit scratch OSSTACK_HOME, install the lockfile and build `@osstack/protocol`. Run `pnpm --filter @osstack/core exec vitest run src/state/broker-recovery-spec.test.ts`. Independently run `python3 -I packages/core/fixtures/broker-recovery/freeze.py --check`. To intentionally change candidate bytes, edit/review the SQL then run the same Python script without `--check`; never treat regeneration as qualification.

The implementation owner writes this candidate; an independent agent froze its oracle before receiving the candidate. The archived oracle digest and later independent execution are evidence of process separation only. Trusted principal identity, safety review and central gate custody remain the main project's explicit responsibility.
