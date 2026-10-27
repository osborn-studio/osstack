# Firstmate + pstack: J01/J11 implementation batch

Status: implementation candidate; review and CI evidence are recorded in [validation.md](validation.md).
Base: `ce543535be9b1ef96a8c4fb14d13ea8483444051` (main). Merged Firstmate roadmap PR #271: `4199d9aadf776042d924a0a307c62aef1a729088`. Upstream research pins: Firstmate `af1c6817`, pstack `99b609a7`.

## Ownership and PR sequence

The user authorized both chats to work in parallel. This chat owns J01/J11. “评估 Firstmate 对 osstack 的启发” (`01a1693a-3d49-7b92-b1b4-5344ff4ad2e7`) owns R01/R02, DEBT03 and #271. Each chat uses an isolated worktree. Only the integration owner updates the joint schedule.

| PR | Deliverable | Dependency | Merge condition |
|---|---|---|---|
| [#272 J01a](https://github.com/osborn-studio/osstack/pull/272) | strict raw JSON parser, canonical encoding, domain digests, published vectors | latest main | vector and adversarial parser tests; Sonnet review |
| [#273 J01b](https://github.com/osborn-studio/osstack/pull/273) | method, material, recovery, evidence and lifecycle contracts; opt-in package entry; JSON Schemas | [#272 J01a](https://github.com/osborn-studio/osstack/pull/272) | inherited fixtures, semantic tests, schema drift check; Sonnet review |
| [#274 J11](https://github.com/osborn-studio/osstack/pull/274) | candidate recovery DDL, full schema lineage, source hold fixture, future storage templates and verifier specification | [#273 J01b](https://github.com/osborn-studio/osstack/pull/273) | SQL fixture tests, old binary rejection, unchanged original rows; Sonnet review |

Stacked PRs must be merged in this order and retargeted after each predecessor merges. R01/R02 can develop alongside these contracts. DEBT03 is independent. Neither thread may allocate a production schema number or introduce a competing method/recovery authority. If file ownership changes, update the manifest before editing the shared path.

## Public interface and authority

Use `@osstack/protocol/joint` for the new contracts and `@osstack/protocol/joint-json` for the codec. The existing root barrel and existing DeliveryContract/Graph digest rules are unchanged. Legacy deep imports remain available through the wildcard export. The new entry is opt-in to avoid eager CLI startup cost.

External input enters through `decodeJointContract(raw)`: bounded raw text → duplicate-key/Unicode/integer validation → strict versioned Zod schema → cross-field checks. A JSON Schema artifact describes shape only; it cannot enforce every Zod refinement or raw lexical restriction. Consumers must not replace this sequence with `JSON.parse` or a shape-only validator.

Parsing does not authorize execution. Host integration must resolve principal aliases, load immutable records, recompute content digests, compare current scope/candidate/profile/owner/binding generations and perform durable CAS. `identity_assurance=host_authenticated` is an untrusted claim until matched against the host record. `authorization_ref` is a reference to a grant, not a grant itself.

Session adoption remains `observed_turn`. A MethodBinding requests `local_verified`; it is not a completion receipt. Publication and merge remain `none`. Ten material body kinds are evidence descriptions, distinct from the five host artifact receipt kinds.

## Coverage and deliberate limits

| Obligation | Implementation / acceptance |
|---|---|
| JA01 completion levels, JA02 no authority expansion | literal completion/publication/merge and executable=false constraints; inherited negative fixtures; existing engineering request remains unchanged |
| JA59 canonical digests | `joint-json.ts`; 24 positive + 5 negative audited vectors, raw duplicate keys, Unicode, -0, number bounds, arrays and cycles |
| Recipe/proposal/binding/profile | `method-binding.ts`; unique roles/checks/material requirements, primary required acceptance check, permit mode, bounded trial TTL and finance cap compatibility |
| Material bodies | `method-materials.ts`; all ten strict version-1 bodies and exact generated body schema files |
| Recovery request, receipt, proof | `joint-recovery.ts`; typed subject, subject digest, target/phase/decision matrix, effect and broker proof identity consistency |
| Independent oracle and candidate evidence | `joint-lifecycle.ts`; assigned/frozen/executed shape, distinct principal IDs, an immutable freeze custody reference, then execution-time candidate/profile/time binding. Alias resolution and authenticated results remain host work |
| Source/environment/scenario/registry identities | `joint-evidence.ts`; typed digest inputs, relative source paths and disjoint check exit sets |
| JA20/JA47 recovery storage specification | `operator-recovery-schema.md`, candidate manifest and isolated SQL tests. Actual runtime recovery remains J12 |

These tests establish contract and fixture behavior. They do not qualify a real adapter/provider, prove process containment, implement an experiment, certify production migration or establish independent human oracle authorship.

## Corrections to the audited draft

1. Recipe role materials now use `role_required_artifacts_digest`, matching Binding/context receipt and CO05. The whole recipe still has `required_artifacts_digest`. No deployed consumer exists for this draft shape.
2. The draft receipt fixtures used `cccc…` as an illustrative subject digest. Implementation fixtures recompute that field and corresponding proof bindings. Invalid-digest cases retain invalid values. The original design audit inputs remain unmodified in the research checkout.
3. Unbounded draft strings/arrays are bounded (normally 512 chars / 256 entries); the raw envelope is at most 1 MiB and depth 64. Material text has explicit 16 KiB field bounds within that envelope.
4. J11 freezes a candidate bootstrap only. J08/J10/J13 storage is represented by structural templates without reserved version numbers. Each future storage PR must regenerate its actual source/target/DDL/fixture manifest and pass its own recovery gate.

## Open questions and handoff

O06 is resolved for this batch's inspected base and #271 snapshot only. Re-fetch main and re-check #271 before submission; a conflicting change invalidates that resolution. O03 is resolved at the J11 specification level for the exact manifest bytes. It does not qualify an executable recovery build or reserve 48 for a later merge. If main advances its schema, state-owner must rebase and regenerate this candidate.

O01/O02/O04/O05 stay subject to their original later-stage gates; this batch does not imply resolution. Next: J02/J03 can consume J01; J12 implements the constrained recovery entry and fault tests; J08 first method trial waits for J03 + J07 + J12. J13 goal storage follows J12. J17 freezes broker storage and recovery independently. No J04 activation, default enablement, paid trial or production migration is included here.

## Digest API

Use schema-aware helpers instead of calling `jointDigest` on arbitrary objects: `bindingDigest`, `methodProposalDigest`, `methodRecipeDigest`, `artifactRequirementsDigest`, `checkBindingDigest`, `supportProfileDigest`, `roleRequirementsDigest`, `sourceSnapshotDigest`, `checkRegistryDigest`, `methodInputDigest`, `environmentDigest`, `scenarioDigest`, `intentDigest`, `recoverySubjectDigest` and `schemaSpecDigest`. Binding excludes only its self digest and sorts roles. Source files sort by UTF-8 path bytes. Registry entries sort by ASCII ref. Schema lineage tables sort by ASCII name. All other arrays keep declared order. Recipe/proposal/material inputs include their strict versioned fields. Raw content digests remain SHA256 of exact producer bytes; the existing DeliveryContract digest is never replaced by joint canonicalization.

## Audit-driven specification refinements

The original Sonnet 5.5 audit and exact reviewed inputs are retained under `evidence/`. The implementation fixes immutable-history REPLACE bypass, binds ledger columns to canonical receipt JSON, enforces recovery and upgrade revision chains, aligns 256-character request/effect limits, and ties each resolving proof to one record ref. Preserve-unknown receipts contain no proof. Recipe fixtures now assign independent review to the reviewer. Trial root IDs use the specified `trial-<sha256>` format.

The migration-spec v1 draft adds `source_schema_digest` and `target_schema_digest` before any deployment. The implementation digest registry in `packages/protocol/fixtures/joint/digest-catalog.json` also adds recovery request and trial consumption input domains; the archived design input stays unchanged. Python reference vectors independently verify six constructors and raw SQL/schema hashes. Source snapshots normalize file order in the digest helper and reject `.git`, normalized/case collisions, prefix conflicts, symlinks and gitlinks for this initial adoption profile. A future profile can support these only with explicit materialization checks.

Frozen oracle records no longer require a future candidate SHA. They contain the oracle digest, freeze timestamp and immutable host custody record; executed evidence adds the exact candidate/profile and checks the freeze predates creation. Host custody authentication and alias resolution remain required. `decodeJointContract` validates lexical shape and local invariants; host integrations must still recompute MethodBinding's self digest with `bindingDigest` before admission. A digest constructor's input includes a placeholder self digest only to validate the complete draft shape; the constructor excludes that field from hashing.
