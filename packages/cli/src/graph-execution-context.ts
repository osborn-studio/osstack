import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { AgentAdapter, AgentTask } from '@osstack/agents';
import type { FrozenDeliveryContractV2 } from '@osstack/protocol';
import { GraphEffectIdentity, computeGraphEffectKey, freezeWorkerData, workerCanonical } from '@osstack/protocol';
import { persistDeliveryHostRecord, readDeliveryHostRecord } from './delivery-contract-host.js';
import type { ExecutionContextReceipt, ExecutionContextReceiptReference } from './execution-context.js';

export interface GraphExecutionContextRegistration {
  configDigest: string;
  receiptRoot: string;
  assertCurrent: () => void;
  create: (input: { adapter: AgentAdapter; workspacePath: string; frozen: FrozenDeliveryContractV2 }) => Promise<{
    adapter: AgentAdapter;
    receiptRefs: () => readonly ExecutionContextReceiptReference[];
  }>;
}
export interface GraphContextEvidence {
  effect: GraphEffectIdentity;
  effectKey: string;
  runId: string; taskId: string; sessionId: string;
  promptDigest: string;
  prepared: ExecutionContextReceiptReference;
  adapterObserved: ExecutionContextReceiptReference;
  link: ExecutionContextReceiptReference;
}
export function snapshotGraphExecutionContext(value: GraphExecutionContextRegistration): GraphExecutionContextRegistration {
  if (!/^[a-f0-9]{64}$/.test(value.configDigest) || !isAbsolute(value.receiptRoot)
    || typeof value.assertCurrent !== 'function' || typeof value.create !== 'function') throw Error('GRAPH_CONTEXT_REGISTRATION_INVALID');
  return Object.freeze({ configDigest: value.configDigest, receiptRoot: value.receiptRoot,
    assertCurrent: value.assertCurrent.bind(value), create: value.create.bind(value) });
}

/** Observation is inside context assembly, immediately before the actual adapter receives the final task. */
export async function prepareGraphExecutionContext(input: {
  registration: GraphExecutionContextRegistration; adapter: AgentAdapter; workspacePath: string;
  frozen: FrozenDeliveryContractV2; authorize: () => void; observe?: (task: AgentTask) => void;
}) {
  const check = () => {
    for (const call of [input.authorize, input.registration.assertCurrent]) {
      const value: unknown = call(); if (value !== undefined) { void Promise.resolve(value).catch(() => {}); throw Error('GRAPH_CONTEXT_AUTHORITY'); }
    }
  };
  check(); const tasks = new Map<string, AgentTask>(); const raw = input.adapter;
  // The context wrapper uses a Proxy; a frozen target forbids method substitution.
  const observed: AgentAdapter = { id: raw.id, display_name: raw.display_name, cost_tier: raw.cost_tier,
    capabilities: raw.capabilities.bind(raw), isAvailable: raw.isAvailable.bind(raw),
    ...(raw.runtimeIdentity ? { runtimeIdentity: raw.runtimeIdentity.bind(raw) } : {}),
    ...(raw.confirmStopped ? { confirmStopped: raw.confirmStopped.bind(raw) } : {}),
    invoke: async function* (task: AgentTask, signal: AbortSignal) {
      check();
      if (signal.aborted || tasks.size !== 0) throw Error('GRAPH_CONTEXT_INVOCATION_REPLAY');
      const exact = freezeWorkerData(structuredClone(task)); tasks.set(task.run_id, exact); input.observe?.(exact);
      yield* raw.invoke(exact, signal);
    } };
  const context = await input.registration.create({ adapter: observed, workspacePath: input.workspacePath, frozen: input.frozen }); check();
  if (context.adapter.id !== raw.id || typeof context.adapter.confirmStopped !== 'function') throw Error('GRAPH_CONTEXT_ADAPTER_MISMATCH');
  let started = false;
  const adapter: AgentAdapter = { id: context.adapter.id, display_name: context.adapter.display_name, cost_tier: context.adapter.cost_tier,
    capabilities: context.adapter.capabilities.bind(context.adapter), isAvailable: context.adapter.isAvailable.bind(context.adapter),
    ...(context.adapter.runtimeIdentity ? { runtimeIdentity: context.adapter.runtimeIdentity.bind(context.adapter) } : {}),
    confirmStopped: context.adapter.confirmStopped.bind(context.adapter),
    invoke: async function* (task, signal) {
      check(); if (started || signal.aborted) throw Error('GRAPH_CONTEXT_INVOCATION_REPLAY');
      started = true; yield* context.adapter.invoke(task, signal);
    } };
  return { adapter,
    evidence: async (runId: string, identity: { effect: GraphEffectIdentity; effectKey: string }): Promise<GraphContextEvidence> => {
      check(); const task = tasks.get(runId); if (!task) throw Error('GRAPH_CONTEXT_ACTUAL_INVOCATION_REQUIRED');
      const effect = GraphEffectIdentity.parse(identity.effect); const effectKey = computeGraphEffectKey(effect);
      if (identity.effectKey !== effectKey) throw Error('GRAPH_CONTEXT_EFFECT_MISMATCH');
      const promptDigest = createHash('sha256').update(task.prompt).digest('hex');
      const records: Array<{ ref: ExecutionContextReceiptReference; receipt: ExecutionContextReceipt }> = [];
      const refs = context.receiptRefs(); if (refs.length !== 2) throw Error('GRAPH_CONTEXT_RECEIPT_COUNT');
      for (const ref of refs) {
        const receipt = await readDeliveryHostRecord(input.registration.receiptRoot, ref) as ExecutionContextReceipt; check();
        if (receipt.schema_version !== 1 || receipt.evidence_boundary !== 'agent_task_prompt_not_provider_wire'
          || receipt.run_id !== task.run_id || receipt.task_id !== task.task_id || receipt.session_id !== task.session_id
          || receipt.adapter_id !== raw.id || receipt.capability_id !== task.capability_id || receipt.contract_digest !== input.frozen.digest
          || receipt.tenant !== 'default'
          || receipt.prompt_sha256 !== promptDigest || receipt.prompt_bytes !== Buffer.byteLength(task.prompt)
          || receipt.repo_path !== input.workspacePath || receipt.execution_repo_path !== task.context?.repo_path) throw Error('GRAPH_CONTEXT_RECEIPT_BINDING');
        records.push({ ref, receipt });
      }
      const prepared = records.find(row => row.receipt.phase === 'prepared'); const adapterObserved = records.find(row => row.receipt.phase === 'adapter_observed');
      if (!prepared || !adapterObserved) throw Error('GRAPH_CONTEXT_RECEIPT_PHASE');
      const { phase: _phase, observed_at_ms: _observed, ...after } = adapterObserved.receipt;
      const { phase: _beforePhase, ...before } = prepared.receipt;
      if (workerCanonical(after) !== workerCanonical(before)) throw Error('GRAPH_CONTEXT_RECEIPT_CHANGED');
      const value = { effect, effectKey, runId: task.run_id, taskId: task.task_id, sessionId: task.session_id, promptDigest,
        prepared: { ...prepared.ref }, adapterObserved: { ...adapterObserved.ref } };
      const link = await persistDeliveryHostRecord(input.registration.receiptRoot, { schemaVersion: 1, source: 'osstack_graph_context_host',
        contractDigest: input.frozen.digest, contextDigest: input.registration.configDigest, ...value }); check();
      for (const path of [link.path, input.registration.receiptRoot, dirname(input.registration.receiptRoot)]) {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { check(); await handle.sync(); check(); } finally { await handle.close(); }
      }
      check(); return { ...value, link };
    },
  };
}
