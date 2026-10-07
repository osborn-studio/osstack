# @osstack/agents

## 0.21.0

### Minor Changes

- 1fa74af: Add experimental bounded changeset proposal, durable invocation/apply evidence, guarded multifile application, and apply-bound artifact freezing. Preserve historical Graph v4 compiler resolution and include complete cumulative and incremental review inputs. Add canonical writer guard capabilities with retained admission on uncertainty. Production changeset executor registration remains disabled pending lifecycle and reviewer integration.

### Patch Changes

- Updated dependencies [1fa74af]
  - @osstack/core@0.21.0
  - @osstack/hermes-adapter@0.21.0

## 0.20.0

### Minor Changes

- 071c1ff: Add versioned session continuation requests and durable waiting diagnostics.
  Parsing an agent-reported request does not authorize automatic continuation.
  Track resumed sessions during daemon drain and
  cancellation, and preserve uncertain delivery receipts in status output.

  Keep improvement proposal identities and reviewed history stable. Gate-only checks
  no longer claim that a candidate was applied. Migration 23 preserves legacy lesson
  counters and records explicit failure observations without claiming effectiveness.

- de4a3bb: Require valid adapter terminal events, propagate bounded cancellation with explicit stop evidence, and confirm owned command process-group exits. Add an authorized single-implementation entry point for future executable graph orchestration while retaining legacy Loop delivery behavior and preventing retries of unconfirmed executions.
- 5a82b1c: Add signed, finite phase continuation for the controlled no-tools planning/review
  session runtime. Bind frozen output checks and instructions to the exact session,
  runtime policy, owner key, initial turn/version, deadlines and cumulative budgets.

  Migration 24 persists grants and attempts alongside existing session receipts.
  Revoke stops subsequent actions; crash recovery never automatically resends an
  uncertain accepted delivery. Add collaborator inspect/draft/sign/install/status/revoke
  commands. This does not grant code execution, GitHub approval, merge or deployment
  powers to unrestricted agent sessions.

### Patch Changes

- f4c55ec: Align npm package repository metadata and Trusted Publisher tooling with the transferred osborn-studio/osstack repository. Existing mismatched trust mappings still require explicit operator review.
- 29a3a17: Execute digest-approved low-risk improvement proposals in a retained candidate worktree with independent structured review, exact file boundaries, replay-safe execution records, and hashed evidence. Candidate verification does not mark a proposal applied or prove effectiveness. Add strict Codex completion and per-run execution environment support.
- Updated dependencies [071c1ff]
- Updated dependencies [f4c55ec]
- Updated dependencies [1263519]
- Updated dependencies [c1f4619]
- Updated dependencies [9f17623]
- Updated dependencies [9011913]
- Updated dependencies [29a3a17]
- Updated dependencies [5a82b1c]
- Updated dependencies [f4de18d]
- Updated dependencies [4a2646c]
  - @osstack/protocol@0.20.0
  - @osstack/core@0.20.0
  - @osstack/governance@0.20.0
  - @osstack/hermes-adapter@0.20.0

## 0.19.0

### Minor Changes

- db9b69d: Add a Z-Code CLI adapter for running coding tasks with GLM through the locally authenticated Z-Code desktop CLI.

## 0.18.0

### Minor Changes

- 249554f: Add a fixed, bounded `deepseek-no-tools` semantic judge profile, route neat
  semantic and dependency judgments through a shared
  provider registry, and make semantic parity readiness provider-neutral.
  Provider responses now fail closed when the reported model identity differs
  from the requested model.
  Propagate sanitized, closed-registry provider failure codes through semantic
  coverage reports and live diagnostics without exposing provider response bodies
  or exception text. Classify output-token exhaustion, content filtering, and
  provider resource interruption separately while retaining a safe unknown
  finish-reason fallback.

### Patch Changes

- Updated dependencies [249554f]
  - @osstack/governance@0.18.0

## 0.17.0

### Patch Changes

- a007f58: Lazy-load heavy optional dependencies to cut CLI startup module-load cost from ~324ms to ~190ms.

  - `@osstack/agents`: the claude-code adapter now imports `@anthropic-ai/claude-agent-sdk` (grpc/opentelemetry/protobufjs tree, ~150ms) on first `query()` call instead of at module load. Import failures surface through the existing event contracts (`session.terminal failed` / `adapter_threw`), abort is re-checked after the import window, and a failed load is not memoized so later calls can retry.
  - `@osstack/core`: **BREAKING** — `initOtel()` changed from `void` to `Promise<void>`. The OTel NodeSDK/OTLP exporter modules (~100ms) now load lazily inside `initOtel()`, so consumers that never enable tracing skip the cost. Callers must `await initOtel(...)`; un-awaited calls compile-error under `@typescript-eslint/no-floating-promises` and would otherwise start tracing asynchronously (early spans dropped).
  - `@osstack/cli`: daemon startup awaits `initOtel(...)`.

- Updated dependencies [a007f58]
  - @osstack/core@0.17.0
  - @osstack/hermes-adapter@0.17.0

## 0.16.0

### Minor Changes

- ad57096: Add governed, durable Codex and Claude session relay support with resumable native session identity, optimistic concurrency, idempotent inbound messages, bounded recovery diagnostics, and repository-context preservation.

### Patch Changes

- Updated dependencies [9cc8a37]
- Updated dependencies [ad57096]
  - @osstack/governance@0.16.0
  - @osstack/core@0.16.0
  - @osstack/hermes-adapter@0.16.0

## 0.15.0

### Patch Changes

- 0743a2a: Exclude compiled test and spec artifacts from npm tarballs, scan every packed workspace package for leaks, and verify release candidates against the real npm dependency graph.
- Updated dependencies [0743a2a]
- Updated dependencies [35141a8]
- Updated dependencies [be6cc63]
  - @osstack/core@0.15.0
  - @osstack/governance@0.15.0
  - @osstack/hermes-adapter@0.15.0

## 0.14.0

### Patch Changes

- 619cd53: Run Codex adapters in each task's repository worktree, keep truncated verifier
  summaries Unicode-safe for strict JSON readers, and add workspace, changed, and
  Git-baseline scopes to Loop governance.

## 0.13.1

### Patch Changes

- Updated dependencies [733c82a]
  - @osstack/governance@0.13.1

## 0.13.0

### Minor Changes

- b99bbfb: Add durable R0-R4 guarded autonomy and automated R1/R2 GitHub delivery,
  including exact-base candidate pinning, diff-bound R3 approval, SHA-bound
  merged-PR recovery, and fail-closed dependency/security validation.
- 16ec914: Add a first-class Kimi Code adapter and fail-closed structured reviewer verification.

### Patch Changes

- Updated dependencies [4fb11c0]
- Updated dependencies [b99bbfb]
  - @osstack/core@0.13.0
  - @osstack/hermes-adapter@0.13.0

## Unreleased

### Minor Changes

- Add a first-class, no-tool Kimi Code reviewer/release verifier with strict
  structured output, authenticated three-state readiness diagnostics, bounded
  execution, minimal child environments, and runtime identity evidence.
- Mark Kimi provider/model identity as reported only when the authenticated
  provider probe reports the exact invocation provider and default model.

## 0.12.0

### Minor Changes

- 4a3dffd: Make knowledge-hygiene ReportV2 the default `neat check` contract, add honest
  coverage and assessment scope, evidence-bound semantic auditing, recoverable
  memory and narrative transactions, append-only V2 lifecycle history, and
  cross-repository dependency obligations with an isolated no-tools judge.
  Explicit `--schema-version 1` remains available for one minor release and now
  emits a deprecation warning.

### Patch Changes

- Updated dependencies [4a3dffd]
  - @osstack/core@0.12.0
  - @osstack/governance@0.12.0
  - @osstack/hermes-adapter@0.12.0

## 0.11.0

### Minor Changes

- 9f1aa1b: Carry strict verifier-reported implementation deviations through Loop events and idempotently register evidence-bound `mid_build` probe items for linked tasks.

### Patch Changes

- ac50008: Align the Claude agent adapter with its Zod 4 peer contract and update the skill registry YAML parser to a patched release.
- Updated dependencies [f041063]
- Updated dependencies [a483f6e]
- Updated dependencies [4a6c00b]
- Updated dependencies [83aac82]
- Updated dependencies [223a240]
- Updated dependencies [9f1aa1b]
  - @osstack/core@0.11.0
  - @osstack/hermes-adapter@0.11.0

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
  - @osstack/hermes-adapter@0.10.0

## 0.9.0

### Minor Changes

- a6f2075: Loop Engineering upgrade (Increments A–E): first-class evaluation specs with
  per-spec verifier results (`--verify` and artifact gates become implicit
  specs), feedback-carrying iteration with no-progress escalation, discovery
  governance (`--discovery-policy`), budget/stop controls
  (`--max-runtime-ms`/`--max-tokens`/`--max-cost-usd`/`--no-progress-limit`,
  exit code 2 on budget), and SOP lesson drafts with an
  `osstack loop lessons list|show|promote|discard` review workflow. DeepSeek
  ds-review/ds-verify now judge evaluation specs per-spec via
  `OSSTACK_EVALUATION_SPECS_FILE`/`OSSTACK_EVALUATIONS`. All additive and
  opt-in; existing CLI behavior is unchanged.

## 0.2.0

### Minor Changes

- Ship the osstack upgrade evidence, governance, compliance, Knowledge Cloud, cockpit, and product companion surfaces.

  - Add official Knowledge Cloud packs, indexing, ingest, cloud service, Docker/Fly/Render deployment assets, and smoke tests.
  - Add governed delivery, proof/report/scorecard/compliance evidence, PR bodies, and product companion specs.
  - Expand loop evidence, knowledge traces, cockpit reporting, checkpointing, and npm install smoke coverage.

### Patch Changes

- Updated dependencies
  - @osstack/core@0.2.0
  - @osstack/hermes-adapter@0.2.0

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
  - @osstack/hermes-adapter@0.1.0
