import { types } from 'node:util';
import { z } from 'zod';

export const GRAPH_CHECKPOINT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const GRAPH_CHECKPOINT_MAX_TUPLE_BYTES = 4 * 1024 * 1024;
export const GRAPH_CHECKPOINT_MAX_PAGE_SIZE = 16;
const id = z.string().min(1).max(256);
const namespace = z.string().max(1024);
const wire = z.string().max(1_048_576).refine((s) => Buffer.byteLength(s, 'utf8') <= 1_048_576);
const cursor = z.object({ namespace, checkpointId: id }).strict();
const write = z.object({ channel: id, index: z.number().int().min(-4).max(4095), value: wire }).strict();
const address = { threadId: id, namespace, checkpointId: id };
export const GraphCheckpointTupleWire = z.object({
  ...address, parentCheckpointId: id.optional(), checkpoint: wire, metadata: wire, newVersions: wire,
  pendingWrites: z.array(write.extend({ taskId: id })).max(4096),
}).strict();
export type GraphCheckpointTupleWire = z.infer<typeof GraphCheckpointTupleWire>;
export const GraphCheckpointRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('get'), ...address, checkpointId: id.optional() }).strict(),
  z.object({ kind: z.literal('list'), threadId: id, namespace: namespace.optional(), checkpointId: id.optional(),
    before: id.optional(), cursor: cursor.optional(), pageSize: z.number().int().min(1).max(GRAPH_CHECKPOINT_MAX_PAGE_SIZE) }).strict(),
  z.object({ kind: z.literal('put'), requestId: id, ...address, parentCheckpointId: id.optional(),
    checkpoint: wire, metadata: wire, newVersions: wire }).strict(),
  z.object({ kind: z.literal('writes'), requestId: id, ...address, taskId: id, writes: z.array(write).max(4096) }).strict(),
]);
export type GraphCheckpointRequest = z.infer<typeof GraphCheckpointRequest>;
export const GraphCheckpointResponse = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('get'), tuple: GraphCheckpointTupleWire.nullable() }).strict(),
  z.object({ kind: z.literal('list'), tuples: z.array(GraphCheckpointTupleWire).max(GRAPH_CHECKPOINT_MAX_PAGE_SIZE), cursor: cursor.optional() }).strict(),
  z.object({ kind: z.literal('put'), checkpointId: id }).strict(),
  z.object({ kind: z.literal('writes') }).strict(),
]);
export type GraphCheckpointResponse = z.infer<typeof GraphCheckpointResponse>;
/** Supplied by trusted host binding. JSON fields never confer authenticated scope. */
export type GraphCheckpointTransport = (request: GraphCheckpointRequest) => Promise<GraphCheckpointResponse>;

// Iterative preflight rejects accessors/proxies through descriptors and bounds traversal
// before Zod or JSON.stringify sees untrusted trees. Transport still caps raw frames.
function bounded(value: unknown): void {
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  let bytes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++nodes > 100_000 || item.depth > 16) throw new Error('CHECKPOINT_FRAME_LIMIT');
    bytes += 8;
    if (bytes > GRAPH_CHECKPOINT_MAX_FRAME_BYTES) throw new Error('CHECKPOINT_FRAME_LIMIT');
    if (item.value === null || typeof item.value === 'boolean') continue;
    if (typeof item.value === 'number' && Number.isFinite(item.value)) continue;
    if (typeof item.value === 'string') {
      if (item.value.length > 1_048_576) throw new Error('CHECKPOINT_FRAME_LIMIT');
      bytes += Buffer.byteLength(JSON.stringify(item.value), 'utf8');
      if (bytes > GRAPH_CHECKPOINT_MAX_FRAME_BYTES) throw new Error('CHECKPOINT_FRAME_LIMIT');
      continue;
    }
    if (typeof item.value !== 'object' || types.isProxy(item.value)) throw new Error('CHECKPOINT_FRAME_INVALID');
    const proto = Object.getPrototypeOf(item.value);
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) throw new Error('CHECKPOINT_FRAME_INVALID');
    if (Array.isArray(item.value) && item.value.length > 100_000) throw new Error('CHECKPOINT_FRAME_LIMIT');
    const descriptors = Object.getOwnPropertyDescriptors(item.value);
    if (Array.isArray(item.value) && Object.keys(descriptors).length !== item.value.length + 1) throw new Error('CHECKPOINT_FRAME_INVALID');
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) throw new Error('CHECKPOINT_FRAME_INVALID');
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key.length > 1024) throw new Error('CHECKPOINT_FRAME_LIMIT');
      bytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 2;
      if (bytes > GRAPH_CHECKPOINT_MAX_FRAME_BYTES || stack.length > 100_000) throw new Error('CHECKPOINT_FRAME_LIMIT');
      if (Array.isArray(item.value) && key === 'length') continue;
      if (!('value' in descriptor) || !descriptor.enumerable || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('CHECKPOINT_FRAME_INVALID');
      stack.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > GRAPH_CHECKPOINT_MAX_FRAME_BYTES) throw new Error('CHECKPOINT_FRAME_LIMIT');
}
export function parseGraphCheckpointRequest(value: unknown): GraphCheckpointRequest {
  bounded(value); return GraphCheckpointRequest.parse(value);
}
export function parseGraphCheckpointResponse(value: unknown): GraphCheckpointResponse {
  bounded(value); return GraphCheckpointResponse.parse(value);
}
