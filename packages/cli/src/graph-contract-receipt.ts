import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { GraphEffectIdentity, GraphScope, computeGraphEffectKey, freezeWorkerData, workerCanonical } from '@osstack/protocol';
import { deliveryCheckReference } from '@osstack/core';
import type { GraphRun } from '@osstack/core';
import type { GraphArtifactStore } from '@osstack/core/graph-artifacts';
import type { GraphVerificationDecision } from './graph-verification-join.js';
import { loadGraphVerificationEvidence } from './graph-verification-store.js';
import { persistDeliveryHostRecord, readDeliveryHostRecord } from './delivery-contract-host.js';
import type { GraphContractHostEnvelope } from './graph-delivery-contract.js';
import type { GraphContextEvidence } from './graph-execution-context.js';
import { loadDeliveryReceipt } from './graph-delivery-receipts.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.string().min(1).max(512);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const evidence = z.object({ effectKey: digest, evidenceRef: reference, logicalAttempt: z.number().int().positive() }).strict();
const contextRef = z.object({ path: z.string().min(1).max(4096), digest }).strict();
const contextEvidenceSchema = z.object({ effect: GraphEffectIdentity, effectKey: digest, runId: reference, taskId: reference, sessionId: reference,
  promptDigest: digest, prepared: contextRef, adapterObserved: contextRef, link: contextRef }).strict();
export const GraphContractCompletionReceipt = z.object({
  schemaVersion: z.literal(1), source: z.literal('osstack_graph_host'), graphRunId: reference, scope: GraphScope,
  inputDigest: digest, specHash: digest, generation: z.number().int().positive(), epoch: z.number().int().nonnegative(),
  contractDigest: digest, policyDigest: digest, baseHead: commit,
  candidate: z.object({ revision: commit, tree: commit, artifactDigest: digest }).strict(),
  joinRef: reference, check: evidence.extend({ id: reference, registryRef: reference, commandDigest: digest, exitCode: z.literal(0) }),
  review: evidence.extend({ verdict: z.literal('accept'), writerIdentity: reference, reviewerIdentity: reference,
    authority: z.literal('registered_host_reviewer'), promptDigest: digest }),
  achievedCompletion: z.literal('local_verified'), publication: z.literal('artifact_only'),
  contextDigest: digest.optional(), contextEvidence: z.array(contextEvidenceSchema).max(2),
}).strict();
export type GraphContractCompletionReceipt = z.infer<typeof GraphContractCompletionReceipt>;

/** Called only after the existing join gate; independently reads host evidence, never worker RETURNs. */
export async function publishGraphContractCompletion(input: {
  root: string; envelope: GraphContractHostEnvelope; decision: GraphVerificationDecision;
  artifacts: Pick<GraphArtifactStore, 'verify'>; assertCurrent: () => void;
  contextEvidence: readonly GraphContextEvidence[]; contextReceiptRoot?: string;
}): Promise<string> {
  const { decision, envelope } = input; const { run } = decision.snapshot; const binding = decision.joined.binding;
  const check = () => { const result: unknown = input.assertCurrent(); if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw Error('GRAPH_CONTRACT_AUTHORITY'); } };
  check();
  if (decision.route.kind !== 'ready' || decision.joined.status !== 'complete' || !decision.publication
    || decision.snapshot.pendingAdmissions || decision.snapshot.unresolvedActions) throw Error('GRAPH_CONTRACT_COMPLETION_NOT_READY');
  const manifest = await input.artifacts.verify(binding.artifactDigest); check();
  if (manifest.candidateRevision !== binding.candidateRevision || manifest.input.runId !== run.graphRunId
    || workerCanonical(manifest.input.scope) !== workerCanonical(run.scope)) throw Error('GRAPH_CONTRACT_CANDIDATE_MISMATCH');
  const verified = {} as Record<'review' | 'tests', { envelope: Awaited<ReturnType<typeof loadGraphVerificationEvidence>>; ref: string; effectKey: string; logicalAttempt: number }>;
  for (const kind of ['review', 'tests'] as const) {
    const branch = decision.joined.branches.find(item => item.kind === kind);
    const action = decision.snapshot.actions.find(item => item.effectKey === branch?.effectKey);
    if (branch?.state !== 'confirmed' || !action || action.state !== 'confirmed' || action.outcome?.state !== 'confirmed') throw Error('GRAPH_CONTRACT_EFFECT_REQUIRED');
    const receipt = await loadGraphVerificationEvidence(join(input.root, 'verification'), action.outcome.evidenceRef, binding,
      { effect: action.effect, effectKey: action.effectKey }); check();
    if (receipt.kind !== kind || receipt.verificationFailure || workerCanonical(receipt.acceptance) !== workerCanonical(envelope.acceptance)) throw Error('GRAPH_CONTRACT_VERIFICATION_MISMATCH');
    verified[kind] = { envelope: receipt, ref: action.outcome.evidenceRef, effectKey: action.effectKey, logicalAttempt: action.effect.logicalAttempt };
  }
  const tests = verified.tests; const review = verified.review;
  const exitCode = tests.envelope.evidence.contained?.result.exitCode ?? tests.envelope.evidence.command?.exitCode;
  const reviewReceipt = review.envelope.reviewerInvocation;
  if (exitCode !== 0 || review.envelope.report?.verdict !== 'accept' || !reviewReceipt
    || review.envelope.writerIdentity === review.envelope.reviewerIdentity || reviewReceipt.adapterId !== review.envelope.reviewerIdentity
    || reviewReceipt.effectKey !== review.effectKey) throw Error('GRAPH_CONTRACT_VERIFICATION_FAILED');
  const required = envelope.frozen.contract.required_checks[0]!;
  const commandRef = deliveryCheckReference(tests.envelope.acceptance.command);
  if (envelope.frozen.contract.required_checks.length !== 1 || commandRef !== required.registry_ref) throw Error('GRAPH_CONTRACT_REGISTRY_MISMATCH');
  const selectedContext: GraphContextEvidence[] = [];
  const writer = decision.snapshot.actions.find(action => action.effect.epoch === binding.epoch
    && action.effect.nodeId === `e${binding.epoch}.${binding.epoch ? 'repair' : 'implement'}` && action.state === 'confirmed');
  if (writer?.outcome?.state !== 'confirmed' || writer.outcome.result.kind !== 'implementation_complete'
    || writer.outcome.evidenceRef !== manifest.input.producerStopEvidenceRef || writer.generation !== manifest.input.generation) throw Error('GRAPH_CONTRACT_WRITER_REQUIRED');
  const writerReceipt = await loadDeliveryReceipt(input.root, writer.outcome.evidenceRef, { effect: writer.effect, effectKey: writer.effectKey,
    generation: writer.generation, owner: manifest.input.owner, workspacePath: manifest.input.worktreePath }); check();
  if (writerReceipt.stopped !== true || writerReceipt.status !== 'completed' || writerReceipt.candidate?.status !== 'implementation_complete') throw Error('GRAPH_CONTRACT_WRITER_UNCONFIRMED');
  if (envelope.contextDigest) {
    if (!input.contextReceiptRoot) throw Error('GRAPH_CONTEXT_RECEIPT_ROOT_REQUIRED');
    for (const key of [writer.effectKey, review.effectKey]) {
      const rows = input.contextEvidence.filter(row => row.effectKey === key);
      if (rows.length !== 1) throw Error('GRAPH_CONTEXT_EFFECT_MISMATCH');
      const row = contextEvidenceSchema.parse(rows[0]);
      const expectedEffect = key === writer.effectKey ? writer.effect : review.envelope.effect;
      if (computeGraphEffectKey(row.effect) !== key || workerCanonical(row.effect) !== workerCanonical(expectedEffect)
        || key === writer.effectKey && row.runId !== writerReceipt.candidate.execution?.run_id) throw Error('GRAPH_CONTEXT_EFFECT_MISMATCH');
      if (key === review.effectKey && (row.runId !== reviewReceipt.runId || row.sessionId !== reviewReceipt.sessionId || row.promptDigest !== reviewReceipt.promptDigest)) throw Error('GRAPH_CONTEXT_REVIEW_MISMATCH');
      const link = await readDeliveryHostRecord(input.contextReceiptRoot, row.link); check();
      const { link: _link, ...linked } = row;
      if (workerCanonical(link) !== workerCanonical({ schemaVersion: 1, source: 'osstack_graph_context_host',
        contractDigest: envelope.frozen.digest, contextDigest: envelope.contextDigest, ...linked })) throw Error('GRAPH_CONTEXT_LINK_MISMATCH');
      for (const [phase, ref] of [['prepared', row.prepared], ['adapter_observed', row.adapterObserved]] as const) {
        const value = await readDeliveryHostRecord(input.contextReceiptRoot, ref) as Record<string, unknown>; check();
        if (value.phase !== phase || value.run_id !== row.runId || value.task_id !== row.taskId || value.session_id !== row.sessionId
          || value.prompt_sha256 !== row.promptDigest || value.contract_digest !== envelope.frozen.digest) throw Error('GRAPH_CONTEXT_RECEIPT_BINDING');
      }
      selectedContext.push(row);
    }
  }
  const receipt = GraphContractCompletionReceipt.parse({ schemaVersion: 1, source: 'osstack_graph_host',
    graphRunId: run.graphRunId, scope: run.scope, inputDigest: run.identity.inputDigest, specHash: run.identity.specHash, generation: run.generation, epoch: binding.epoch,
    contractDigest: envelope.frozen.digest, policyDigest: envelope.policy.policyDigest, baseHead: envelope.frozen.contract.base_head,
    candidate: { revision: binding.candidateRevision, tree: manifest.tree, artifactDigest: binding.artifactDigest }, joinRef: decision.publication.record.receiptRef,
    check: { id: required.id, registryRef: required.registry_ref, commandDigest: commandRef.slice(7), exitCode: 0,
      effectKey: tests.effectKey, evidenceRef: tests.ref, logicalAttempt: tests.logicalAttempt },
    review: { verdict: 'accept', writerIdentity: review.envelope.writerIdentity, reviewerIdentity: review.envelope.reviewerIdentity,
      authority: 'registered_host_reviewer', promptDigest: reviewReceipt.promptDigest, effectKey: review.effectKey, evidenceRef: review.ref, logicalAttempt: review.logicalAttempt },
    achievedCompletion: 'local_verified', publication: 'artifact_only', contextEvidence: selectedContext,
    ...(envelope.contextDigest ? { contextDigest: envelope.contextDigest } : {}) });
  check();
  const root = join(input.root, 'contract-receipts'); const saved = await persistDeliveryHostRecord(root, receipt); check();
  // This record must be durable before the enclosing host transaction publishes its reference.
  for (const path of [saved.path, root, input.root]) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { check(); await handle.sync(); check(); } finally { await handle.close(); }
  }
  const actual = await readDeliveryHostRecord(root, saved); check();
  if (workerCanonical(actual) !== workerCanonical(receipt)) throw Error('GRAPH_CONTRACT_RECEIPT_CHANGED');
  return `graph-contract:${saved.digest}`;
}

/** A receipt file alone is not completion: caller must obtain ref from the ready DB projection. */
export async function loadGraphContractCompletion(root: string, ref: string, expected: {
  run: GraphRun; envelope: GraphContractHostEnvelope; joinRef: string; candidateRevision: string; artifactDigest: string;
}): Promise<GraphContractCompletionReceipt> {
  if (!/^graph-contract:[a-f0-9]{64}$/.test(ref) || expected.run.status !== 'ready') throw Error('GRAPH_CONTRACT_RECEIPT_UNPUBLISHED');
  const digest = ref.slice('graph-contract:'.length); const directory = join(root, 'contract-receipts');
  const receipt = GraphContractCompletionReceipt.parse(await readDeliveryHostRecord(directory, { path: join(directory, `${digest}.json`), digest }));
  if (receipt.graphRunId !== expected.run.graphRunId || receipt.inputDigest !== expected.run.identity.inputDigest
    || receipt.specHash !== expected.run.identity.specHash || receipt.generation !== expected.run.generation
    || workerCanonical(receipt.scope) !== workerCanonical(expected.run.scope)
    || receipt.contractDigest !== expected.envelope.frozen.digest || receipt.policyDigest !== expected.envelope.policy.policyDigest
    || receipt.contextDigest !== expected.envelope.contextDigest || receipt.contextEvidence.length !== (expected.envelope.contextDigest ? 2 : 0)
    || receipt.joinRef !== expected.joinRef || receipt.candidate.revision !== expected.candidateRevision || receipt.candidate.artifactDigest !== expected.artifactDigest)
    throw Error('GRAPH_CONTRACT_RECEIPT_BINDING');
  return freezeWorkerData(receipt);
}
