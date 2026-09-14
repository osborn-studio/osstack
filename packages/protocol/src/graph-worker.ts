import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { GraphScope, StartGraphRequest, GraphJsonValue } from './graph.js';

export const GRAPH_WORKER_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const id = z.string().min(1).max(256);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const GraphWorkerIdentity = z.object({
  executionModel: z.literal('langgraph-functional-v1'), durability: z.literal('sync'),
  engineVersion: id, checkpointVersion: id, templateVersion: id, registryVersion: id,
  compilerVersion: id, schemaVersion: id, compiledProgramDigest: digest, specHash: digest, inputDigest: digest,
}).strict();
export const GraphWorkerBinding = z.object({ scope: GraphScope, graphRunId: id,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), owner: id, identity: GraphWorkerIdentity }).strict();
export type GraphWorkerBinding = z.infer<typeof GraphWorkerBinding>;
export const GraphWorkerResume = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('continue') }).strict(),
  z.object({ kind: z.literal('interrupt'), value: GraphJsonValue }).strict(),
]);
export type GraphWorkerResume = z.infer<typeof GraphWorkerResume>;
const bound = { binding: GraphWorkerBinding };
export const GraphWorkerMessage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('init'), ...bound, programId: id, source: z.string().min(1).max(131072),
    input: StartGraphRequest, resume: GraphWorkerResume.optional(),
    heartbeatMs: z.number().int().min(10).max(60000), maxInFlight: z.number().int().min(1).max(64),
    requestTimeoutMs: z.number().int().min(10).max(300000) }).strict(),
  z.object({ kind: z.literal('ready'), ...bound }).strict(),
  z.object({ kind: z.literal('heartbeat'), ...bound }).strict(),
  z.object({ kind: z.literal('cancel'), ...bound, reason: z.string().max(4096) }).strict(),
  z.object({ kind: z.literal('request'), ...bound, id, method: z.enum(['action', 'checkpoint']), payload: z.unknown() }).strict(),
  z.object({ kind: z.literal('response'), ...bound, id, ok: z.boolean(), payload: z.unknown().optional(), error: z.string().max(4096).optional() }).strict(),
  z.object({ kind: z.literal('done'), ...bound, ok: z.boolean(), value: GraphJsonValue.optional(), error: z.string().max(4096).optional() }).strict(),
]);
export type GraphWorkerMessage = z.infer<typeof GraphWorkerMessage>;
export function workerCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(workerCanonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${workerCanonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
}
export function freezeWorkerData<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freezeWorkerData); Object.freeze(value); }
  return value;
}
export function encodeWorkerFrame(value: unknown, maxBytes = GRAPH_WORKER_MAX_FRAME_BYTES): Buffer {
  const json = JSON.stringify(value); const size = Buffer.byteLength(json);
  if (size === 0 || size > maxBytes) throw new Error('WORKER_FRAME_LIMIT');
  const frame = Buffer.allocUnsafe(size + 4); frame.writeUInt32BE(size); frame.write(json, 4); return frame;
}
/** Never concatenates arbitrary incoming chunks. Only a checked length allocates a body. */
export class WorkerFrameDecoder {
  private readonly header = Buffer.alloc(4);
  private headerUsed = 0;
  private body: Buffer | undefined;
  private used = 0;
  private failed = false;
  constructor(private readonly receive: (value: unknown) => void, private readonly maxBytes = GRAPH_WORKER_MAX_FRAME_BYTES) {}
  get bufferedBytes(): number { return this.headerUsed + this.used; }
  push(chunk: Buffer): void {
    if (this.failed) throw new Error('WORKER_TRANSPORT_CLOSED');
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (!this.body) {
          const count = Math.min(4 - this.headerUsed, chunk.length - offset);
          chunk.copy(this.header, this.headerUsed, offset, offset + count); this.headerUsed += count; offset += count;
          if (this.headerUsed < 4) continue;
          const size = this.header.readUInt32BE(); this.headerUsed = 0;
          if (!size || size > this.maxBytes) throw new Error('WORKER_FRAME_LIMIT');
          this.body = Buffer.allocUnsafe(size); this.used = 0;
        }
        const count = Math.min(this.body.length - this.used, chunk.length - offset);
        chunk.copy(this.body, this.used, offset, offset + count); this.used += count; offset += count;
        if (this.used === this.body.length) {
          const body = this.body; this.body = undefined; this.used = 0;
          this.receive(JSON.parse(body.toString('utf8')));
        }
      }
    } catch (error) { this.failed = true; this.body = undefined; this.used = 0; this.headerUsed = 0; throw error; }
  }
}
/** Fail closed on a stalled peer; no additional userland send queue. */
export class WorkerFramedTransport {
  private closed = false;
  private readonly maxFrameBytes: number;
  private readonly maxBufferedBytes: number;
  constructor(private readonly readable: Readable, private readonly writable: Writable,
    receive: (value: unknown) => void, private readonly failure: (error: Error) => void,
    limits: { maxFrameBytes?: number; maxBufferedBytes?: number } = {}) {
    this.maxFrameBytes = limits.maxFrameBytes ?? GRAPH_WORKER_MAX_FRAME_BYTES;
    this.maxBufferedBytes = limits.maxBufferedBytes ?? this.maxFrameBytes * 2 + 8;
    const decoder = new WorkerFrameDecoder(value => { if (!this.closed) receive(value); }, this.maxFrameBytes);
    readable.on('data', (chunk: Buffer) => { try { decoder.push(chunk); } catch (error) { this.fail(error); } });
    readable.on('end', () => this.fail(new Error('WORKER_TRANSPORT_EOF')));
    readable.on('error', error => this.fail(error));
    writable.on('error', error => this.fail(error));
  }
  send(value: unknown): void {
    if (this.closed) throw new Error('WORKER_TRANSPORT_CLOSED');
    const frame = encodeWorkerFrame(value, this.maxFrameBytes);
    if (this.writable.writableLength + frame.length > this.maxBufferedBytes) throw new Error('WORKER_BACKPRESSURE');
    this.writable.write(frame, error => { if (error) this.fail(error); });
  }
  private fail(error: unknown): void {
    if (this.closed) return;
    this.close(); this.failure(error instanceof Error ? error : new Error(String(error)));
  }
  close(): void { this.closed = true; this.readable.destroy(); this.writable.destroy(); }
}
