export { createExternalReference, restoreExternalReference, type ExternalReference } from "./external-reference.js";
export { parseVerificationResultV1, verificationDedupKey, checkTransportConclusion, checkFreshness, VERIFICATION_TTL_MS, VERIFICATION_FUTURE_SKEW_MS, type VerificationResultV1, type VerificationDedupBinding, type VerificationReasonCode, type VerificationCheck } from "./verification-result.js";
export { parseVerificationProducerPolicyV1, matchVerificationProducer, type VerificationProducerPolicyV1, type ObservedVerificationProducer } from "./verification-producer-policy.js";
export { VerificationProfileIdSchema } from "./verification-profile-id.js";
export { decideVerificationSources, verificationRegistrationState, type VerificationSourceKind, type VerificationSourceObservation, type VerificationSourceRecord, type VerificationSourceDecision } from "./verification-source-ledger.js";
export { VerificationSourceStore } from "../state/engineering-verification-source-store.js";
export { loadProtectedInstructionConfig, buildInstructionSegment, type ProtectedInstructionConfig } from "./instruction-boundary.js";
export { serializeReferenceSegment } from "./reference-segment.js";
