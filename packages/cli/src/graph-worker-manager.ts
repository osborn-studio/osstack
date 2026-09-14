import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import {
  GraphWorkerBinding, GraphWorkerMessage, GraphWorkerResume, GraphJsonValue, StartGraphRequest, WorkerActionRequest,
  WorkerFramedTransport, computeGraphInputDigest, parseGraphCheckpointRequest, parseGraphCheckpointResponse,
  validateWorkerActionResponse, workerCanonical, freezeWorkerData,
  type GraphCheckpointRequest, type GraphCheckpointResponse, type WorkerActionResponse,
} from '@osstack/protocol';

export interface GraphWorkerProgramRegistration { id: string; modulePath: string; digest: string }
export interface GraphWorkerStart {
  binding: GraphWorkerBinding;
  programId: string;
  /** Full original business request, whose digest is persisted by G08. */
  input: StartGraphRequest;
  resume?: GraphWorkerResume;
  /** Must synchronously verify the durable full fence and revocation, then return current expiry. */
  authorize: () => { leaseExpiresAt: number };
  register: (connection: object, binding: GraphWorkerBinding) => void;
  action: (connection: object, request: WorkerActionRequest, options: { signal: AbortSignal }) => Promise<WorkerActionResponse>;
  checkpoint: (connection: object, request: GraphCheckpointRequest) => Promise<GraphCheckpointResponse>;
}
export type GraphWorkerExitEvidence =
  | { kind: 'exited'; graphRunId: string; generation: number; owner: string; pid: number; code: number | null;
      signal: NodeJS.Signals | null; confirmedAt: number; evidenceRef: string }
  | { kind: 'spawn_failed'; graphRunId: string; generation: number; owner: string; confirmedAt: number; evidenceRef: string; phase: 'registration' | 'spawn'; error: string }
  | { kind: 'exit_unconfirmed'; pid: number | undefined; error: string };
export interface GraphWorkerHandle {
  readonly connection: object;
  readonly binding: GraphWorkerBinding;
  readonly ready: Promise<void>;
  /** Program outcome only, NOT proof that worker or external effects have stopped. */
  readonly result: Promise<GraphJsonValue>;
  readonly exit: Promise<GraphWorkerExitEvidence>;
  /** Actual OS exit (or authenticated no-child spawn failure), including a late
   * event after bounded stop returned unconfirmed. Never resolves on a timeout. */
  readonly finalExit: Promise<Exclude<GraphWorkerExitEvidence, { kind: 'exit_unconfirmed' }>>;
  cancel(reason?: string): void;
  stop(reason?: string): Promise<GraphWorkerExitEvidence>;
  logs(): { stdout: string; stderr: string };
}
export interface GraphWorkerManagerOptions {
  programs: readonly GraphWorkerProgramRegistration[];
  workerEntry?: string;
  executable?: string;
  heartbeatTimeoutMs?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  terminationTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxInFlight?: number;
  maxLogBytes?: number;
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  // A caller may wait for exit first. Internal observation prevents early lifecycle
  // failures from creating unhandled rejections without changing the public promise.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function boundedOption(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error('WORKER_OPTION_INVALID');
  return result;
}
/** Resolves without importing the heavy worker. Published CLI must depend on graph;
 * sibling fallback supports this repository's source and built-package tests. */
export function resolveGraphWorkerEntry(): string {
  try { return fileURLToPath(import.meta.resolve('@osstack/graph/worker')); }
  catch {
    const sibling = fileURLToPath(new URL('../../graph/dist/worker-entry.js', import.meta.url));
    if (existsSync(sibling)) return sibling;
    throw new Error('GRAPH_WORKER_NOT_INSTALLED');
  }
}

/** In-memory process supervision, not a lease store or a node scheduler. No DB
 * dependency, no broker permit release, no engine loaded into the host process. */
export class GraphWorkerManager {
  private readonly programs = new Map<string, { source: string; digest: string }>();
  private readonly runs = new Map<string, { binding: GraphWorkerBinding; input: string; programId: string; active: boolean }>();
  private readonly options: Readonly<GraphWorkerManagerOptions>;
  constructor(options: GraphWorkerManagerOptions) {
    this.options = Object.freeze({ ...options });
    for (const item of options.programs) {
      if (!item.id || item.id.length > 256 || this.programs.has(item.id) || !/^[a-f0-9]{64}$/.test(item.digest)) throw new Error('WORKER_PROGRAM_INVALID');
      const bytes = readFileSync(item.modulePath);
      if (bytes.length > 131072) throw new Error('WORKER_PROGRAM_LIMIT');
      const source = bytes.toString('utf8');
      if (createHash('sha256').update(bytes).digest('hex') !== item.digest || !bytes.equals(Buffer.from(source))) throw new Error('PROGRAM_IDENTITY');
      this.programs.set(item.id, Object.freeze({ source, digest: item.digest }));
    }
  }
  start(value: GraphWorkerStart): GraphWorkerHandle {
    const binding = freezeWorkerData(GraphWorkerBinding.parse(value.binding));
    const input = freezeWorkerData(StartGraphRequest.parse(value.input));
    const resume = value.resume === undefined ? undefined : freezeWorkerData(GraphWorkerResume.parse(value.resume));
    const programId = value.programId;
    const program = this.programs.get(programId);
    if (!program || program.digest !== binding.identity.compiledProgramDigest
      || binding.identity.engineVersion !== '1.4.15' || binding.identity.checkpointVersion !== '1.1.5') throw new Error('PROGRAM_IDENTITY');
    if (computeGraphInputDigest(input) !== binding.identity.inputDigest || workerCanonical(input.scope) !== workerCanonical(binding.scope)
      || createHash('sha256').update(`osstack.graph.spec.v1\n${workerCanonical(input.spec)}`).digest('hex') !== binding.identity.specHash) throw new Error('INPUT_IDENTITY');
    const previous = this.runs.get(binding.graphRunId);
    if (previous?.active) throw new Error('WORKER_ALREADY_ACTIVE');
    if (previous && (workerCanonical(previous.binding.identity) !== workerCanonical(binding.identity)
      || workerCanonical(previous.binding.scope) !== workerCanonical(binding.scope) || previous.programId !== programId || previous.input !== computeGraphInputDigest(input))) throw new Error('PROGRAM_IDENTITY');
    if (previous && previous.binding.generation >= binding.generation) throw new Error('STALE_GENERATION');
    const authorize = value.authorize; const action = value.action; const checkpoint = value.checkpoint;
    const checkAuthority = () => {
      const decision: unknown = authorize();
      if (decision && typeof (decision as Promise<unknown>).then === 'function') {
        void Promise.resolve(decision).catch(() => {}); throw new Error('WORKER_AUTHORITY_MUST_BE_SYNC');
      }
      const expiry = (decision as { leaseExpiresAt?: unknown } | undefined)?.leaseExpiresAt;
      if (typeof expiry !== 'number' || !Number.isSafeInteger(expiry) || expiry <= Date.now()) throw new Error('LEASE_EXPIRED');
    };
    checkAuthority();
    const heartbeatMs = boundedOption(this.options.heartbeatTimeoutMs, 5000, 60000);
    const startupMs = boundedOption(this.options.startupTimeoutMs, 10000, 60000);
    const shutdownMs = boundedOption(this.options.shutdownTimeoutMs, 1000, 60000);
    const terminationMs = boundedOption(this.options.terminationTimeoutMs, 1000, 60000);
    const maxInFlight = boundedOption(this.options.maxInFlight, 16, 64);
    const maxLogBytes = boundedOption(this.options.maxLogBytes, 16384, 1048576);
    const requestTimeoutMs = boundedOption(this.options.requestTimeoutMs, 30000, 300000);
    const entry = this.options.workerEntry ?? resolveGraphWorkerEntry();
    const ready = deferred<void>(); const result = deferred<GraphJsonValue>(); const exit = deferred<GraphWorkerExitEvidence>();
    const finalExit = deferred<Exclude<GraphWorkerExitEvidence, { kind: 'exit_unconfirmed' }>>();
    const connection = Object.freeze({}); const abort = new AbortController();
    const record = { binding, programId, input: computeGraphInputDigest(input), active: true };
    this.runs.set(binding.graphRunId, record);
    let child: ChildProcess | undefined; let transport: WorkerFramedTransport | undefined;
    let stdout: Buffer = Buffer.alloc(0); let stderr: Buffer = Buffer.alloc(0);
    let registered = false;
    let stopping = false; let observedExit = false; let didReady = false; let didDone = false;
    const startedAt = Date.now();
    let lastHeartbeat = startedAt; let lastRequest = 0;
    const pending = new Set<string>(); const timers: ReturnType<typeof setTimeout>[] = [];
    let monitor: ReturnType<typeof setInterval> | undefined;
    const clear = () => { timers.forEach(clearTimeout); if (monitor) clearInterval(monitor); };
    const append = (prior: Buffer, chunk: Buffer): Buffer => chunk.length >= maxLogBytes
      ? Buffer.from(chunk.subarray(chunk.length - maxLogBytes))
      : Buffer.concat([prior.subarray(Math.max(0, prior.length + chunk.length - maxLogBytes)), chunk]);
    const cancel = (reason = 'WORKER_CANCELLED') => {
      if (stopping || observedExit) return; stopping = true;
      abort.abort(); ready.reject(new Error(reason)); result.reject(new Error(reason));
      try { transport?.send({ kind: 'cancel', binding, reason: reason.slice(0, 4096) }); } catch { /* OS termination still follows. */ }
      const kill = (signal: NodeJS.Signals) => { if (!observedExit) { try { child?.kill(signal); } catch { /* no exit evidence */ } } };
      timers.push(setTimeout(() => {
        kill('SIGTERM');
        timers.push(setTimeout(() => {
          kill('SIGKILL');
          timers.push(setTimeout(() => {
            if (!observedExit) { transport?.close(); child?.stdout?.destroy(); child?.stderr?.destroy();
              exit.resolve({ kind: 'exit_unconfirmed', pid: child?.pid, error: 'WORKER_EXIT_UNCONFIRMED' }); clear(); }
          }, terminationMs));
        }, terminationMs));
      }, shutdownMs));
    };
    const assertActive = () => {
      if (stopping || observedExit || this.runs.get(binding.graphRunId) !== record) throw new Error('STALE_GENERATION');
      checkAuthority();
    };
    const processRequest = async (message: Extract<GraphWorkerMessage, { kind: 'request' }>) => {
      try {
        assertActive(); let payload: unknown;
        if (message.method === 'action') {
          const request = WorkerActionRequest.parse(message.payload);
          if (request.graphRunId !== binding.graphRunId || request.generation !== binding.generation
            || request.specHash !== binding.identity.specHash || workerCanonical(request.scope) !== workerCanonical(binding.scope)) throw new Error('WORKER_IDENTITY');
          payload = validateWorkerActionResponse(request, await action(connection, request, { signal: abort.signal }));
        } else {
          const request = parseGraphCheckpointRequest(message.payload);
          if (request.threadId !== binding.graphRunId) throw new Error('WORKER_IDENTITY');
          payload = parseGraphCheckpointResponse(await checkpoint(connection, request));
          if ((payload as GraphCheckpointResponse).kind !== request.kind) throw new Error('WORKER_RESPONSE_MISMATCH');
        }
        assertActive(); transport!.send({ kind: 'response', binding, id: message.id, ok: true, payload });
      } catch (error) {
        try { assertActive(); transport!.send({ kind: 'response', binding, id: message.id, ok: false, error: String(error).slice(0, 4096) }); }
        catch { cancel('STALE_GENERATION'); }
      } finally { pending.delete(message.id); }
    };
    const receive = (raw: unknown) => {
      const message = GraphWorkerMessage.parse(raw);
      if (workerCanonical(message.binding) !== workerCanonical(binding)) throw new Error('WORKER_IDENTITY');
      assertActive();
      if (message.kind === 'ready') {
        if (didReady) throw new Error('WORKER_READY_DUPLICATE'); didReady = true; lastHeartbeat = Date.now(); ready.resolve();
      } else if (message.kind === 'heartbeat') { lastHeartbeat = Date.now(); }
      else if (message.kind === 'done') {
        if (didDone || (message.ok && (!didReady || pending.size > 0))) throw new Error('WORKER_DONE_UNEXPECTED');
        didDone = true;
        if (message.ok) result.resolve(GraphJsonValue.parse(message.value));
        else result.reject(new Error(message.error ?? 'WORKER_INVOKE_FAILED'));
        cancel(message.ok ? 'WORKER_FINISHED' : message.error ?? 'WORKER_INVOKE_FAILED');
      } else if (message.kind === 'request') {
        if (!didReady || pending.size >= maxInFlight) throw new Error('WORKER_BACKPRESSURE');
        const seq = Number(message.id);
        if (!Number.isSafeInteger(seq) || seq <= lastRequest || String(seq) !== message.id) throw new Error('WORKER_REQUEST_REPLAY');
        lastRequest = seq; pending.add(message.id);
        void processRequest(message).catch(error => cancel(String(error)));
      } else throw new Error('WORKER_MESSAGE_UNEXPECTED');
    };
    const handle: GraphWorkerHandle = Object.freeze({ connection, binding, ready: ready.promise, result: result.promise, exit: exit.promise, finalExit: finalExit.promise,
      cancel, stop: (reason?: string) => { cancel(reason); return exit.promise; }, logs: () => ({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') }) });
    const spawnFailed = (error: Error) => {
      if (child?.pid) { cancel(String(error)); return; }
      observedExit = true; record.active = false; abort.abort(); clear(); transport?.close();
      ready.reject(error); result.reject(error);
      const evidence = { kind: 'spawn_failed' as const, graphRunId: binding.graphRunId, generation: binding.generation,
        owner: binding.owner, confirmedAt: Date.now(), evidenceRef: `worker-not-started:${randomUUID()}`,
        phase: registered ? 'spawn' as const : 'registration' as const, error: String(error) };
      exit.resolve(evidence); finalExit.resolve(evidence);
    };
    try {
      const registration: unknown = value.register(connection, binding);
      if (registration !== undefined) { void Promise.resolve(registration).catch(() => {}); throw new Error('WORKER_REGISTER_MUST_BE_SYNC'); }
      registered = true;
      checkAuthority();
      // Deliberately do not inherit OSSTACK_HOME, HOME, NODE_OPTIONS or DB/socket env.
      child = spawn(this.options.executable ?? process.execPath, [entry, '--osstack-graph-worker'], {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: { PATH: process.env['PATH'] ?? '', LANG: 'C.UTF-8' },
      });
      child.on('error', spawnFailed);
      child.once('exit', (code, signal) => {
        observedExit = true; record.active = false; abort.abort(); clear(); transport?.close();
        child?.stdout?.destroy(); child?.stderr?.destroy(); // Never wait for close/inherited pipes.
        ready.reject(new Error('WORKER_EXITED_BEFORE_READY')); result.reject(new Error('WORKER_EXITED_BEFORE_RESULT'));
        const evidence = { kind: 'exited' as const, graphRunId: binding.graphRunId, generation: binding.generation, owner: binding.owner,
          pid: child!.pid!, code, signal, confirmedAt: Date.now(), evidenceRef: `worker-exit:${randomUUID()}` };
        exit.resolve(evidence); finalExit.resolve(evidence);
      });
      child.stdout!.on('error', error => cancel(String(error)));
      child.stderr!.on('error', error => cancel(String(error)));
      child.stdout!.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr!.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
      const pipe = child.stdio[3] as Duplex;
      transport = new WorkerFramedTransport(pipe, pipe, receive, error => cancel(error.message));
      child.once('spawn', () => {
        try {
          assertActive(); transport!.send({ kind: 'init', binding, programId, source: program.source, input,
            ...(resume ? { resume } : {}), heartbeatMs: Math.max(10, Math.floor(heartbeatMs / 3)), maxInFlight, requestTimeoutMs });
        } catch (error) { cancel(String(error)); }
      });
      monitor = setInterval(() => {
        if (stopping || observedExit) return;
        try {
          assertActive();
          if (!didReady && Date.now() - startedAt > startupMs) cancel('WORKER_STARTUP_TIMEOUT');
          else if (didReady && Date.now() - lastHeartbeat > heartbeatMs) cancel('WORKER_HEARTBEAT_EXPIRED');
        }
        catch (error) { cancel(String(error)); }
      }, Math.max(10, Math.min(100, Math.floor(heartbeatMs / 3))));
    } catch (error) { spawnFailed(error instanceof Error ? error : new Error(String(error))); }
    return handle;
  }
}
