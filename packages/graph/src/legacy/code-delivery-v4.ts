import { createHash } from 'node:crypto';
import { GraphJsonValue, GraphSpec, freezeWorkerData, workerCanonical } from '@osstack/protocol';
import { GRAPH_REGISTRY, validateGraphRegistry, type GraphFieldKind, type GraphOperation } from './code-delivery-registry-v3.js';

export const GRAPH_COMPILER_VERSION = 'code-delivery-functional-v4';
export type GraphInputMapping =
  | { readonly from: 'spec' | 'start'; readonly field: string; readonly kind: GraphFieldKind }
  | { readonly from: 'node'; readonly nodeId: string; readonly field: string; readonly kind: GraphFieldKind };
export interface GraphPlanNode {
  readonly id: string;
  readonly taskName: string;
  readonly epoch: number;
  readonly operation: GraphOperation;
  readonly effectSlot: string;
  readonly inputs: Readonly<Record<string, GraphInputMapping>>;
  /** Capacity for explicit host ledger retries, never worker-created slots. */
  readonly maxLedgerAttempts: number;
}
export interface GraphPlan {
  readonly template: 'code-delivery-v1';
  readonly maxEpochs: number;
  readonly maxBranchAttempts: number;
  readonly nodes: readonly GraphPlanNode[];
}
export interface CompiledGraphSpec {
  readonly spec: GraphSpec;
  readonly specHash: string;
  readonly compilerVersion: string;
  readonly registryVersion: string;
  readonly schemaVersion: string;
  readonly plan: GraphPlan;
  readonly budget: { readonly maxActionStarts: number; readonly tokenReservationLimit: number };
  readonly source: string;
  readonly compiledProgramDigest: string;
}

const specFields: Readonly<Record<string, GraphFieldKind>> = {
  taskRef: 'ref', repositoryRef: 'ref', baseRevision: 'commit', acceptanceRef: 'ref',
};
const specInput = (field: string, kind: GraphFieldKind = 'ref'): GraphInputMapping => ({ from: 'spec', field, kind });
const output = (nodeId: string, field: string, kind: GraphFieldKind = 'ref'): GraphInputMapping => ({ from: 'node', nodeId, field, kind });

function fixedPlan(maxEpochs: number, maxBranchAttempts: number): GraphPlan {
  const nodes: GraphPlanNode[] = [];
  for (let epoch = 0; epoch < maxEpochs; epoch++) {
    const prefix = `e${epoch}`;
    const prior = `e${epoch - 1}`;
    const work = epoch === 0 ? 'implement' : 'repair';
    const add = (name: string, operation: GraphOperation, inputs: Record<string, GraphInputMapping>, maxLedgerAttempts = 1) => {
      nodes.push({ id: `${prefix}.${name}`, taskName: `code-delivery-v1.${prefix}.${name}`, epoch, operation,
        effectSlot: 'main', inputs, maxLedgerAttempts });
    };
    add('workspace', 'workspace_create', { repositoryRef: specInput('repositoryRef'), baseRevision: epoch === 0
      ? specInput('baseRevision', 'commit') : output(`${prior}.freeze`, 'candidateRevision', 'commit') });
    add(work, work, { inputArtifactRef: { from: 'start', field: 'inputArtifactRef', kind: 'ref' },
      workspaceLeaseRef: output(`${prefix}.workspace`, 'workspaceLeaseRef'), ...(epoch === 0 ? {} : {
        candidateRevision: output(`${prior}.freeze`, 'candidateRevision', 'commit'),
        feedbackRef: output(`${prior}.join`, 'feedbackRef'),
      }) });
    add('freeze', 'freeze', { workspaceLeaseRef: output(`${prefix}.${work}`, 'workspaceLeaseRef'), receiptRef: output(`${prefix}.${work}`, 'receiptRef') });
    for (const kind of ['review', 'tests']) add(`prepare_${kind}`, 'workspace_create', {
      repositoryRef: specInput('repositoryRef'), baseRevision: output(`${prefix}.freeze`, 'candidateRevision', 'commit'),
    }, maxBranchAttempts);
    add('review', 'review', { candidateRevision: output(`${prefix}.freeze`, 'candidateRevision', 'commit'),
      acceptanceRef: specInput('acceptanceRef'), workspaceLeaseRef: output(`${prefix}.prepare_review`, 'workspaceLeaseRef') }, maxBranchAttempts);
    // Host resolves acceptanceRef to an authorized command specification. Never shell text.
    add('tests', 'tests', { candidateRevision: output(`${prefix}.freeze`, 'candidateRevision', 'commit'),
      commandSpecRef: specInput('acceptanceRef'), workspaceLeaseRef: output(`${prefix}.prepare_tests`, 'workspaceLeaseRef') }, maxBranchAttempts);
    add('join', 'join', { candidate: output(`${prefix}.freeze`, '$', 'candidate'), review: output(`${prefix}.review`, '$', 'review'),
      tests: output(`${prefix}.tests`, '$', 'tests') });
  }
  return { template: 'code-delivery-v1', maxEpochs, maxBranchAttempts, nodes };
}

/** Validates mappings AND exact fixed topology; this is not a user graph builder. */
export function validateGraphPlan(value: unknown, registryValue: unknown = GRAPH_REGISTRY): GraphPlan {
  const registry = validateGraphRegistry(registryValue);
  try {
    const plan = GraphJsonValue.parse(value) as unknown as GraphPlan;
    if (!Number.isInteger(plan.maxEpochs) || plan.maxEpochs < 1 || plan.maxEpochs > 3
      || !Number.isInteger(plan.maxBranchAttempts) || plan.maxBranchAttempts < 1 || plan.maxBranchAttempts > 32) throw new Error('bounds');
    const seen = new Map<string, GraphPlanNode>();
    for (const node of plan.nodes) {
      const contract = registry.nodes[node.operation];
      if (!contract || seen.has(node.id)) throw new Error('unregistered node');
      if (Object.keys(node.inputs).sort().join() !== Object.keys(contract.inputs).sort().join()) throw new Error('required inputs');
      for (const [field, mapping] of Object.entries(node.inputs)) {
        let actual: GraphFieldKind | undefined;
        if (mapping.from === 'spec') actual = specFields[mapping.field];
        else if (mapping.from === 'start') actual = mapping.field === 'inputArtifactRef' ? 'ref' : undefined;
        else if (mapping.from === 'node') {
          const predecessor = seen.get(mapping.nodeId);
          if (!predecessor) throw new Error('unreachable input');
          const producer = registry.nodes[predecessor.operation];
          if (mapping.field === '$') actual = producer.outputKind === 'candidate_ready' ? 'candidate'
            : producer.outputKind === 'review' ? 'review' : producer.outputKind === 'tests' ? 'tests' : undefined;
          else if (mapping.field === 'evidenceRefs.0' && producer.outputs.evidenceRefs === 'refs') actual = 'ref';
          else actual = producer.outputs[mapping.field];
        }
        if (!actual || actual !== mapping.kind || actual !== contract.inputs[field]) throw new Error('input kind/output existence');
      }
      seen.set(node.id, node);
    }
    if (workerCanonical(plan) !== workerCanonical(fixedPlan(plan.maxEpochs, plan.maxBranchAttempts))) throw new Error('fixed topology');
    return freezeWorkerData(plan);
  } catch {
    throw new Error('PLAN_INVALID: fixed topology, reachable typed outputs and required inputs only');
  }
}

/** Pure compilation: no filesystem, executor, clock, random source, or plugin lookup.
 * Emitted source uses Functional tasks and host-owned quality interrupts.
 * All possible epochs/host-authorized branch retries reserve capacity up front. */
export function compileGraphSpec(value: unknown, registryValue: unknown = GRAPH_REGISTRY): CompiledGraphSpec {
  const spec = freezeWorkerData(GraphSpec.parse(value));
  const registry = validateGraphRegistry(registryValue);
  const plan = validateGraphPlan(fixedPlan(spec.limits.maxEpochs, spec.limits.maxBranchAttempts), registry);
  const budget = { maxActionStarts: 0, tokenReservationLimit: 0 };
  for (const node of plan.nodes) {
    const contract = registry.nodes[node.operation];
    if (contract.tool !== 'pure') budget.maxActionStarts += node.maxLedgerAttempts;
    budget.tokenReservationLimit += node.maxLedgerAttempts * contract.reservedTokens;
  }
  if (budget.maxActionStarts > spec.limits.maxActionStarts || budget.tokenReservationLimit > spec.limits.tokenReservationLimit) {
    throw new Error('BUDGET_EXHAUSTED: limits cannot reserve the expanded fixed plan');
  }
  const specHash = sha256(`osstack.graph.spec.v1\n${workerCanonical(spec)}`);
  const identity = { compilerVersion: GRAPH_COMPILER_VERSION, registryVersion: registry.registryVersion, schemaVersion: registry.schemaVersion };
  const source = emitSource({ ...identity, spec, specHash, plan, registry, budget });
  return freezeWorkerData({ ...identity, spec, specHash, plan, budget, source, compiledProgramDigest: sha256(source) });
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function emitSource(data: object): string {
  // Handwritten fixed ESM runtime. Only canonical JSON is interpolated, never code from input.
  return `const program = ${workerCanonical(data)};
const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(value => JSON.parse(canonical(value)))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const freeze = value => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
};
freeze(program);
function valid(kind, value) {
  const ref = value => typeof value === 'string' && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\\u0000-\\u001f\\u007f-\\u009f]/.test(value);
  if (kind === 'ref') return ref(value);
  if (kind === 'commit') return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
  if (kind === 'digest') return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (kind === 'refs') return Array.isArray(value) && value.length > 0 && value.length <= 128 && value.every(ref);
  if (kind === 'boolean') return typeof value === 'boolean';
  if (kind === 'verdict') return value === 'accept' || value === 'changes_requested';
  return false;
}
function validateOutput(node, value) {
  const contract = program.registry.nodes[node.operation];
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || value.kind !== contract.outputKind
    || Object.keys(value).sort().join() !== ['schemaVersion', 'kind', ...Object.keys(contract.outputs)].sort().join()
    || !Object.entries(contract.outputs).every(([key, kind]) => valid(kind, value[key]))) throw Error('OUTPUT_CONTRACT_INVALID: ' + node.id);
  return freeze(JSON.parse(JSON.stringify(value)));
}
export async function run(ctx) {
  if (canonical(ctx.input.spec) !== canonical(program.spec) || ctx.binding.identity.specHash !== program.specHash) throw Error('SPEC_MISMATCH');
  const results = Object.create(null);
  const functions = new Map();
  const active = program.plan.nodes.filter(node => node.operation !== 'join');
  for (const node of active) {
    functions.set(node.id, ctx.task({ name: node.taskName, retry: { maxAttempts: 1 } }, async inputs => {
      if (ctx.signal.aborted) throw Error('WORKER_CANCELLED');
      const request = { schemaVersion: 1, kind: 'worker_action', requestId: node.taskName, generation: ctx.binding.generation,
        scope: ctx.binding.scope, graphRunId: ctx.binding.graphRunId, specHash: program.specHash, epoch: node.epoch,
        nodeId: node.id, effectSlot: node.effectSlot, action: { kind: node.operation, ...inputs } };
      const response = await ctx.action(request);
      if (response.requestId !== request.requestId) throw Error('RESPONSE_MISMATCH');
      if (response.kind === 'worker_action_rejected') throw Error(response.error.code);
      if (response.kind !== 'worker_action_response' || response.generation !== request.generation || !response.effect
        || canonical(response.effect.scope) !== canonical(request.scope)
        || !['graphRunId', 'specHash', 'epoch', 'nodeId', 'effectSlot'].every(key => response.effect[key] === request[key])) throw Error('RESPONSE_MISMATCH');
      if (response.outcome.state !== 'confirmed') throw Error(response.outcome.error?.code || 'ACTION_OUTCOME_UNKNOWN');
      const result = validateOutput(node, response.outcome.result);
      for (const key of ['candidateRevision', 'workspaceLeaseRef']) {
        if (key in inputs && key in result && inputs[key] !== result[key]) throw Error('OUTPUT_CONTRACT_INVALID: ' + key);
      }
      return result;
    }));
  }
  const invoke = async node => {
    const inputs = {};
    for (const [key, mapping] of Object.entries(node.inputs)) {
      const value = mapping.from === 'spec' ? program.spec.input[mapping.field]
        : mapping.from === 'start' ? ctx.input[mapping.field] : results[mapping.nodeId]?.[mapping.field];
      if (!valid(mapping.kind, value)) throw Error('INPUT_CONTRACT_INVALID: ' + node.id + '.' + key);
      inputs[key] = value;
    }
    // Validate cached task RETURN as well as fresh action responses.
    results[node.id] = validateOutput(node, await functions.get(node.id)(freeze(inputs)));
    return results[node.id];
  };
  for (let epoch = 0; epoch < program.plan.maxEpochs; epoch++) {
    const nodes = active.filter(node => node.epoch === epoch);
    for (const node of nodes.slice(0, 3)) await invoke(node);
    await Promise.all(nodes.slice(3, 5).map(node => invoke(node)));
    const branches = await Promise.allSettled(nodes.slice(5).map(node => invoke(node)));
    const failure = branches.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    // This is a checkpointed handoff, never a worker quality decision.
    const decision = ctx.interrupt({ kind: 'quality_join', epoch });
    if (!decision || decision.epoch !== epoch || !valid('ref', decision.feedbackRef)) throw Error('HOST_JOIN_REQUIRED');
    results['e' + epoch + '.join'] = { feedbackRef: decision.feedbackRef };
    if (decision.kind === 'ready' || decision.kind === 'stop') return decision;
    if (decision.kind !== 'repair_required' || decision.nextEpoch !== epoch + 1) throw Error('HOST_JOIN_REQUIRED');
  }
  throw Error('EPOCH_BUDGET_EXHAUSTED');
}
`;
}
