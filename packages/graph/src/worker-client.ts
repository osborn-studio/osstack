import {
  GraphWorkerMessage, WorkerActionRequest, validateWorkerActionResponse, parseGraphCheckpointRequest,
  parseGraphCheckpointResponse, workerCanonical, freezeWorkerData,
  type WorkerActionResponse, type GraphWorkerBinding, type WorkerFramedTransport, type GraphCheckpointTransport,
} from '@osstack/protocol';

/** Per-connection client. Rejected capacity requests are never queued or retried. */
export class GraphWorkerClient {
  private sequence = 0;
  private stopped: Error | undefined;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | undefined }>();
  private readonly identity: string;
  private readonly binding: GraphWorkerBinding;
  constructor(binding: GraphWorkerBinding, private readonly transport: WorkerFramedTransport,
    signal: AbortSignal, private readonly maxInFlight = 16, private readonly timeoutMs = 30000) {
    this.binding = freezeWorkerData(structuredClone(binding)); this.identity = workerCanonical(this.binding);
    if (signal.aborted) this.close(new Error('WORKER_CANCELLED'));
    else signal.addEventListener('abort', () => this.close(new Error('WORKER_CANCELLED')), { once: true });
  }
  get outstanding(): number { return this.pending.size; }
  private async request(method: 'action' | 'checkpoint', payload: unknown): Promise<unknown> {
    if (this.stopped) throw this.stopped;
    if (this.pending.size >= this.maxInFlight) throw new Error('WORKER_BACKPRESSURE');
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      // Action duration belongs to the host's persisted run budget and executor.
      // A local RPC timer cannot distinguish a healthy long invocation from loss.
      const timer = method === 'checkpoint' ? setTimeout(() => { this.close(new Error('WORKER_REQUEST_TIMEOUT')); }, this.timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try { this.transport.send({ kind: 'request', binding: this.binding, id, method, payload }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  readonly action = async (value: WorkerActionRequest): Promise<WorkerActionResponse> => {
    const request = WorkerActionRequest.parse(value);
    if (request.graphRunId !== this.binding.graphRunId || request.generation !== this.binding.generation
      || request.specHash !== this.binding.identity.specHash || workerCanonical(request.scope) !== workerCanonical(this.binding.scope)) throw new Error('WORKER_IDENTITY');
    return validateWorkerActionResponse(request, await this.request('action', request));
  };
  readonly checkpoint: GraphCheckpointTransport = async value => {
    const request = parseGraphCheckpointRequest(value);
    if (request.threadId !== this.binding.graphRunId) throw new Error('WORKER_IDENTITY');
    const response = parseGraphCheckpointResponse(await this.request('checkpoint', request));
    if (response.kind !== request.kind) throw new Error('WORKER_RESPONSE_MISMATCH');
    return response;
  };
  receive(value: unknown): void {
    const message = GraphWorkerMessage.parse(value);
    if (workerCanonical(message.binding) !== this.identity) throw new Error('WORKER_IDENTITY');
    if (message.kind !== 'response' || this.stopped) throw new Error('WORKER_RESPONSE_UNEXPECTED');
    const item = this.pending.get(message.id);
    if (!item) throw new Error('WORKER_RESPONSE_UNEXPECTED');
    this.pending.delete(message.id); clearTimeout(item.timer);
    if (message.ok) item.resolve(message.payload); else item.reject(new Error(message.error ?? 'WORKER_RPC_REJECTED'));
  }
  close(error = new Error('WORKER_CLIENT_CLOSED')): void {
    this.stopped ??= error;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(this.stopped); }
    this.pending.clear();
  }
}
