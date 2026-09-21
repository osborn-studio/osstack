import { createHash } from 'node:crypto';
import { Socket } from 'node:net';
import { Command, entrypoint, task, interrupt } from '@langchain/langgraph';
import {
  GraphJsonValue, GraphWorkerMessage, WorkerFramedTransport, computeGraphInputDigest, workerCanonical, freezeWorkerData,
  type GraphWorkerBinding, type GraphCheckpointTransport, type StartGraphRequest, type GraphWorkerResume,
} from '@osstack/protocol';
import { RemoteCheckpointSaver } from './remote-checkpointer.js';
import { GraphWorkerClient } from './worker-client.js';
import { GRAPH_KERNEL } from './index.js';

export interface GraphWorkerProgramContext {
  readonly binding: GraphWorkerBinding;
  readonly input: StartGraphRequest;
  readonly resume?: GraphWorkerResume;
  readonly action: GraphWorkerClient['action'];
  readonly checkpoint: GraphCheckpointTransport;
  readonly signal: AbortSignal;
  /** Installed public Functional API. Registered source must be self-contained. */
  readonly task: typeof task;
  readonly interrupt: typeof interrupt;
}
export interface GraphWorkerProgram { run(context: GraphWorkerProgramContext): Promise<GraphJsonValue> }

/** Architecture isolation only: no DB/home/connection is supplied to this process.
 * This is NOT an OS sandbox against trusted code running as the same OS user. */
export function runGraphWorker(): void {
  const socket = new Socket({ fd: 3, readable: true, writable: true });
  const abort = new AbortController();
  let binding: GraphWorkerBinding | undefined;
  let client: GraphWorkerClient | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let completed = false;
  const fail = (error: Error) => {
    abort.abort(); client?.close(error); if (heartbeat) clearInterval(heartbeat);
    // Only the manager's OS exit event can attest that this process has stopped.
    process.exitCode = 1; socket.destroy();
  };
  const transport = new WorkerFramedTransport(socket, socket, value => {
    const message = GraphWorkerMessage.parse(value);
    if (binding) {
      if (workerCanonical(binding) !== workerCanonical(message.binding)) throw new Error('WORKER_IDENTITY');
      if (message.kind === 'cancel') { abort.abort(); client?.close(new Error('WORKER_CANCELLED')); return; }
      client!.receive(message); return;
    }
    if (message.kind !== 'init') throw new Error('WORKER_INIT_REQUIRED');
    binding = freezeWorkerData(message.binding);
    client = new GraphWorkerClient(binding, transport, abort.signal, message.maxInFlight, message.requestTimeoutMs);
    heartbeat = setInterval(() => { try { transport.send({ kind: 'heartbeat', binding }); } catch (error) { fail(new Error(String(error))); } }, message.heartbeatMs);
    void execute(message, client).catch(error => finish(false, undefined, error));
  }, fail);
  function finish(ok: boolean, value?: GraphJsonValue, error?: unknown): void {
    if (completed) return; completed = true;
    try { transport.send({ kind: 'done', binding, ok, ...(ok ? { value } : { error: String(error).slice(0, 4096) }) }); }
    catch (sendError) { fail(new Error(String(sendError))); }
    // Remain alive until host stop. done/invoke rejection deliberately is not exit.
  }
  async function execute(init: Extract<GraphWorkerMessage, { kind: 'init' }>, contextClient: GraphWorkerClient): Promise<void> {
    const identity = init.binding.identity;
    if (identity.engineVersion !== GRAPH_KERNEL.version || identity.checkpointVersion !== GRAPH_KERNEL.checkpointVersion
      || createHash('sha256').update(init.source).digest('hex') !== identity.compiledProgramDigest) throw new Error('PROGRAM_IDENTITY');
    if (computeGraphInputDigest(init.input) !== identity.inputDigest || workerCanonical(init.input.scope) !== workerCanonical(init.binding.scope)
      || createHash('sha256').update(`osstack.graph.spec.v1\n${workerCanonical(init.input.spec)}`).digest('hex') !== identity.specHash) throw new Error('INPUT_IDENTITY');
    // Import the verified snapshot, not a path that could change between hash and import.
    const program = await import(`data:text/javascript;base64,${Buffer.from(init.source).toString('base64')}`) as GraphWorkerProgram;
    if (typeof program.run !== 'function') throw new Error('WORKER_PROGRAM_INVALID');
    const input = freezeWorkerData(init.input);
    const resume = init.resume ? freezeWorkerData(init.resume) : undefined;
    const context = Object.freeze({ binding: init.binding, input, ...(resume ? { resume } : {}),
      action: contextClient.action, checkpoint: contextClient.checkpoint, signal: abort.signal, task, interrupt });
    const workflow = entrypoint({ name: init.programId, checkpointer: new RemoteCheckpointSaver(init.binding.graphRunId, contextClient.checkpoint) },
      async (_input: StartGraphRequest) => GraphJsonValue.parse(await program.run(context)));
    if (abort.signal.aborted) throw new Error('WORKER_CANCELLED');
    transport.send({ kind: 'ready', binding });
    const invocation = resume ? resume.kind === 'continue' ? null : new Command({ resume: resume.value }) : input;
    const result = await workflow.invoke(invocation, { configurable: { thread_id: init.binding.graphRunId }, durability: 'sync', signal: abort.signal });
    finish(true, GraphJsonValue.parse(result));
  }
}
