# @osstack/protocol

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
