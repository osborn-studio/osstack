import { createHash } from 'node:crypto';
import { entrypoint, task } from '@langchain/langgraph';
import { GraphResult, WorkerActionRequest, type StartGraphRequest } from '@osstack/protocol';
import { describe, expect, it, vi } from 'vitest';
import { GRAPH_REGISTRY } from './registry.js';
import { compileGraphSpec, validateGraphPlan } from './spec-compiler.js';

const spec = (epochs = 1, attempts = 1) => ({
  schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only',
  input: { taskRef: 'task', repositoryRef: 'repo', baseRevision: 'a'.repeat(40), acceptanceRef: 'acceptance' },
  limits: { maxEpochs: epochs, maxBranchAttempts: attempts, maxConcurrentReaders: 2,
    maxConcurrentWritersPerRepo: 1, maxActionStarts: 100000, deadlineSeconds: 600, tokenReservationLimit: 1000000000 },
});

describe('static graph compiler', () => {
  it('hashes exact executable source deterministically and freezes input snapshots', () => {
    const input = spec();
    const first = compileGraphSpec(input);
    expect(first).toEqual(compileGraphSpec(JSON.parse(JSON.stringify(input))));
    expect(first).toEqual(compileGraphSpec(Object.fromEntries(Object.entries(input).reverse())));
    expect(first.compiledProgramDigest).toBe(createHash('sha256').update(first.source).digest('hex'));
    input.input.taskRef = 'mutated';
    expect(first.spec.input.taskRef).toBe('task');
    expect(Object.isFrozen(first.plan.nodes[0]!.inputs)).toBe(true);
    expect(first.source).not.toMatch(/import\s|require\(|Date|Math.random|node:fs|@osstack\/(core|cli|loop)/);
  });
  it.each(['registryVersion', 'schemaVersion'] as const)('binds %s into the executable digest', key => {
    const changed = { ...GRAPH_REGISTRY, [key]: 'next-version' };
    expect(compileGraphSpec(spec(), changed).compiledProgramDigest).not.toBe(compileGraphSpec(spec()).compiledProgramDigest);
  });
  it.each([0, 4, Infinity, 1.5])('rejects invalid epochs %s', epochs => {
    expect(() => compileGraphSpec(spec(epochs))).toThrow();
  });
  it.each([0, 33, Infinity, 1.5])('rejects invalid branch attempts %s', attempts => {
    expect(() => compileGraphSpec(spec(1, attempts))).toThrow();
  });
  it.each([1, 2, 3])('reserves every possible action and trusted token cost for %s epochs', epochs => {
    for (let attempts = 1; attempts <= 32; attempts++) {
      const input = spec(epochs, attempts);
      const compiled = compileGraphSpec(input);
      expect(compiled.budget.maxActionStarts).toBe(epochs * (3 + 4 * attempts));
      expect(compiled.budget.tokenReservationLimit).toBe(epochs * (GRAPH_REGISTRY.nodes.implement.reservedTokens
        + attempts * (GRAPH_REGISTRY.nodes.review.reservedTokens + GRAPH_REGISTRY.nodes.tests.reservedTokens)));
      expect(compiled.plan.nodes).toHaveLength(8 * epochs);
      input.limits.maxActionStarts = compiled.budget.maxActionStarts;
      input.limits.tokenReservationLimit = compiled.budget.tokenReservationLimit;
      expect(() => compileGraphSpec(input)).not.toThrow();
      expect(() => compileGraphSpec({ ...input, limits: { ...input.limits, maxActionStarts: input.limits.maxActionStarts - 1 } })).toThrow(/BUDGET/);
      expect(() => compileGraphSpec({ ...input, limits: { ...input.limits, tokenReservationLimit: input.limits.tokenReservationLimit - 1 } })).toThrow(/BUDGET/);
    }
  });
  it.each(['code', 'nodes', 'edges', 'tools', 'registry'])('rejects arbitrary %s in a spec', field => {
    expect(() => compileGraphSpec({ ...spec(), [field]: 'evil()' })).toThrow();
  });
  it('rejects functions and accessors without executing user code', () => {
    const called = vi.fn();
    expect(() => compileGraphSpec({ ...spec(), code: called })).toThrow();
    expect(() => compileGraphSpec({ ...spec(), get input() { called(); return {}; } })).toThrow();
    expect(called).not.toHaveBeenCalled();
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw Error('random during compile'); });
    const now = vi.spyOn(Date, 'now').mockImplementation(() => { throw Error('clock during compile'); });
    try { compileGraphSpec(spec()); } finally { random.mockRestore(); now.mockRestore(); }
  });
  it.each(['missing', 'unknown-output', 'unreachable', 'wrong-kind', 'unauthorized'])('rejects %s plan mappings', change => {
    const plan = structuredClone(compileGraphSpec(spec()).plan);
    const node = plan.nodes.find(item => item.operation === 'freeze')!;
    if (change === 'missing') Reflect.deleteProperty(node.inputs, 'receiptRef');
    if (change === 'unknown-output') Reflect.set(node.inputs.receiptRef!, 'field', 'missing');
    if (change === 'unreachable') Reflect.set(node.inputs.receiptRef!, 'nodeId', 'e0.review');
    if (change === 'wrong-kind') Reflect.set(node.inputs.receiptRef!, 'field', 'kind');
    if (change === 'unauthorized') Reflect.set(node, 'operation', 'exec');
    expect(() => validateGraphPlan(plan)).toThrow(/PLAN_INVALID/);
  });
});

async function execute(outputOverride?: Record<string, unknown>, observed: string[] = [], responsePatch?: (response: Record<string, unknown>) => Record<string, unknown>) {
  const compiled = compileGraphSpec(spec());
  const source = await import(`data:text/javascript;base64,${Buffer.from(compiled.source).toString('base64')}`);
  const input = { schemaVersion: 1, kind: 'start', scope: { schemaVersion: 1, tenantId: 'tenant', principalId: 'principal', workspaceId: 'workspace' },
    idempotencyKey: 'id', spec: compiled.spec, inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'source' } } as StartGraphRequest;
  const requests: WorkerActionRequest[] = [];
  const values = {
    workspace_create: { schemaVersion: 1, kind: 'workspace', workspaceLeaseRef: 'lease', receiptRef: 'created' },
    implement: { schemaVersion: 1, kind: 'implementation_complete', workspaceLeaseRef: 'lease', receiptRef: 'implemented' },
    freeze: { schemaVersion: 1, kind: 'candidate_ready', candidateRevision: 'b'.repeat(40), artifactRefs: ['bundle'], artifactDigest: 'c'.repeat(64) },
    review: { schemaVersion: 1, kind: 'review', candidateRevision: 'b'.repeat(40), evidenceRefs: ['review'], evidenceDigest: 'd'.repeat(64), verdict: 'accept' },
    tests: { schemaVersion: 1, kind: 'tests', candidateRevision: 'b'.repeat(40), evidenceRefs: ['tests'], evidenceDigest: 'e'.repeat(64), passed: true },
    ...outputOverride,
  };
  const workflow = entrypoint('compiler-execution-proof', () => source.run({ input,
    binding: { scope: input.scope, graphRunId: 'run', generation: 1, identity: { specHash: compiled.specHash } },
    signal: new AbortController().signal,
    interrupt: () => ({ kind: 'ready', epoch: 0, feedbackRef: 'host-join' }),
    task: (options: { name: string }, fn: (value: unknown) => unknown) => task(options, (value: unknown) => { observed.push(options.name); return fn(value); }),
    action: async (value: unknown) => {
      const request = WorkerActionRequest.parse(value); requests.push(request);
      const result = values[request.action.kind as keyof typeof values];
      const response = { schemaVersion: 1, kind: 'worker_action_response', requestId: request.requestId, generation: request.generation,
        effect: { schemaVersion: 1, scope: request.scope, graphRunId: request.graphRunId, specHash: request.specHash,
          epoch: request.epoch, nodeId: request.nodeId, effectSlot: request.effectSlot, logicalAttempt: 1 },
        outcome: { state: 'confirmed', result } };
      return responsePatch ? responsePatch(response) : response;
    },
  }));
  expect(observed).toEqual([]); // Compilation/import/task definitions dispatch no actions.
  expect(requests).toEqual([]);
  const result = await workflow.invoke({}, { durability: 'sync' });
  return { result, observed, requests, values };
}

it('executes emitted ESM through actual Functional tasks in stable order with predecessor mappings', async () => {
  const { result, observed, requests, values } = await execute();
  expect(observed).toEqual(['code-delivery-v1.e0.workspace', 'code-delivery-v1.e0.implement', 'code-delivery-v1.e0.freeze', 'code-delivery-v1.e0.prepare_review', 'code-delivery-v1.e0.prepare_tests', 'code-delivery-v1.e0.review', 'code-delivery-v1.e0.tests']);
  expect(result).toEqual({ kind: 'ready', epoch: 0, feedbackRef: 'host-join' });
  expect(requests.map(value => value.action.kind)).toEqual(['workspace_create', 'implement', 'freeze', 'workspace_create', 'workspace_create', 'review', 'tests']);
  expect(requests[2]!.action).toEqual({ kind: 'freeze', workspaceLeaseRef: 'lease', receiptRef: 'implemented' });
  expect(requests[5]!.action).toEqual({ kind: 'review', candidateRevision: 'b'.repeat(40), acceptanceRef: 'acceptance', workspaceLeaseRef: 'lease' });
  for (const request of requests) expect(request).not.toHaveProperty('logicalAttempt');
  GraphResult.parse(values.freeze);
});

it.each([
  { freeze: { schemaVersion: 1, kind: 'candidate_ready', candidateRevision: 'bad', artifactRefs: ['bundle'], artifactDigest: 'c'.repeat(64) } },
  { implement: { schemaVersion: 1, kind: 'workspace', workspaceLeaseRef: 'lease', receiptRef: 'receipt' } },
  { workspace_create: { schemaVersion: 1, kind: 'workspace', receiptRef: 'receipt' } },
])('stops on invalid predecessor output before dependent execution', async override => {
  const observed: string[] = [];
  await expect(execute(override, observed)).rejects.toThrow(/OUTPUT_CONTRACT_INVALID/);
  expect(observed).not.toContain('code-delivery-v1.e0.review');
  expect(observed).not.toContain('code-delivery-v1.e0.tests');
});


it.each(['requestId', 'generation', 'scope', 'epoch', 'specHash', 'nodeId', 'effectSlot', 'graphRunId'])('rejects miscorrelated %s without dispatching dependents', async field => {
  const observed: string[] = [];
  await expect(execute(undefined, observed, response => {
    if (field === 'requestId' || field === 'generation') return { ...response, [field]: 'wrong' };
    return { ...response, effect: { ...(response.effect as object), [field]: 'wrong' } };
  })).rejects.toThrow(/RESPONSE_MISMATCH/);
  expect(observed).toEqual(['code-delivery-v1.e0.workspace']);
});

it.each(['unknown', 'intent', 'running', 'cancel_pending', 'failed'])('never retries or invents a new slot on %s', async state => {
  const observed: string[] = [];
  await expect(execute(undefined, observed, response => ({ ...response, outcome: { state,
    error: { code: state === 'failed' ? 'OUTPUT_CONTRACT_INVALID' : 'ACTION_OUTCOME_UNKNOWN' },
  } }))).rejects.toThrow();
  expect(observed).toEqual(['code-delivery-v1.e0.workspace']);
});

it('rejects candidate output from a different frozen revision', async () => {
  await expect(execute({ review: { schemaVersion: 1, kind: 'review', candidateRevision: 'f'.repeat(40),
    evidenceRefs: ['review'], evidenceDigest: 'd'.repeat(64), verdict: 'accept' } })).rejects.toThrow(/OUTPUT_CONTRACT_INVALID/);
});

it('rejects malformed protocol shapes and leaves the original spec mutable', () => {
  for (const input of [null, [], {}, { ...spec(), template: 'custom' }, { ...spec(), publication: 'push' },
    { ...spec(), input: { ...spec().input, baseRevision: 'bad' } }]) expect(() => compileGraphSpec(input)).toThrow();
  const input = spec();
  compileGraphSpec(input);
  expect(Object.isFrozen(input)).toBe(false);
  expect(Object.isFrozen(input.input)).toBe(false);
});
