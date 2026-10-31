// @osstack/core — orchestration engine.

// Namespaced adoption of the cross-process kernel contracts (R1.2). Namespaced
// (not `export *`) so protocol's Task/PolicyDecision cannot collide with core's
// own persistence-projection types.
export * as protocol from "@osstack/protocol";

export * from "./capability.js";
export { evaluateBehaviorRegistry } from "./behavior-registry.js";
export type { BehaviorRegistryInput, BehaviorRegistryTrust, BehaviorRegistryPolicy, BehaviorRegistryEntry, BehaviorRegistrySnapshot, BehaviorRegistryEvaluationContext } from "./behavior-registry.js";
export * from "./state/index.js";
export * from "./state/protocol-mappers.js";
export * from "./privacy/index.js";
export * from "./orchestrator/index.js";
export * from "./policy/index.js";
export * from "./hermes/index.js";
export * from "./kanban/index.js";
export * from "./kg/index.js";
export * from "./observability/index.js";

export const CORE_VERSION = "0.0.0";
export { CURRENT_SCHEMA_VERSION } from "./state/migrations.js";

export { AttentionStore, attentionDigest, type AttentionOwner, type AttentionScope, type AttentionItem } from "./state/attention-store.js";
export { AttentionObserver } from "./state/attention-observer.js";
export { readAttentionRecovery, type AttentionRecoveryRequest, type AttentionRecoverySubject } from "./state/attention-recovery-view.js";
export { AttentionActions, reserveSessionInstruction } from "./state/attention-actions.js";
export { EngineeringStore, engineeringSourceIdentity, type EngineeringPrincipal, type EngineeringMission, type EngineeringWait, type EngineeringActionReceipt, type EngineeringStopResult, type EngineeringObservationProof, type EngineeringDispatchPermit, type EngineeringHostEvidence } from "./state/engineering-store.js";
export { getEngineeringDispatchPhase, isEngineeringCancelledBeforeDispatch, type EngineeringDispatchPhase } from "./state/engineering-dispatch.js";
export { ContainedMissionStore, containedUpgradeHolds, type ContainedMission, type ContainedMissionState, type ContainedEvent, type WorkspaceClaim, type ContainedAuthorizeInput, type ContainedTransition } from "./state/engineering-contained-store.js";
export { AttentionExperience, type AttentionSender, type AttentionPosture, type AttentionPostureResult } from "./state/attention-experience.js";
export { readAttentionReturnBrief, type AttentionReturnBrief, type AttentionReturnBriefInput, type ReturnBriefSection, type ReturnBriefWaiting, type ReturnBriefOpened, type ReturnBriefResolved, type ReturnBriefDeliveryProblem } from "./state/attention-return-brief.js";
export { parseAttentionReminderPolicy, type AttentionReminderPolicy } from "./state/attention-reminders.js";
export { classifyAttentionWait, evaluateCoverage, evaluateActivity, type WaitInput } from './attention.js';
export { GraphRunStore, GraphRunStorageError } from "./state/graph-runs.js";
export { GraphActionStore, GraphActionStorageError } from "./state/graph-actions.js";
export type {
  GraphActionAdmission, GraphActionOutcomeInput, GraphActionOutcome, GraphActionUncertainty,
  GraphAction, GraphActionBudget, GraphActionResult, GraphActionStorageErrorCode,
} from "./state/graph-actions.js";
export type {
  GraphProgramVersion, GraphProgramIdentity, GraphStoppedWorkerEvidence,
  GraphRunFence, GraphLeaseAcquisition, GraphLeaseRenewal, GraphRunProjection,
  GraphRun, GraphRunStorageErrorCode,
} from "./state/graph-runs.js";
export { readRepositoryGit } from "./graph/repository-git.js";
export { resolveRepositoryScope } from "./graph/repository-scope.js";
export type { RepositoryScope } from "./graph/repository-scope.js";
export { GraphCheckpointStore } from './state/graph-checkpoints.js';

export * from "./scratch.js";

export { deliveryContractDigest, deliveryCheckReference, freezeDeliveryContract,
  assertFrozenDeliveryContract, resolveDeliveryContractChecks, assertDeliveryContractAdmission,
  assertDeliveryContractPaths, verifyDeliveryContractReceipt, promoteDeliveryScout } from "./delivery-contract.js";
export { FollowUpObligationService, FollowUpError, FOLLOW_UP_ERROR_CODES, FOLLOW_UP_MAX_BYTES, serializeFollowUp } from "./state/follow-up-obligations.js";
export { FollowUpDeliveryService, FollowUpDeliveryError, FOLLOW_UP_DELIVERY_ERRORS, deliveryCanonical, serializeFollowUpDelivery } from "./state/follow-up-delivery.js";
export type { FollowUpDeliveryTrust, FollowUpTransport, FollowUpDeliveryOptions } from "./state/follow-up-delivery.js";
export { SourceObservationLedger, SourceObservationScopeSchema, SourceSnapshotEvidenceSchema, type SourceObservationScope, type SourceObservation, type SourceSnapshotEvidence } from './state/source-observations.js';
