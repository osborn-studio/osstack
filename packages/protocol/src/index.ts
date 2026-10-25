// @osstack/protocol — stable cross-product / cross-process / cross-agent kernel
// contracts. Zod is the source of truth; schemas/ holds generated JSON Schema.
//
// v1 contains the shared kernel contracts (Task, Run, Event, Evidence,
// Approval, Policy, Agent command envelope) and graph JSON boundaries. Loop-state internals, knowledge
// packs, proof-pack manifests, worktree status and evaluation-spec details are
// deliberately excluded until a second consumer exists (architecture §1).

export { PROTOCOL_VERSION, ProtocolVersion } from "./version.js";
export {
  GRAPH_JSON_LIMITS,
  GraphStatusRequest, GraphDelegationStatus, GraphDeliveryUnknown,
  GraphActionState,
  GraphBudget,
  GraphContractError,
  GraphEffectIdentity,
  GraphError,
  GraphErrorCode,
  GraphIdempotencyRecord,
  GraphJsonValue,
  GraphNodeState,
  GraphRequest,
  GraphResult,
  GraphRunState,
  GraphScope,
  GraphSpec,
  GraphSpecV1,
  StartGraphRequest,
  ResumeGraphRequest,
  CancelGraphRequest,
  WorkerActionRequest,
  WorkerActionResponse,
  computeGraphEffectKey,
  computeGraphInputDigest,
  parseInboundGraphRequest,
  parseInboundWorkerActionRequest,
  validateGraphMutation,
  validateWorkerTransportRetry,
  validateWorkerActionResponse,
} from "./graph.js";
export type { AuthenticatedGraphTransportContext, ResolveAuthenticatedGraphTransport } from "./graph.js";
export { Task, TaskSource } from "./task.js";
export { RunOutcome, RunSummary } from "./run.js";
export { EventEnvelope } from "./event.js";
export { EvidenceKind, EvidenceRef } from "./evidence.js";
export { SessionContinuationRequest, SessionDecision, SessionGateKind } from "./session-continuation.js";
export {
  ContinuationGrantBody,
  ContinuationGrantStep,
  OutputCheck,
  SignedContinuationGrant,
} from "./session-continuation-grant.js";
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

export { AttentionInbox, AttentionStatus, AttentionSessionFact, AttentionWait } from "./attention.js";
export {
  GraphCheckpointRequest, GraphCheckpointResponse, GraphCheckpointTupleWire,
  GRAPH_CHECKPOINT_MAX_FRAME_BYTES, GRAPH_CHECKPOINT_MAX_TUPLE_BYTES, GRAPH_CHECKPOINT_MAX_PAGE_SIZE,
  parseGraphCheckpointRequest, parseGraphCheckpointResponse,
} from './graph-checkpoint.js';
export type { GraphCheckpointTransport } from './graph-checkpoint.js';

export {
  GRAPH_WORKER_MAX_FRAME_BYTES, GraphWorkerIdentity, GraphWorkerBinding, GraphWorkerResume, GraphWorkerMessage,
  WorkerFrameDecoder, WorkerFramedTransport, encodeWorkerFrame, workerCanonical, freezeWorkerData,
} from './graph-worker.js';

export { DeliveryContractV2, FrozenDeliveryContractV2, DeliveryVerificationReceiptV2,
  DeliveryCandidateIdentityV2, DeliveryReceiptReferenceV2, DeliveryCompletionV2,
  DeliveryPublicationScopeV2 } from "./delivery-contract.js";
export { FollowUpState, FollowUpCreateParams, FollowUpListParams, FollowUpDraftParams,
  FollowUpResolveParams, FollowUpSourceSnapshot, FollowUpObligation,
  FollowUpMutationResult, FollowUpListItem, FollowUpListResult } from "./follow-up.js";
export { FollowUpDeliveryTarget, FollowUpDeliverySubject, FollowUpDeliveryGrantBody, SignedFollowUpDeliveryGrant,
  FollowUpDeliveryEnvelope, FollowUpDeliveryReceipt, FollowUpDeliveryState, FollowUpDeliveryPrepareParams,
  FollowUpDeliveryActionParams, FollowUpDeliveryAuthorizeParams, FollowUpDeliveryRevokeParams,
  FollowUpDeliveryInspectParams, FollowUpDeliveryListParams, FollowUpDeliveryAttempt,
  FollowUpDeliveryResult, FollowUpDeliveryListItem, FollowUpDeliveryListResult } from "./follow-up-delivery.js";
export {
  EngineeringDecisionRef, EngineeringAnswer, EngineeringAdoptRequest, EngineeringObserveRequest,
  EngineeringDecideRequest, EngineeringDeferRequest, EngineeringCancelRequest,
  EngineeringEndObservationRequest, EngineeringReconcileRequest, EngineeringRpcRequests,
} from "./engineering.js";
