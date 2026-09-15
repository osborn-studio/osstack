import { WorkerActionRequest } from '@osstack/protocol';
import { parseVerificationBinding, verificationObject, verificationBranchFromResponse, type VerificationBinding, type VerificationRequestInput } from './branch.js';
export interface ReviewReport { schemaVersion: 1; verdict: 'accept' | 'changes_requested'; summary: string; findings: string[] }
export function parseReviewReport(value: unknown): ReviewReport {
  const report = verificationObject(value, ['schemaVersion', 'verdict', 'summary', 'findings']);
  if (report.schemaVersion !== 1 || !['accept', 'changes_requested'].includes(String(report.verdict))
    || typeof report.summary !== 'string' || !report.summary.trim() || report.summary.length > 8192
    || !Array.isArray(report.findings) || report.findings.length > 64 || report.findings.some(item => typeof item !== 'string' || !item.trim() || item.length > 4096)) throw new Error('OUTPUT_CONTRACT_INVALID: review report');
  // Bound the serialized business report so the host can retain it alongside
  // invocation/stop evidence in a 64 KiB envelope, including JSON escaping.
  if (new TextEncoder().encode(JSON.stringify(report)).length > 8192) throw new Error('OUTPUT_CONTRACT_INVALID: review report exceeds 8192 UTF-8 bytes');
  return structuredClone(value) as ReviewReport;
}
export function createReviewRequest(input: VerificationRequestInput): WorkerActionRequest {
  const binding = parseVerificationBinding(input.binding);
  return WorkerActionRequest.parse({ schemaVersion: 1, kind: 'worker_action', requestId: input.requestId, generation: input.generation,
    scope: binding.scope, graphRunId: binding.graphRunId, specHash: binding.specHash, epoch: binding.epoch, nodeId: input.nodeId, effectSlot: input.effectSlot,
    action: { kind: 'review', candidateRevision: binding.candidateRevision, acceptanceRef: binding.acceptanceRef, workspaceLeaseRef: input.workspaceLeaseRef } });
}
export function validateReviewResponse(binding: VerificationBinding, request: unknown, response: unknown) {
  if (WorkerActionRequest.parse(request).action.kind !== 'review') throw new Error('INPUT_CONTRACT_INVALID: expected review');
  return verificationBranchFromResponse(binding, request, response);
}
