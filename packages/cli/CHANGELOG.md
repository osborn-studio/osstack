# @osstack/cli

## 0.8.0

### Patch Changes

- Updated dependencies [89ffb4b]
  - @osstack/knowledge@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [b611e6e]
  - @osstack/knowledge@0.7.0

## 0.6.0

### Minor Changes

- fd7a88c: Add deterministic `osstack cockpit tui --fullscreen --interactive` key-sequence automation for selecting actions and quitting from the fullscreen cockpit state model.

## 0.5.0

### Minor Changes

- 13f6035: Add `osstack cockpit tui --fullscreen`, a framed cockpit workbench renderer backed by tested keyboard navigation state.

## 0.4.0

### Patch Changes

- Updated dependencies [8cc4b41]
  - @osstack/knowledge@0.4.0

## 0.3.0

### Minor Changes

- 99b17ef: Add the initial contract-validation slice. `osstack contracts check --json` validates an `osstack.contracts.json` manifest against frontend `fetch()` calls and backend routes, and generated proof packs now include `contract-validation.json` evidence.

### Patch Changes

- Updated dependencies [99b17ef]
  - @osstack/contracts@0.3.0

## 0.2.0

### Minor Changes

- Ship the osstack upgrade evidence, governance, compliance, Knowledge Cloud, cockpit, and product companion surfaces.

  - Add official Knowledge Cloud packs, indexing, ingest, cloud service, Docker/Fly/Render deployment assets, and smoke tests.
  - Add governed delivery, proof/report/scorecard/compliance evidence, PR bodies, and product companion specs.
  - Expand loop evidence, knowledge traces, cockpit reporting, checkpointing, and npm install smoke coverage.

### Patch Changes

- Updated dependencies
  - @osstack/knowledge@0.2.0
  - @osstack/compliance@0.2.0
  - @osstack/governance@0.2.0
  - @osstack/loop@0.2.0
  - @osstack/core@0.2.0
  - @osstack/agents@0.2.0
  - @osstack/github@0.2.0
  - @osstack/config@0.2.0
  - @osstack/hermes-adapter@0.2.0
  - @osstack/skill-registry@0.2.0
  - @osstack/skills@0.2.0

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
  - @osstack/agents@0.1.0
  - @osstack/config@0.1.0
  - @osstack/core@0.1.0
  - @osstack/hermes-adapter@0.1.0
  - @osstack/skill-registry@0.1.0
  - @osstack/skills@0.1.0
  - @osstack/loop@0.1.0
