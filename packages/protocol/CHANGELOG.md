# @osstack/protocol

## 0.20.0

### Minor Changes

- 071c1ff: Add versioned session continuation requests and durable waiting diagnostics.
  Parsing an agent-reported request does not authorize automatic continuation.
  Track resumed sessions during daemon drain and
  cancellation, and preserve uncertain delivery receipts in status output.

  Keep improvement proposal identities and reviewed history stable. Gate-only checks
  no longer claim that a candidate was applied. Migration 23 preserves legacy lesson
  counters and records explicit failure observations without claiming effectiveness.

- c1f4619: Add bounded v1 graph contracts with trusted transport identity validation, canonical request digests and stable action identities. Introduce an isolated, pinned LangGraph worker SDK entry and a restricted checkpoint codec, keeping the root entry lightweight. Public Saver experiments cover process recovery and retain a partial-abort join counterexample; production graph execution and unconditional kernel admission remain unavailable.
- 5a82b1c: Add signed, finite phase continuation for the controlled no-tools planning/review
  session runtime. Bind frozen output checks and instructions to the exact session,
  runtime policy, owner key, initial turn/version, deadlines and cumulative budgets.

  Migration 24 persists grants and attempts alongside existing session receipts.
  Revoke stops subsequent actions; crash recovery never automatically resends an
  uncertain accepted delivery. Add collaborator inspect/draft/sign/install/status/revoke
  commands. This does not grant code execution, GitHub approval, merge or deployment
  powers to unrestricted agent sessions.

### Patch Changes

- a1c0471: Align npm package repository metadata and Trusted Publisher tooling with the transferred osborn-studio/osstack repository. Existing mismatched trust mappings still require explicit operator review.
- 9011913: Complete the controlled internal executable Graph beta: preserve reconciliation-only repository locks across legacy acquisition, block upgrades while graph execution remains unresolved, and explicitly reject unsupported Node/Bun graph runtimes. Batch raw Git artifact capture and restoration with independent content and protocol limits so real repository delivery completes within its existing deadline.

  Add compatibility, fault, runtime and performance verification, plus a real internal provider pilot and operations guide. Unknown external effects retain their lock and budget reservation; ready produces a candidate artifact without merging or deploying it.

## 0.15.0

### Patch Changes

- 0743a2a: Exclude compiled test and spec artifacts from npm tarballs, scan every packed workspace package for leaks, and verify release candidates against the real npm dependency graph.

## 0.13.0

### Minor Changes

- 4fb11c0: Add project-allowlisted deployment, automatic rollback and freeze, and Mac Mini guarded-autonomy operations.
- b99bbfb: Add durable R0-R4 guarded autonomy and automated R1/R2 GitHub delivery,
  including exact-base candidate pinning, diff-bound R3 approval, SHA-bound
  merged-PR recovery, and fail-closed dependency/security validation.

## Unreleased

### Minor Changes

- Add strict autonomy risk, transition, scoped approval request, and externally
  signed Ed25519 decision contracts for durable R0-R4 delivery.
- Add guarded deployment run states for staging, production health checks,
  rollback, and production freeze evidence.

## 0.10.0

### Minor Changes

- 12b6796: New package `@osstack/protocol` v1 — the bottom-layer kernel contracts shared
  cross-product / cross-process / cross-agent. Ships Zod schemas + generated JSON
  Schema for Task, RunSummary, EventEnvelope, EvidenceRef, ApprovalRequest/Decision,
  PolicyDecision, and the AgentCommand/AgentCommandResult envelope
  (AGENT_COMMAND_PROTOCOL_V1), with `PROTOCOL_VERSION = "1.0"`, producer-strict /
  consumer-lenient parsing (A-007), the A-003 status↔code mapping, and a frozen
  valid-fixture backward-compatibility corpus.

  Note: the npm package version is independent of the wire `PROTOCOL_VERSION`
  ("1.0") — package releases may advance without a wire-protocol change.
