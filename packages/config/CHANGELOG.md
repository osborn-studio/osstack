# @osstack/config

## 0.21.0

### Patch Changes

- Updated dependencies [1fa74af]
  - @osstack/agents@0.21.0
  - @osstack/core@0.21.0

## 0.20.0

### Patch Changes

- f4c55ec: Align npm package repository metadata and Trusted Publisher tooling with the transferred osborn-studio/osstack repository. Existing mismatched trust mappings still require explicit operator review.
- Updated dependencies [071c1ff]
- Updated dependencies [f4c55ec]
- Updated dependencies [1263519]
- Updated dependencies [de4a3bb]
- Updated dependencies [9f17623]
- Updated dependencies [9011913]
- Updated dependencies [29a3a17]
- Updated dependencies [5a82b1c]
- Updated dependencies [f4de18d]
- Updated dependencies [4a2646c]
  - @osstack/agents@0.20.0
  - @osstack/core@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies [db9b69d]
  - @osstack/agents@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies [249554f]
  - @osstack/agents@0.18.0

## 0.17.0

### Patch Changes

- Updated dependencies [a007f58]
  - @osstack/core@0.17.0
  - @osstack/agents@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [ad57096]
  - @osstack/agents@0.16.0
  - @osstack/core@0.16.0

## 0.15.0

### Patch Changes

- 0743a2a: Exclude compiled test and spec artifacts from npm tarballs, scan every packed workspace package for leaks, and verify release candidates against the real npm dependency graph.
- Updated dependencies [0743a2a]
  - @osstack/agents@0.15.0
  - @osstack/core@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [619cd53]
  - @osstack/agents@0.14.0

## 0.13.1

### Patch Changes

- @osstack/agents@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [4fb11c0]
- Updated dependencies [b99bbfb]
- Updated dependencies [16ec914]
  - @osstack/core@0.13.0
  - @osstack/agents@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies [4a3dffd]
  - @osstack/core@0.12.0

## 0.11.0

### Patch Changes

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
