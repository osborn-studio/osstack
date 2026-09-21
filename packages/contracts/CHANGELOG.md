# @osstack/contracts

## 0.20.0

### Patch Changes

- a1c0471: Align npm package repository metadata and Trusted Publisher tooling with the transferred osborn-studio/osstack repository. Existing mismatched trust mappings still require explicit operator review.

## 0.15.0

### Patch Changes

- 0743a2a: Exclude compiled test and spec artifacts from npm tarballs, scan every packed workspace package for leaks, and verify release candidates against the real npm dependency graph.

## 0.3.0

### Minor Changes

- 99b17ef: Add the initial contract-validation slice. `osstack contracts check --json` validates an `osstack.contracts.json` manifest against frontend `fetch()` calls and backend routes, and generated proof packs now include `contract-validation.json` evidence.
