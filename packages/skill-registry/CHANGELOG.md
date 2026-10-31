# @osstack/skill-registry

## 0.23.0

### Minor Changes

- 936aced: Add bounded offline inspection of pinned Git source objects through the opt-in source-snapshot entry. Results bind content hashes and explicit incomplete-dependency and caller-asserted identity markers; they do not activate skills or authorize execution.

### Patch Changes

- 43db3e1: Wait for Git output streams to close before interpreting tracked skill refs. Preserve command deadlines while output is still pending so a valid delayed ref is not misclassified as missing.
- 2389dcd: Assemble bounded, explicitly declared source component candidates from retained inspections. Recheck component identity, dependency closure and digests without installation or activation.
- a9a4511: Compile a deterministic, non-executable bug-fix proposal and supply explicitly pinned method materials through the existing local execution context. Reject missing, changed, over-budget or wrong-task material before adapter invocation; retain ordinary delivery authorization and verification controls.
- 52d7730: Preserve an explicitly registered Git subtree and independent package version in source manifests. Reject unknown fields instead of silently dropping misspelled pins. Registration does not activate a subtree or change update adoption.
- Updated dependencies [1372ecd]
- Updated dependencies [85e19da]
- Updated dependencies [eb35fbb]
- Updated dependencies [936aced]
- Updated dependencies [13bfb45]
- Updated dependencies [b5f2f93]
- Updated dependencies [7939a10]
  - @osstack/protocol@0.23.0
  - @osstack/core@0.23.0

## 0.22.0

### Patch Changes

- Updated dependencies [0a61d27]
- Updated dependencies [c8dc83f]
- Updated dependencies [c129a31]
- Updated dependencies [c48e29a]
- Updated dependencies [3d5fdc0]
- Updated dependencies [7e5a84d]
- Updated dependencies [63064cd]
- Updated dependencies [b185daa]
  - @osstack/core@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [1fa74af]
  - @osstack/core@0.21.0

## 0.20.0

### Patch Changes

- f4c55ec: Align npm package repository metadata and Trusted Publisher tooling with the transferred osborn-studio/osstack repository. Existing mismatched trust mappings still require explicit operator review.
- Updated dependencies [071c1ff]
- Updated dependencies [f4c55ec]
- Updated dependencies [1263519]
- Updated dependencies [9f17623]
- Updated dependencies [9011913]
- Updated dependencies [29a3a17]
- Updated dependencies [5a82b1c]
- Updated dependencies [f4de18d]
- Updated dependencies [4a2646c]
  - @osstack/core@0.20.0

## 0.17.0

### Patch Changes

- Updated dependencies [a007f58]
  - @osstack/core@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [ad57096]
  - @osstack/core@0.16.0

## 0.15.0

### Patch Changes

- 0743a2a: Exclude compiled test and spec artifacts from npm tarballs, scan every packed workspace package for leaks, and verify release candidates against the real npm dependency graph.
- Updated dependencies [0743a2a]
  - @osstack/core@0.15.0

## 0.13.0

### Patch Changes

- Updated dependencies [4fb11c0]
- Updated dependencies [b99bbfb]
  - @osstack/core@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [4a3dffd]
  - @osstack/core@0.12.0

## 0.11.0

### Patch Changes

- ac50008: Align the Claude agent adapter with its Zod 4 peer contract and update the skill registry YAML parser to a patched release.
- Updated dependencies [f041063]
- Updated dependencies [a483f6e]
- Updated dependencies [4a6c00b]
- Updated dependencies [83aac82]
- Updated dependencies [223a240]
- Updated dependencies [9f1aa1b]
  - @osstack/core@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [1b48a7d]
- Updated dependencies [daeb3c4]
- Updated dependencies [7396e6f]
- Updated dependencies [6a4a9d4]
- Updated dependencies [3223420]
- Updated dependencies [392f8b0]
- Updated dependencies [99ca3b4]
  - @osstack/core@0.10.0

## 0.2.0

### Patch Changes

- Updated dependencies
  - @osstack/core@0.2.0

## 0.1.0

### Minor Changes

- 45b3b78: Initial public release (0.1.0): engineering hardening + self-update.

  - Version is read from package.json instead of hardcoded `0.0.0`; daemon and
    CLI exchange `protocol_version` on connect.
  - `osstack upgrade` self-update command: registry check → state.db backup →
    daemon drain/shutdown → `npm i -g` → restart → health check → automatic
    rollback on failure. `osstack status` shows the version handshake and
    update availability.
  - Daemon probes the npm registry once per 24h (disable: OSSTACK_UPDATE_CHECK=0)
    and surfaces `update_available` in `health`.
  - Daemon pidfile guard refuses duplicate instances; socket moved from
    /tmp/osstack.sock to ~/.osstack/daemon.sock.
  - Hermes binary resolution no longer hardcodes a machine-specific path
    (use HERMES_BIN or HERMES_AGENT_HOME).
  - launchd templates: ai.osstack.autoupgrade weekly self-update job.
  - Biome linting, GitHub Actions CI, daemon RPC smoke tests.

### Patch Changes

- Updated dependencies [45b3b78]
  - @osstack/core@0.1.0
