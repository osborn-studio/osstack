import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  parseGraphCheckpointRequest, parseGraphCheckpointResponse,
  GRAPH_CHECKPOINT_MAX_FRAME_BYTES, GRAPH_CHECKPOINT_MAX_TUPLE_BYTES,
  type GraphCheckpointRequest, type GraphCheckpointResponse, type GraphCheckpointTupleWire,
} from '@osstack/protocol';
import type { GraphRun, GraphRunFence } from './graph-runs.js';
import { fencedGraphTransaction } from './graph-storage.js';

type Put = Extract<GraphCheckpointRequest, { kind: 'put' }>;
type Writes = Extract<GraphCheckpointRequest, { kind: 'writes' }>;
type Address = { threadId: string; namespace: string; checkpointId: string };
interface CheckpointRow { namespace: string; checkpoint_id: string; parent_checkpoint_id: string | null;
  checkpoint: string; metadata: string; new_versions: string }
interface WriteRow { task_id: string; channel: string; write_index: number; value: string }
// Pinned checkpoint 1.1.5 public WRITES_IDX_MAP. Cross-package test compares with
// the installed SDK; core never imports LangGraph or decodes its codec payloads.
const reserved: Readonly<Record<string, number>> = { __error__: -1, __scheduled__: -2, __interrupt__: -3, __resume__: -4 };
const fail = (code: string): never => { throw new Error(code); };
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

/** Trusted daemon-only storage, in the control-plane DB. Authorization is supplied
 * by a fixed host binding; checkpoint JSON cannot select scope/owner/generation.
 * Every operation, including reads and replay, fences under BEGIN IMMEDIATE.
 * Return means SQLite COMMIT completed (existing WAL/NORMAL policy), not a claim
 * of power-loss durability or of atomicity with external effects. */
export interface GraphCheckpointLimits { checkpoints: number; pendingWrites: number; requests: number; bytes: number }
// Host storage limits, independent of worker data and model token budgets. The
// compiler must account for these ceilings; transport retries cannot grow history
// indefinitely under a valid lease. Hosts may tighten, never raise, the ceilings.
const RUN_LIMITS: Readonly<GraphCheckpointLimits> = Object.freeze({
  checkpoints: 1024, pendingWrites: 32_768, requests: 32_768, bytes: 64 * 1024 * 1024,
});
export class GraphCheckpointStore {
  private readonly limits: Readonly<GraphCheckpointLimits>;
  constructor(private readonly db: Database.Database, limits: Partial<GraphCheckpointLimits> = {}) {
    const resolved = { ...RUN_LIMITS, ...limits };
    for (const key of Object.keys(resolved) as (keyof GraphCheckpointLimits)[]) {
      if (!(key in RUN_LIMITS) || !Number.isSafeInteger(resolved[key]) || resolved[key] < 1 || resolved[key] > RUN_LIMITS[key]) fail('CHECKPOINT_QUOTA_INVALID');
    }
    this.limits = Object.freeze(resolved);
  }

  execute(fence: GraphRunFence, value: GraphCheckpointRequest): { run: GraphRun; response: GraphCheckpointResponse } {
    const request = parseGraphCheckpointRequest(value);
    if (request.threadId !== fence.graphRunId) fail('CHECKPOINT_THREAD_MISMATCH');
    const result = fencedGraphTransaction<GraphCheckpointResponse>(this.db, fence, () => {
      if (request.kind === 'get') {
        const row = this.db.prepare(`SELECT * FROM graph_checkpoints WHERE graph_run_id = ? AND namespace = ?
          ${request.checkpointId ? 'AND checkpoint_id = ?' : ''} ORDER BY checkpoint_id DESC LIMIT 1`)
          .get(request.threadId, request.namespace, ...(request.checkpointId ? [request.checkpointId] : [])) as CheckpointRow | undefined;
        return { value: { kind: 'get', tuple: row ? this.tuple(request.threadId, row) : null }, changed: false };
      }
      if (request.kind === 'list') return { value: this.list(request), changed: false };
      // Fence has already checked live lease and revision, even for cached IDs.
      const digest = createHash('sha256').update(canonical(request)).digest('hex');
      const prior = this.db.prepare('SELECT payload_digest, response_json FROM graph_checkpoint_requests WHERE graph_run_id = ? AND request_id = ?')
        .get(request.threadId, request.requestId) as { payload_digest: string; response_json: string } | undefined;
      if (prior) {
        if (prior.payload_digest !== digest) fail('IDEMPOTENCY_CONFLICT');
        return { value: parseGraphCheckpointResponse(JSON.parse(prior.response_json)), changed: false };
      }
      const response: GraphCheckpointResponse = request.kind === 'put' ? this.put(request) : this.writes(request);
      this.db.prepare(`INSERT INTO graph_checkpoint_requests (graph_run_id, request_id, payload_digest, response_json, generation)
        VALUES (?, ?, ?, ?, ?)`).run(request.threadId, request.requestId, digest, JSON.stringify(response), fence.expectedGeneration);
      this.checkRunLimits(request.threadId);
      return { value: response, changed: true };
    });
    return { run: result.run, response: result.value };
  }

  private checkRunLimits(runId: string): void {
    // Check counts before scanning bounded payload bytes. All queries and the new
    // rows are inside the same fenced transaction, so quota failure rolls back
    // checkpoint/writes, dedup receipt AND revision. Reads/replays remain usable.
    const counts = this.db.prepare(`SELECT
      (SELECT count(*) FROM graph_checkpoints WHERE graph_run_id = ?) AS checkpoints,
      (SELECT count(*) FROM graph_checkpoint_writes WHERE graph_run_id = ?) AS pendingWrites,
      (SELECT count(*) FROM graph_checkpoint_requests WHERE graph_run_id = ?) AS requests`)
      .get(runId, runId, runId) as Omit<GraphCheckpointLimits, 'bytes'>;
    if (counts.checkpoints > this.limits.checkpoints || counts.pendingWrites > this.limits.pendingWrites
      || counts.requests > this.limits.requests) fail('CHECKPOINT_RUN_LIMIT');
    const usage = this.db.prepare(`SELECT
      coalesce((SELECT sum(octet_length(checkpoint) + octet_length(metadata) + octet_length(new_versions)) FROM graph_checkpoints WHERE graph_run_id = ?), 0)
      + coalesce((SELECT sum(octet_length(value)) FROM graph_checkpoint_writes WHERE graph_run_id = ?), 0)
      + coalesce((SELECT sum(octet_length(response_json)) FROM graph_checkpoint_requests WHERE graph_run_id = ?), 0) AS bytes`)
      .get(runId, runId, runId) as { bytes: number };
    if (usage.bytes > this.limits.bytes) fail('CHECKPOINT_RUN_LIMIT');
  }

  private pending(address: Address): GraphCheckpointTupleWire['pendingWrites'] {
    const size = this.db.prepare(`SELECT count(*) AS count, coalesce(sum(octet_length(value)), 0) AS bytes
      FROM graph_checkpoint_writes WHERE graph_run_id = ? AND namespace = ? AND checkpoint_id = ?`)
      .get(address.threadId, address.namespace, address.checkpointId) as { count: number; bytes: number };
    if (size.count > 4096 || size.bytes > GRAPH_CHECKPOINT_MAX_TUPLE_BYTES) fail('CHECKPOINT_TUPLE_LIMIT');
    const rows = this.db.prepare(`SELECT task_id, channel, write_index, value FROM graph_checkpoint_writes
      WHERE graph_run_id = ? AND namespace = ? AND checkpoint_id = ? ORDER BY task_id, write_index LIMIT 4097`)
      .all(address.threadId, address.namespace, address.checkpointId) as WriteRow[];
    if (rows.length > 4096) fail('CHECKPOINT_TUPLE_LIMIT');
    return rows.map((row) => ({ taskId: row.task_id, channel: row.channel, index: row.write_index, value: row.value }));
  }
  private tuple(threadId: string, row: CheckpointRow): GraphCheckpointTupleWire {
    const address = { threadId, namespace: row.namespace, checkpointId: row.checkpoint_id };
    const tuple: GraphCheckpointTupleWire = { ...address, ...(row.parent_checkpoint_id ? { parentCheckpointId: row.parent_checkpoint_id } : {}),
      checkpoint: row.checkpoint, metadata: row.metadata, newVersions: row.new_versions, pendingWrites: this.pending(address) };
    if (Buffer.byteLength(JSON.stringify(tuple)) > GRAPH_CHECKPOINT_MAX_TUPLE_BYTES) fail('CHECKPOINT_TUPLE_LIMIT');
    return tuple;
  }
  private checkSize(address: Address): void {
    const row = this.db.prepare('SELECT * FROM graph_checkpoints WHERE graph_run_id = ? AND namespace = ? AND checkpoint_id = ?')
      .get(address.threadId, address.namespace, address.checkpointId) as CheckpointRow | undefined;
    if (row) { this.tuple(address.threadId, row); return; }
    // Pending writes may precede put. Still bound their accumulated footprint.
    if (Buffer.byteLength(JSON.stringify(this.pending(address))) > GRAPH_CHECKPOINT_MAX_TUPLE_BYTES - 4096) fail('CHECKPOINT_TUPLE_LIMIT');
  }
  private put(request: Put): GraphCheckpointResponse {
    if (request.parentCheckpointId && Buffer.compare(Buffer.from(request.parentCheckpointId), Buffer.from(request.checkpointId)) >= 0) fail('CHECKPOINT_PARENT_INVALID');
    const prior = this.db.prepare('SELECT * FROM graph_checkpoints WHERE graph_run_id = ? AND namespace = ? AND checkpoint_id = ?')
      .get(request.threadId, request.namespace, request.checkpointId) as CheckpointRow | undefined;
    if (prior) {
      if (prior.checkpoint !== request.checkpoint || prior.metadata !== request.metadata || prior.new_versions !== request.newVersions
        || prior.parent_checkpoint_id !== (request.parentCheckpointId ?? null)) fail('CHECKPOINT_ID_CONFLICT');
    } else {
      this.db.prepare(`INSERT INTO graph_checkpoints (graph_run_id, namespace, checkpoint_id, parent_checkpoint_id, checkpoint, metadata, new_versions)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(request.threadId, request.namespace, request.checkpointId,
          request.parentCheckpointId ?? null, request.checkpoint, request.metadata, request.newVersions);
    }
    this.checkSize(request);
    return { kind: 'put', checkpointId: request.checkpointId };
  }
  private writes(request: Writes): GraphCheckpointResponse {
    for (const [position, write] of request.writes.entries()) {
      const index = Object.hasOwn(reserved, write.channel) ? reserved[write.channel]! : position;
      if (write.index !== index) fail('CHECKPOINT_WRITE_INDEX');
      this.db.prepare(`INSERT INTO graph_checkpoint_writes (graph_run_id, namespace, checkpoint_id, task_id, write_index, channel, value)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(graph_run_id, namespace, checkpoint_id, task_id, write_index)
        ${index < 0 ? 'DO UPDATE SET channel = excluded.channel, value = excluded.value' : 'DO NOTHING'}`)
        .run(request.threadId, request.namespace, request.checkpointId, request.taskId, index, write.channel, write.value);
    }
    this.checkSize(request);
    return { kind: 'writes' };
  }
  private list(request: Extract<GraphCheckpointRequest, { kind: 'list' }>): GraphCheckpointResponse {
    const where = ['graph_run_id = ?']; const args: (string | number)[] = [request.threadId];
    if (request.namespace !== undefined) { where.push('namespace = ?'); args.push(request.namespace); }
    if (request.checkpointId) { where.push('checkpoint_id = ?'); args.push(request.checkpointId); }
    if (request.before) { where.push('checkpoint_id < ?'); args.push(request.before); }
    if (request.cursor) {
      where.push('(checkpoint_id < ? OR (checkpoint_id = ? AND namespace < ?))');
      args.push(request.cursor.checkpointId, request.cursor.checkpointId, request.cursor.namespace);
    }
    // Fetch IDs first; never allocate pageSize times the maximum tuple size.
    const ids = this.db.prepare(`SELECT namespace, checkpoint_id FROM graph_checkpoints WHERE ${where.join(' AND ')}
      ORDER BY checkpoint_id DESC, namespace DESC LIMIT ?`).all(...args, request.pageSize + 1) as { namespace: string; checkpoint_id: string }[];
    const tuples: GraphCheckpointTupleWire[] = [];
    let bytes = 1024;
    for (const id of ids.slice(0, request.pageSize)) {
      const row = this.db.prepare('SELECT * FROM graph_checkpoints WHERE graph_run_id = ? AND namespace = ? AND checkpoint_id = ?')
        .get(request.threadId, id.namespace, id.checkpoint_id) as CheckpointRow;
      const tuple = this.tuple(request.threadId, row);
      const size = Buffer.byteLength(JSON.stringify(tuple)) + 1;
      if (bytes + size > GRAPH_CHECKPOINT_MAX_FRAME_BYTES) break;
      // JSON traversal/node limits also bound transport. A page of many tiny
      // writes can hit those before the byte cap. Include cursor overhead now,
      // so every page we return is transportable without dropping any rows.
      try {
        parseGraphCheckpointResponse({ kind: 'list', tuples: [...tuples, tuple],
          cursor: { namespace: tuple.namespace, checkpointId: tuple.checkpointId } });
      } catch (error) {
        if (tuples.length && error instanceof Error && error.message === 'CHECKPOINT_FRAME_LIMIT') break;
        throw error;
      }
      bytes += size; tuples.push(tuple);
    }
    const last = tuples.at(-1);
    return { kind: 'list', tuples, ...(last && ids.length > tuples.length
      ? { cursor: { namespace: last.namespace, checkpointId: last.checkpointId } } : {}) };
  }
}
