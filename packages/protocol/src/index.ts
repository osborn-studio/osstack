// @osstack/protocol — stable cross-product / cross-process / cross-agent kernel
// contracts. Zod is the source of truth; schemas/ holds generated JSON Schema.
//
// v1 contains ONLY the shared kernel contracts (Task, Run, Event, Evidence,
// Approval, Policy, Agent command envelope). Loop-state internals, knowledge
// packs, proof-pack manifests, worktree status and evaluation-spec details are
// deliberately excluded until a second consumer exists (architecture §1).

export { PROTOCOL_VERSION, ProtocolVersion } from "./version.js";
export { Task, TaskSource } from "./task.js";
export { RunOutcome, RunSummary } from "./run.js";
export { EventEnvelope } from "./event.js";
export { EvidenceKind, EvidenceRef } from "./evidence.js";
export {
  Actor,
  ApprovalDecision,
  ApprovalRequest,
  Risk,
} from "./approval.js";
export {
  AUTONOMY_EMPTY_DIFF_SHA256,
  AutonomyApprovalPhase,
  AutonomyRiskDecision,
  AutonomyRiskLevel,
  AutonomyRiskPhase,
  AutonomyRiskSignal,
  AutonomyRunState,
  parseInboundAutonomyRiskDecision,
  parseInboundScopedApprovalDecision,
  parseInboundScopedApprovalRequest,
  ScopedApprovalDecision,
  ScopedApprovalDecisionPayload,
  ScopedApprovalDecisionValue,
  ScopedApprovalRequest,
  validateScopedApprovalDecisionForRequest,
} from "./autonomy.js";
export {
  CostTier,
  PolicyCandidate,
  PolicyDecision,
  PolicyHandoff,
  PolicyOutcome,
  PolicyScore,
} from "./policy.js";
export {
  AgentCommand,
  AgentCommandResult,
  AgentCommandResultObject,
  CommandError,
  CommandName,
  CommandScope,
  CommandStatus,
  ErrorCode,
  NextAction,
  parseInboundAgentCommand,
  parseInboundAgentCommandResult,
} from "./envelope.js";
