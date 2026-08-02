# @osstack/protocol

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
