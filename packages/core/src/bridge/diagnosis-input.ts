import { createExternalReference, type ExternalReference } from "./external-reference.js";
import { buildInstructionSegment, type ProtectedInstructionConfig } from "./instruction-boundary.js";
import { serializeReferenceSegment } from "./reference-segment.js";

export interface DiagnosisInput {
  check_ids: readonly string[];
  failure_codes: readonly string[];
  references: readonly ExternalReference[];
}
const tools: readonly string[] = Object.freeze([]);
export function buildDiagnosisPrompt(config: ProtectedInstructionConfig, input: DiagnosisInput) {
  const references = [...input.references];
  if (input.check_ids.length || input.failure_codes.length) {
    references.unshift(createExternalReference("diagnosis.identifiers", JSON.stringify([input.check_ids, input.failure_codes])));
  }
  return {
    instruction: buildInstructionSegment(config),
    reference: serializeReferenceSegment(references),
    tools,
    permission: "read_only" as const,
  };
}
