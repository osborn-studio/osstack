import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { assertDeliveryContractAdmission, assertDeliveryContractPaths, assertFrozenDeliveryContract, deliveryCheckReference, deliveryContractDigest } from '@osstack/core';
import { FrozenDeliveryContractV2, GraphBudget, StartGraphRequest, freezeWorkerData, workerCanonical } from '@osstack/protocol';
import type { AcceptanceCommandSpec } from './graph-verification-store.js';

export interface GraphContractHostPolicy {
  policyDigest: string;
  reviewPolicyRef: string;
  limits: StartGraphRequest['spec']['limits'];
}
export interface GraphDeliveryContractRegistration {
  frozen: FrozenDeliveryContractV2;
  policy: GraphContractHostPolicy;
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.string().min(1).max(256);
const limits = z.unknown().transform((value, ctx): GraphContractHostPolicy['limits'] => {
  const parsed = GraphBudget.safeParse(value && typeof value === 'object' && !Array.isArray(value) ? { ...value, schemaVersion: 1 } : null);
  if (!parsed.success) { ctx.addIssue({ code: 'custom', message: 'graph contract policy limits' }); return z.NEVER; }
  const { schemaVersion: _version, ...result } = parsed.data; return result;
});
const policySchema = z.object({ policyDigest: digest, reviewPolicyRef: reference, limits }).strict();
const acceptanceSchema = z.object({ ref: reference, command: z.string().min(1).max(8192),
  passExitCodes: z.array(z.number().int().min(0).max(255)), failExitCodes: z.array(z.number().int().min(0).max(255)) }).strict();
const envelopeSchema = z.object({ schemaVersion: z.literal(1), sourceInputArtifactRef: reference,
  frozen: FrozenDeliveryContractV2, policy: policySchema, acceptance: acceptanceSchema }).strict();
export type GraphContractHostEnvelope = z.infer<typeof envelopeSchema>;

export function parseGraphContractRegistration(value: unknown): GraphDeliveryContractRegistration {
  const parsed = z.object({ frozen: FrozenDeliveryContractV2, policy: policySchema }).strict().parse(value);
  return freezeWorkerData({ ...parsed, frozen: assertFrozenDeliveryContract(parsed.frozen) });
}

/** Host policy is already authorized by the registration. This function grants nothing. */
export function bindGraphDeliveryContract(requestValue: StartGraphRequest, registration: {
  repositoryPath: string; task: string; acceptanceRegistry: readonly AcceptanceCommandSpec[];
  deliveryContract: GraphDeliveryContractRegistration;
}): { request: StartGraphRequest; envelope: GraphContractHostEnvelope } {
  const request = StartGraphRequest.parse(requestValue);
  const { frozen, policy } = parseGraphContractRegistration(registration.deliveryContract);
  const contract = frozen.contract;
  if (contract.mode !== 'implement' || contract.requested_completion !== 'local_verified'
    || contract.publication_scope.mode !== 'none' || contract.merge_authority.mode !== 'none'
    || contract.required_checks.length !== 1) throw Error('GRAPH_CONTRACT_UNSUPPORTED');
  const selected = registration.acceptanceRegistry.filter(item => item.ref === request.spec.input.acceptanceRef);
  if (selected.length !== 1) throw Error('GRAPH_CONTRACT_REGISTRY_MISMATCH');
  const acceptance = acceptanceSchema.parse(selected[0]);
  if (acceptance.passExitCodes.length !== 1 || acceptance.passExitCodes[0] !== 0 || acceptance.failExitCodes.includes(0)
    || deliveryCheckReference(acceptance.command) !== contract.required_checks[0]!.registry_ref) throw Error('GRAPH_CONTRACT_REGISTRY_MISMATCH');
  assertDeliveryContractAdmission(frozen, { canonicalRepo: registration.repositoryPath, baseHead: request.spec.input.baseRevision,
    taskId: request.spec.input.taskRef, goal: registration.task, policyDigest: policy.policyDigest,
    reviewPolicyRef: policy.reviewPolicyRef, acceptedCommands: [acceptance.command] });
  for (const name of Object.keys(policy.limits) as (keyof GraphContractHostPolicy['limits'])[]) {
    if (request.spec.limits[name] > policy.limits[name]) throw Error('GRAPH_CONTRACT_BUDGET_EXCEEDED');
  }
  const envelope = freezeWorkerData(envelopeSchema.parse({ schemaVersion: 1, sourceInputArtifactRef: request.inputArtifactRef,
    frozen, policy, acceptance }));
  return { request: freezeWorkerData(StartGraphRequest.parse({ ...request, inputArtifactRef: graphContractInputRef(envelope) })), envelope };
}

export function graphContractInputRef(envelope: GraphContractHostEnvelope): string {
  return `graph-contract-input:${deliveryContractDigest(envelopeSchema.parse(envelope))}`;
}

/** Parses durable host data; provenance and current grant remain the caller's responsibility. */
export function verifyGraphContractEnvelope(value: unknown, request: StartGraphRequest,
  registration: { repositoryPath: string; task: string; acceptanceRegistry: readonly AcceptanceCommandSpec[]; deliveryContract: GraphDeliveryContractRegistration }): GraphContractHostEnvelope {
  const envelope = envelopeSchema.parse(value);
  const bound = bindGraphDeliveryContract({ ...request, inputArtifactRef: envelope.sourceInputArtifactRef }, registration);
  if (workerCanonical(bound.envelope) !== workerCanonical(envelope) || workerCanonical(bound.request) !== workerCanonical(request))
    throw Error('GRAPH_CONTRACT_ENVELOPE_MISMATCH');
  return freezeWorkerData(envelope);
}

/** Original base across every repair epoch; --no-renames includes both ends of moves. */
export function assertGraphContractPaths(frozen: FrozenDeliveryContractV2, workspace: string, candidateRevision?: string): void {
  const read = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd: workspace, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' },
  }).split('\0').filter(Boolean);
  const paths = read(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', frozen.contract.base_head,
    ...(candidateRevision ? [candidateRevision] : []), '--']);
  if (!candidateRevision) paths.push(...read(['ls-files', '--others', '--exclude-standard', '-z']));
  assertDeliveryContractPaths(frozen, paths);
}
