import { randomUUID } from 'node:crypto';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver, WRITES_IDX_MAP, getCheckpointId,
  type Checkpoint, type CheckpointMetadata, type CheckpointListOptions,
  type CheckpointTuple, type ChannelVersions, type PendingWrite,
} from '@langchain/langgraph-checkpoint';
import {
  GRAPH_CHECKPOINT_MAX_PAGE_SIZE, GRAPH_CHECKPOINT_MAX_FRAME_BYTES, parseGraphCheckpointRequest, parseGraphCheckpointResponse,
  type GraphCheckpointRequest, type GraphCheckpointResponse, type GraphCheckpointTransport,
  type GraphCheckpointTupleWire,
} from '@osstack/protocol';
import { CheckpointCodec, assertCheckpointV4 } from './checkpoint-codec.js';

// Match SQLite BINARY ordering, including non-ASCII namespace names.
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Worker-only saver. Host supplies an authenticated, fixed-run transport closure.
 * A transport retry MUST reuse the same request (including requestId). Rejections
 * are propagated: the saver cannot infer external effect outcome from lost ACKs. */
export class RemoteCheckpointSaver extends BaseCheckpointSaver {
  private readonly codec: CheckpointCodec;
  constructor(private readonly threadId: string, private readonly transport: GraphCheckpointTransport) {
    const codec = new CheckpointCodec({ allowBytes: true });
    super(codec);
    this.codec = codec;
    parseGraphCheckpointRequest({ kind: 'get', threadId, namespace: '' });
  }

  private address(config: RunnableConfig, allNamespaces = false) {
    const thread = config.configurable?.['thread_id'];
    if (thread !== undefined && thread !== this.threadId) throw new Error('CHECKPOINT_THREAD_MISMATCH');
    const ns: unknown = config.configurable?.['checkpoint_ns'];
    if (ns !== undefined && typeof ns !== 'string') throw new Error('CHECKPOINT_NAMESPACE_INVALID');
    const checkpointId = getCheckpointId(config);
    return { threadId: this.threadId, ...(ns !== undefined ? { namespace: ns } : allNamespaces ? {} : { namespace: '' }),
      ...(checkpointId ? { checkpointId } : {}) };
  }
  private encode(value: unknown): string { return Buffer.from(this.codec.encode(value)).toString('utf8'); }
  private async call(request: GraphCheckpointRequest): Promise<GraphCheckpointResponse> {
    const response = parseGraphCheckpointResponse(await this.transport(parseGraphCheckpointRequest(request)));
    if (response.kind !== request.kind) throw new Error('CHECKPOINT_RESPONSE_MISMATCH');
    return response;
  }
  private tuple(wire: GraphCheckpointTupleWire): CheckpointTuple {
    if (wire.threadId !== this.threadId) throw new Error('CHECKPOINT_THREAD_MISMATCH');
    const checkpoint = this.codec.decode(wire.checkpoint);
    assertCheckpointV4(checkpoint);
    if (checkpoint.id !== wire.checkpointId) throw new Error('CHECKPOINT_ID_MISMATCH');
    const config = (id: string): RunnableConfig => ({ configurable: {
      thread_id: this.threadId, checkpoint_ns: wire.namespace, checkpoint_id: id,
    } });
    return { config: config(wire.checkpointId), checkpoint,
      metadata: this.codec.decode(wire.metadata) as CheckpointMetadata,
      ...(wire.parentCheckpointId ? { parentConfig: config(wire.parentCheckpointId) } : {}),
      pendingWrites: wire.pendingWrites.map((w) => [w.taskId, w.channel, this.codec.decode(w.value)]),
    };
  }
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const address = this.address(config);
    const response = await this.call({ kind: 'get', ...address, namespace: address.namespace ?? '' });
    if (response.kind !== 'get' || !response.tuple) return undefined;
    if (response.tuple.namespace !== address.namespace || (address.checkpointId && response.tuple.checkpointId !== address.checkpointId)) {
      throw new Error('CHECKPOINT_RESPONSE_MISMATCH');
    }
    return this.tuple(response.tuple);
  }
  async *list(config: RunnableConfig, options: CheckpointListOptions = {}): AsyncGenerator<CheckpointTuple> {
    const address = this.address(config, true);
    if (options.before) this.address(options.before);
    let remaining = options.limit ?? Infinity;
    if (remaining !== Infinity && (!Number.isSafeInteger(remaining) || remaining < 0)) throw new Error('CHECKPOINT_LIMIT_INVALID');
    const before = options.before ? getCheckpointId(options.before) : undefined;
    let cursor: { namespace: string; checkpointId: string } | undefined;
    while (remaining > 0) {
      const response = await this.call({ kind: 'list', ...address, ...(before ? { before } : {}),
        ...(cursor ? { cursor } : {}), pageSize: GRAPH_CHECKPOINT_MAX_PAGE_SIZE });
      if (response.kind !== 'list') throw new Error('CHECKPOINT_RESPONSE_MISMATCH');
      let previous = cursor;
      for (const wire of response.tuples) {
        if (previous && (compare(wire.checkpointId, previous.checkpointId) > 0
          || (wire.checkpointId === previous.checkpointId && compare(wire.namespace, previous.namespace) >= 0))) {
          throw new Error('CHECKPOINT_CURSOR_INVALID');
        }
        previous = wire;
      }
      const last = response.tuples.at(-1);
      if (response.cursor && (!last || response.cursor.checkpointId !== last.checkpointId || response.cursor.namespace !== last.namespace)) {
        throw new Error('CHECKPOINT_CURSOR_INVALID');
      }
      for (const wire of response.tuples) {
        if ((address.namespace !== undefined && wire.namespace !== address.namespace)
          || (address.checkpointId && wire.checkpointId !== address.checkpointId)
          || (before && compare(wire.checkpointId, before) >= 0)) throw new Error('CHECKPOINT_RESPONSE_MISMATCH');
        const tuple = this.tuple(wire);
        if (options.filter && !Object.entries(options.filter).every(([key, value]) => {
          const actual = (tuple.metadata as Record<string, unknown> | undefined)?.[key];
          return actual !== undefined && this.encode(actual) === this.encode(value);
        })) continue;
        yield tuple;
        if (--remaining <= 0) return;
      }
      if (!response.cursor) return;
      if (cursor && (compare(response.cursor.checkpointId, cursor.checkpointId) > 0
        || (response.cursor.checkpointId === cursor.checkpointId && compare(response.cursor.namespace, cursor.namespace) >= 0))) {
        throw new Error('CHECKPOINT_CURSOR_INVALID');
      }
      cursor = response.cursor;
    }
  }
  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, newVersions: ChannelVersions): Promise<RunnableConfig> {
    const address = this.address(config);
    const checkpointWire = this.encode(checkpoint);
    const snapshot = this.codec.decode(checkpointWire);
    assertCheckpointV4(snapshot);
    const response = await this.call({ kind: 'put', requestId: randomUUID(), threadId: this.threadId,
      namespace: address.namespace ?? '', checkpointId: snapshot.id,
      ...(address.checkpointId ? { parentCheckpointId: address.checkpointId } : {}),
      checkpoint: checkpointWire, metadata: this.encode(metadata), newVersions: this.encode(newVersions) });
    if (response.kind !== 'put' || response.checkpointId !== snapshot.id) throw new Error('CHECKPOINT_RESPONSE_MISMATCH');
    return { configurable: { thread_id: this.threadId, checkpoint_ns: address.namespace ?? '', checkpoint_id: snapshot.id } };
  }
  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const address = this.address(config);
    if (!address.checkpointId) throw new Error('CHECKPOINT_ID_REQUIRED');
    if (!Array.isArray(writes) || writes.length > 4096) throw new Error('CHECKPOINT_FRAME_LIMIT');
    const request: Extract<GraphCheckpointRequest, { kind: 'writes' }> = {
      kind: 'writes', requestId: randomUUID(), threadId: this.threadId,
      namespace: address.namespace ?? '', checkpointId: address.checkpointId, taskId, writes: [],
    };
    parseGraphCheckpointRequest(request);
    let bytes = Buffer.byteLength(JSON.stringify(request));
    for (const [position, [channel, value]] of writes.entries()) {
      const write = { channel, index: Object.hasOwn(WRITES_IDX_MAP, channel) ? WRITES_IDX_MAP[channel]! : position,
        value: this.encode(value) };
      bytes += Buffer.byteLength(JSON.stringify(write)) + 1;
      if (bytes > GRAPH_CHECKPOINT_MAX_FRAME_BYTES) throw new Error('CHECKPOINT_FRAME_LIMIT');
      request.writes.push(write);
    }
    await this.call(request);
  }
  async deleteThread(_threadId: string): Promise<void> { throw new Error('CHECKPOINT_DELETE_UNSUPPORTED'); }
}
