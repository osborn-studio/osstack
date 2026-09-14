import { parseGraphCheckpointRequest, type GraphCheckpointResponse, type GraphScope } from '@osstack/protocol';
import type { GraphCheckpointStore, GraphProgramIdentity, GraphRunStore } from '@osstack/core';

/** Created by the trusted daemon supervisor, never from worker JSON or a checkpoint.
 * The object used as the registry key represents an authenticated connection. G14
 * supplies that connection; possession of scope strings is insufficient. */
export interface GraphCheckpointBinding {
  scope: GraphScope;
  graphRunId: string;
  generation: number;
  owner: string;
  identity: GraphProgramIdentity;
  authorize: () => Promise<void>;
}

/** Control-plane assembly only. The database store fences inside its transaction;
 * this service resolves authority outside the request and waits for commit before
 * acknowledging. No LangGraph runtime or deserialization is loaded in the daemon. */
export class GraphCheckpointService {
  private readonly bindings = new Map<object, GraphCheckpointBinding>();
  private closed = false;
  constructor(private readonly options: {
    runs: GraphRunStore;
    checkpoints: GraphCheckpointStore;
    bindings: ReadonlyMap<object, GraphCheckpointBinding>;
    now?: () => number;
  }) {
    for (const [connection, binding] of options.bindings) {
      if (typeof binding.authorize !== 'function') throw new Error('UNAUTHENTICATED');
      const { authorize, ...data } = binding;
      this.bindings.set(connection, { ...structuredClone(data), authorize });
    }
  }

  close(): void { this.closed = true; }

  async execute(connection: object, value: unknown): Promise<GraphCheckpointResponse> {
    this.assertOpen();
    const binding = this.bindings.get(connection);
    if (!binding) throw new Error('UNAUTHENTICATED');
    const request = parseGraphCheckpointRequest(value);
    if (request.threadId !== binding.graphRunId) throw new Error('RUN_MISMATCH');
    const authorize = binding.authorize;
    const decision: unknown = await authorize();
    if (decision !== undefined) throw new Error("POLICY_DENIED: authorization must resolve without a decision payload or throw");
    this.assertOpen();
    // Refresh only the revision, after the asynchronous authorization boundary.
    // Keep the original connection's generation, owner and program identity. There
    // is no await between this read and the store's transactional check/write.
    const run = this.options.runs.get(binding.scope, binding.graphRunId);
    if (!run) throw new Error('RUN_NOT_FOUND');
    const result = this.options.checkpoints.execute({ scope: binding.scope,
      graphRunId: binding.graphRunId, expectedGeneration: binding.generation,
      expectedRevision: run.revision, expectedOwner: binding.owner,
      identity: binding.identity, now: this.options.now?.() ?? Date.now(),
    }, request);
    return result.response;
  }

  private assertOpen(): void { if (this.closed) throw new Error('CHECKPOINT_SERVICE_CLOSED'); }
}
