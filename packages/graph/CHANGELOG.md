# @osstack/graph

## 0.20.0

### Minor Changes

- 8e1c810: Expose LangGraph's public entrypoint/task API through the isolated worker entry and verify replay of completed tasks after a sibling failure. Add bounded recovery experiments for the proposed deterministic graph backend; production broker, worker cancellation, identity binding and persistent ledger integration remain separate admission requirements.
- c1f4619: Add bounded v1 graph contracts with trusted transport identity validation, canonical request digests and stable action identities. Introduce an isolated, pinned LangGraph worker SDK entry and a restricted checkpoint codec, keeping the root entry lightweight. Public Saver experiments cover process recovery and retain a partial-abort join counterexample; production graph execution and unconditional kernel admission remain unavailable.

### Patch Changes

- a1c0471: Align npm package repository metadata and Trusted Publisher tooling with the transferred osborn-studio/osstack repository. Existing mismatched trust mappings still require explicit operator review.
- Updated dependencies [071c1ff]
- Updated dependencies [a1c0471]
- Updated dependencies [c1f4619]
- Updated dependencies [9011913]
- Updated dependencies [5a82b1c]
  - @osstack/protocol@0.20.0
