export { createExternalReference, restoreExternalReference, type ExternalReference } from "./external-reference.js";
export { parseVerificationResultV1, verificationDedupKey, checkTransportConclusion, checkFreshness, VERIFICATION_TTL_MS, VERIFICATION_FUTURE_SKEW_MS, type VerificationResultV1, type VerificationDedupBinding, type VerificationReasonCode, type VerificationCheck } from "./verification-result.js";
export { parseVerificationProducerPolicyV1, matchVerificationProducer, type VerificationProducerPolicyV1, type ObservedVerificationProducer } from "./verification-producer-policy.js";
export { VerificationProfileIdSchema } from "./verification-profile-id.js";
export { decideVerificationSources, verificationRegistrationState, type VerificationSourceKind, type VerificationSourceObservation, type VerificationSourceRecord, type VerificationSourceDecision } from "./verification-source-ledger.js";
export { VerificationSourceStore } from "../state/engineering-verification-source-store.js";
export { loadProtectedInstructionConfig, buildInstructionSegment, type ProtectedInstructionConfig } from "./instruction-boundary.js";
export { serializeReferenceSegment } from "./reference-segment.js";
export { DiagnosisStore, diagnosisCanAdmit, diagnosisProfile, type DiagnosisRequest, type HostReceipt, type DiagnosisAdmission, type DiagnosisFacts, type DiagnosisRegistration } from "../state/engineering-diagnosis-store.js";
export { classifyDiagnosis, verifyDiagnosisGrant, checkGrantPrincipal, checkGrantWindow, type DiagnosisProfile, type DiagnosisReason, type DiagnosisVerdict, type ExpectedFailure, type DiagnosisGrantInput } from "./diagnosis-admission.js";
export { buildDiagnosisPrompt, type DiagnosisInput } from "./diagnosis-input.js";
export { parseLocalFailureRevisionGrant } from "./revision-local-failure-grant.js";
export { LocalFailureDispatchStore, type DispatchInput, type DispatchReason, type DispatchFault, type PublicationFence, type RepairBinding } from "../state/engineering-local-failure-dispatch-store.js";
export { buildRepairGoal, createLocalFailureRepairInput, type LocalFailureRepairInput } from "./repair-input.js";
export { classifyRecheck, parseRecheckResult, type ActionsAttemptFact, type HostRecheckProof, type RecheckBinding,
  type RecheckInputs, type RecheckMissing, type RecheckResult, type RecheckVerdict } from "./recheck.js";
export { LocalFailureRecheckStore, type LocalFailureRecheck, type RecheckEvaluation } from "../state/engineering-local-failure-recheck-store.js";
