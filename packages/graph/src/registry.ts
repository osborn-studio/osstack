import { GraphJsonValue, freezeWorkerData, workerCanonical } from '@osstack/protocol';

export type GraphFieldKind = 'ref' | 'commit' | 'digest' | 'refs' | 'boolean' | 'verdict' | 'candidate' | 'review' | 'tests';
export interface GraphNodeContract {
  readonly tool: 'workspace' | 'code.write' | 'artifact.freeze' | 'code.review' | 'code.test' | 'pure';
  readonly inputs: Readonly<Record<string, GraphFieldKind>>;
  readonly outputKind: string;
  readonly outputs: Readonly<Record<string, GraphFieldKind>>;
  readonly reservedTokens: number;
}

const implementation: GraphNodeContract = {
  tool: 'code.write', inputs: { inputArtifactRef: 'ref', workspaceLeaseRef: 'ref' },
  outputKind: 'implementation_complete', outputs: { workspaceLeaseRef: 'ref', receiptRef: 'ref' }, reservedTokens: 32768,
};
const definitions = {
  workspace_create: { tool: 'workspace', inputs: { repositoryRef: 'ref', baseRevision: 'commit' },
    outputKind: 'workspace', outputs: { workspaceLeaseRef: 'ref', receiptRef: 'ref' }, reservedTokens: 0 },
  implement: implementation,
  repair: { ...implementation, inputs: { ...implementation.inputs, candidateRevision: 'commit', feedbackRef: 'ref' } },
  freeze: { tool: 'artifact.freeze', inputs: { workspaceLeaseRef: 'ref', receiptRef: 'ref' }, outputKind: 'candidate_ready',
    outputs: { candidateRevision: 'commit', artifactRefs: 'refs', artifactDigest: 'digest' }, reservedTokens: 0 },
  review: { tool: 'code.review', inputs: { candidateRevision: 'commit', acceptanceRef: 'ref', workspaceLeaseRef: 'ref' },
    outputKind: 'review', outputs: { candidateRevision: 'commit', evidenceRefs: 'refs', evidenceDigest: 'digest', verdict: 'verdict' }, reservedTokens: 16384 },
  tests: { tool: 'code.test', inputs: { candidateRevision: 'commit', commandSpecRef: 'ref', workspaceLeaseRef: 'ref' },
    outputKind: 'tests', outputs: { candidateRevision: 'commit', evidenceRefs: 'refs', evidenceDigest: 'digest', passed: 'boolean' }, reservedTokens: 0 },
  join: { tool: 'pure', inputs: { candidate: 'candidate', review: 'review', tests: 'tests' }, outputKind: 'join_inputs',
    outputs: { candidate: 'candidate', review: 'review', tests: 'tests', feedbackRef: 'ref' }, reservedTokens: 0 },
} as const satisfies Record<string, GraphNodeContract>;

export type GraphOperation = keyof typeof definitions;
export interface GraphRegistry {
  readonly registryVersion: string;
  readonly schemaVersion: string;
  readonly template: 'code-delivery-v1';
  readonly routes: readonly ['artifact_only', 'host_repair', 'host_retry', 'stop', 'reconcile'];
  readonly nodes: Readonly<Record<GraphOperation, GraphNodeContract>>;
}

/** Costs are reservation ceilings, not model estimates supplied by a spec.
 * A host must enforce these ceilings on its registered executors. */
export const GRAPH_REGISTRY: GraphRegistry = freezeWorkerData({
  registryVersion: 'code-delivery-registry-v3', schemaVersion: 'code-delivery-schema-v3', template: 'code-delivery-v1',
  routes: ['artifact_only', 'host_repair', 'host_retry', 'stop', 'reconcile'], nodes: definitions,
});

/** Trusted host version labels only; callers cannot add tools, schemas, costs or routes.
 * New definitions require a code release. Decoded JSON only; hostile Proxies are out of contract. */
export function validateGraphRegistry(value: unknown): GraphRegistry {
  try {
    const snapshot = GraphJsonValue.parse(value) as unknown as GraphRegistry;
    for (const version of [snapshot.registryVersion, snapshot.schemaVersion]) {
      if (typeof version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(version)) throw new Error('version');
    }
    if (workerCanonical({ ...snapshot, registryVersion: GRAPH_REGISTRY.registryVersion, schemaVersion: GRAPH_REGISTRY.schemaVersion })
      !== workerCanonical(GRAPH_REGISTRY)) throw new Error('definitions');
    return freezeWorkerData(snapshot);
  } catch {
    throw new Error('REGISTRY_INVALID: expected the fixed versioned graph allowlist');
  }
}
