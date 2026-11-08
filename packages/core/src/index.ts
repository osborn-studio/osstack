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
export { ENGINEERING_HOST_PROCESS_DDL } from "./state/engineering-host-process-ddl.js";
export { HostProcessStore, HOST_PROCESS_KINDS, HOST_PROCESS_STOP_PROOFS, type HostProcessKind, type HostProcessStopProof, type HostProcessState, type HostProcessMarker, type HostProcessLaunchInput, type HostProcessIdentity, type HostProcessOutcome, type HostProcessRecord, type HostProcessExit, type HostProcessStoreOptions } from "./state/engineering-host-process-store.js";
export { RevisionChainStore, RevisionChainError, shadowChainWriter, revisionChainUpgradeHolds, type ShadowChainWriter, type RevisionChain, type RevisionChainEvent, type RevisionReservation, type PublicationIntent, type ShadowDecisionRow, type NewChainInput, type NewLiveChainInput, type ReserveInput, type NewIntentInput, type ReplaceGrantResult, type ChildAllocation, type LaunchKind, type ReservationState, type IntentKind, type IntentState } from "./state/engineering-revision-chain-store.js";
export { ENGINEERING_REVISION_CHAIN_DDL } from "./state/engineering-revision-chain-ddl.js";
export { ENGINEERING_REVISION_GRANT_DDL } from "./state/engineering-revision-grant-ddl.js";
export { GRANT_LIMITS, LIVE_STOP_REASONS, RENEWABLE_STOP_REASONS, SAME_CHILD_RESUMABLE, REFRESHABLE_STOP_REASONS, RevisionGrantError, RevisionGrantSchema, RevisionGrantPreviewSchema, GrantBudgetSchema, canonicalJson, parseRevisionGrantPreview, previewDigest, revisionGrantSigningInput, signRevisionGrant, assembleGrant, grantPreviewOf, publicKeyFromSpkiB64, verifyRevisionGrantSignature, parseStoredGrant, resolveGrantTerms, grantSummary, grantBindsChain, type RevisionGrant, type RevisionGrantPreview, type RevisionGrantErrorCode, type GrantBudget, type GrantTerms, type GrantSummary, type GrantBinding, type LiveStopReason } from "./bridge/revision-grant.js";
export { VerificationProfileIdSchema } from "./bridge/verification-profile-id.js";
export { LocalFailureIntakeIdSchema, parseCiFailureHint, parseLocalFailureBinding, localFailureBindingFromLedger, localFailureEligibility, localVerificationReceiptDigest, type CiFailureHint, type LocalFailureBinding, type LocalFailureLedgerBinding, type LocalFailureProfileCheck, type LocalVerificationReceipt } from "./bridge/local-failure.js";
export { signLocalFailureRevisionGrant, type LocalFailureRevisionGrant, type LocalFailureGrantPreview } from "./bridge/revision-local-failure-grant.js";
export { parseStoredRevisionGrant, verifyStoredRevisionGrantSignature, type StoredRevisionGrant } from "./bridge/stored-revision-grant.js";
export { MergerShadowStore, MergerShadowError, mergerShadowWriter, EMPTY_CODES_DIGEST, type MergerShadowWriter, type MergerCycleEntry, type MergerWatermark, type MergerDecisionRow, type MergerOutcomeRow, type MergerPrRef, type MergerDecisionInput, type MergerDecisionResult, type MergerOutcomeInput, type MergerVerdictKind, type MergerOutcomeKind } from "./state/engineering-merger-store.js";
export { ENGINEERING_MERGER_DDL } from "./state/engineering-merger-ddl.js";
export { ENGINEERING_MERGER_SCAN_DDL } from "./state/engineering-merger-scan-ddl.js";
export { evaluateMergeGates, movedFields, DEFAULT_MERGE_GATE_OPTIONS, type MergeGateOptions, type MergeGateInput, type MergeGateFacts, type MergeVerdict, type MergeVerdictName, type MissionMergeEvidence, type MergeSnapshot, type MergerRegistry, type SnapshotPr, type SnapshotMarker, type SnapshotReview as MergeSnapshotReview, type SnapshotCheckRun, type SnapshotStatusRule, type SnapshotRuleset, type SnapshotPullRequestRule, type RulesetBypass } from "./bridge/merge-gates.js";
export { decideChainStep, combineFeedbackDigests, reduceReviewers, sameProducer, REVIEW_TTL_MS, type ChainView, type PrSnapshot, type SnapshotReview, type ProducerRegistry, type ProducerIdentity, type ChainDecision, type ChainMode, type ChainState, type ReviewState, type PrState, type ShadowAction, type DiscardReason, type StopReason, type NoneReason, type Discard, type DecisionOptions } from "./bridge/revision-chain.js";
export { scanStoppedChains, type StoppedPrFacts, type StoppedScanEntry, type StoppedScanReport } from "./bridge/revision-chain-stopped-scan.js";
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
