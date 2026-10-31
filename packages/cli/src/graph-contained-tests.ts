import { createHash } from 'node:crypto';
import type { GraphScope } from '@osstack/protocol';
import type { ContainedCommandExecutor, ContainedCommandResult, ContainedImageReceipt } from '@osstack/agents';
import { verificationCanonical, verificationObject, type VerificationBinding } from '@osstack/graph/nodes/branch';
import { prepareContainedCandidateImage, registerContainedExecution, type ContainedJournalCodec, type ContainedVerificationBinding, type ContainedVerificationOptions } from './contained-verification.js';
export type GraphContainedTestOptions = ContainedVerificationOptions;
export interface ContainedInvocation { scope: GraphScope; graphRunId: string; generation: number; effectKey: string; invocationId: string }
export interface GraphContainedTestEvidence {
  identity: ContainedInvocation & { version: 1; candidateRevision: string; artifactDigest: string; command: string; image: ContainedImageReceipt };
  result: ContainedCommandResult;
}
export interface RegisteredContainedTests {
  command: string;
  execute: (invocation: ContainedInvocation, signal: AbortSignal, authorize: () => void) => Promise<GraphContainedTestEvidence>;
  confirmStopped: (invocationId: string) => ReturnType<ContainedCommandExecutor['confirmStopped']>;
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
/** Graph journals were written with the Graph canonicalizer; keep it so they reopen byte-for-byte. */
export const graphContainedCodec: ContainedJournalCodec = { canonical: verificationCanonical, object: verificationObject };
/** GraphScope is not part of the neutral binding: it is checked by the Graph identity port instead. */
export function graphContainedBinding(binding: VerificationBinding): ContainedVerificationBinding {
  return { owner_kind: 'graph_run', owner_id: binding.graphRunId, spec_digest: binding.specHash, epoch: binding.epoch,
    candidate: { revision: binding.candidateRevision }, artifact_digest: binding.artifactDigest, acceptance_ref: binding.acceptanceRef };
}
export function prepareGraphContainedImage(options: GraphContainedTestOptions, workspace: string, revision: string, authorize: () => void) {
  return prepareContainedCandidateImage(options, workspace, revision, authorize);
}
/** Private per-registration observations; worker/model receipts never enter here. */
export function registerContainedTests(options: GraphContainedTestOptions, image: ContainedImageReceipt, binding: VerificationBinding, command: string) {
  const scope = verificationCanonical(structuredClone(binding.scope));
  const { registration, verify } = registerContainedExecution<ContainedInvocation, GraphContainedTestEvidence['identity']>(options, image, graphContainedBinding(binding), command, {
    codec: graphContainedCodec,
    matches: (invocation, fixed) => invocation.graphRunId === fixed.owner_id && verificationCanonical(invocation.scope) === scope,
    identity: (invocation, fixed) => ({ ...structuredClone(invocation), version: 1, candidateRevision: fixed.binding.candidate.revision, artifactDigest: fixed.binding.artifact_digest, command: fixed.command, image: fixed.image }),
  });
  const graph: RegisteredContainedTests = registration;
  return { registration: graph, verify: (evidence: GraphContainedTestEvidence) => verify(evidence) };
}
/** Shared identity validation for live envelopes and host-only journal reopening. */
export function validateContainedTestIdentity(value: unknown, binding: VerificationBinding, effectKey: string, command: string, contentDigest: string | undefined): GraphContainedTestEvidence['identity'] {
  const identity = verificationObject(value, ['scope', 'graphRunId', 'generation', 'effectKey', 'invocationId', 'version', 'candidateRevision', 'artifactDigest', 'command', 'image']);
  const image = verificationObject(identity.image, ['version', 'daemonId', 'baseImageId', 'imageId', 'contentDigest', 'archiveDigest', 'workingDirectory']);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if (identity.version !== 1 || identity.graphRunId !== binding.graphRunId || verificationCanonical(identity.scope) !== verificationCanonical(binding.scope)
    || identity.effectKey !== effectKey || !Number.isSafeInteger(identity.generation) || (identity.generation as number) < 1
    || typeof identity.invocationId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(identity.invocationId)
    || identity.candidateRevision !== binding.candidateRevision || identity.artifactDigest !== binding.artifactDigest || identity.command !== command
    || image.version !== 1 || typeof image.daemonId !== 'string' || !image.daemonId || image.contentDigest !== contentDigest
    || ![image.contentDigest, image.archiveDigest].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))
    || ![image.baseImageId, image.imageId].every(v => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v))
    || typeof image.workingDirectory !== 'string' || !image.workingDirectory.startsWith('/osstack-candidate-') || !uuid.test(image.workingDirectory.slice(19))) throw Error('CONTAINED_EVIDENCE_BINDING');
  return value as GraphContainedTestEvidence['identity'];
}
/** Validate the durable host envelope; this does not itself authorize recovery. */
export function validateContainedTestEvidence(value: unknown, binding: VerificationBinding, effectKey: string, command: string, contentDigest: string | undefined): GraphContainedTestEvidence {
  const v = verificationObject(value, ['identity', 'result']);
  const identity = validateContainedTestIdentity(v.identity, binding, effectKey, command, contentDigest);
  const image = identity.image;
  const result = verificationObject(v.result, ['exitCode', 'output', 'cancelled', 'evidence', 'stopReceipt']);
  const receipt = verificationObject(result.stopReceipt, ['version', 'kind', 'launch', 'confirmedAt']);
  const launch = verificationObject(receipt.launch, ['version', 'invocationId', 'specDigest', 'daemonId', 'containerId', 'nonce']);
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const specDigest = sha(JSON.stringify({ image: image.imageId, command, binding: sha(verificationCanonical(identity)), policy: 1, workingDirectory: image.workingDirectory }));
  if (receipt.version !== 1 || receipt.kind !== 'docker_removed' || !Number.isSafeInteger(receipt.confirmedAt) || (receipt.confirmedAt as number) <= 0
    || launch.version !== 1 || launch.invocationId !== identity.invocationId || launch.daemonId !== image.daemonId || launch.specDigest !== specDigest
    || typeof launch.containerId !== 'string' || !/^[a-f0-9]{64}$/.test(launch.containerId) || typeof launch.nonce !== 'string' || !uuid.test(launch.nonce)
    || result.evidence !== `docker-removed:${sha(JSON.stringify({ version: 1, kind: 'docker_removed', launch: { version: 1, invocationId: launch.invocationId, specDigest: launch.specDigest, daemonId: launch.daemonId, containerId: launch.containerId, nonce: launch.nonce }, confirmedAt: receipt.confirmedAt }))}`
    || !Number.isInteger(result.exitCode) || (result.exitCode as number) < 0 || (result.exitCode as number) > 255 || typeof result.output !== 'string' || result.output.length > 16000 || typeof result.cancelled !== 'boolean') throw Error('CONTAINED_STOP_RECEIPT_MISMATCH');
  return value as GraphContainedTestEvidence;
}
