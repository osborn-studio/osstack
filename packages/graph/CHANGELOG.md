# @osstack/graph

## 0.23.0

### Patch Changes

- Updated dependencies [1372ecd]
- Updated dependencies [936aced]
- Updated dependencies [13bfb45]
  - @osstack/protocol@0.23.0

## 0.22.0

### Patch Changes

- Updated dependencies [0a61d27]
- Updated dependencies [c129a31]
- Updated dependencies [c48e29a]
- Updated dependencies [7e5a84d]
- Updated dependencies [63064cd]
  - @osstack/protocol@0.22.0

## 0.21.0

### Patch Changes

- 1fa74af: Add experimental bounded changeset proposal, durable invocation/apply evidence, guarded multifile application, and apply-bound artifact freezing. Preserve historical Graph v4 compiler resolution and include complete cumulative and incremental review inputs. Add canonical writer guard capabilities with retained admission on uncertainty. Production changeset executor registration remains disabled pending lifecycle and reviewer integration.

## 0.20.0

Release scope: the integrated CLI/host now supports the fixed `code-delivery-v1`
internal beta with durable actions, checkpoints, parallel candidate verification,
bounded repair and artifact-only delivery. The entries below retain the original
implementation-stage summaries; their early-stage availability notes do not
supersede the current runtime guide and compatibility limits.

### Minor Changes

- 8e1c810: Expose LangGraph's public entrypoint/task API through the isolated worker entry and verify replay of completed tasks after a sibling failure. Add bounded recovery experiments for the proposed deterministic graph backend; production broker, worker cancellation, identity binding and persistent ledger integration remain separate admission requirements.
- c1f4619: Add bounded v1 graph contracts with trusted transport identity validation, canonical request digests and stable action identities. Introduce an isolated, pinned LangGraph worker SDK entry and a restricted checkpoint codec, keeping the root entry lightweight. Public Saver experiments cover process recovery and retain a partial-abort join counterexample; production graph execution and unconditional kernel admission remain unavailable.

### Patch Changes

- f4c55ec: Align npm package repository metadata and Trusted Publisher tooling with the transferred osborn-studio/osstack repository. Existing mismatched trust mappings still require explicit operator review.
- Updated dependencies [071c1ff]
- Updated dependencies [f4c55ec]
- Updated dependencies [c1f4619]
- Updated dependencies [9011913]
- Updated dependencies [5a82b1c]
  - @osstack/protocol@0.20.0
