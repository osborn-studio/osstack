import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { withWrite } from "./db.js";
import { ImprovementPrTarget } from "./improvement-pr-deliveries.js";
import { approveImprovementProposal, improvementProposalDigest, listImprovementProposals } from "./improvement-proposals.js";

export type ImprovementExecutionState = "claimed" | "running" | "candidate_verified" | "candidate_failed";
export type ImprovementExecutionRequest = Record<string, unknown> & { proposal_digest: string };

export function improvementExecutionRequestDigest(request: ImprovementExecutionRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

/** Structural copy of the worktree handle, without a dependency on agents. */
export interface ImprovementExecutionWorktree {
  repoPath: string;
  worktreePath: string;
  branch: string;
  baseRef: string;
  rootPath: string;
}

/** Consistency identity for the local control plane, not an authentication credential. */
export interface ImprovementExecutionWorker { worker_id: string; generation: number }
export interface ImprovementExecutionStop { reason: string; requested_at: number; source: "operator" | "system_indeterminate" }

export interface ImprovementExecutionView {
  execution_id: string;
  proposal_id: string;
  request: ImprovementExecutionRequest;
  request_sha256: string;
  state: ImprovementExecutionState;
  worker?: ImprovementExecutionWorker;
  stop?: ImprovementExecutionStop;
  worktree?: ImprovementExecutionWorktree;
  result?: unknown;
  created_at: number;
  updated_at: number;
}

interface ExecutionRow {
  execution_id: string;
  proposal_id: string;
  request_json: string;
  request_sha256: string;
  state: ImprovementExecutionState;
  worker_id: string | null;
  worker_generation: number;
  stop_json: string | null;
  worktree_json: string | null;
  result_json: string | null;
  created_at: number;
  updated_at: number;
}

/** Durable candidate attempts. Replays report history; they never resume work. */
export class ImprovementExecutionRepository {
  constructor(private readonly db: Database.Database, private readonly dbPath: string) {}

  claim(input: { execution_id: string; proposal_id: string; request: ImprovementExecutionRequest; worker_id?: string; approve_proposal?: boolean; now: number }): {
    outcome: "claimed" | "replay"; execution: ImprovementExecutionView;
  } {
    checkIdentifier(input.execution_id);
    checkIdentifier(input.proposal_id);
    checkTime(input.now);
    if (input.worker_id !== undefined) checkIdentifier(input.worker_id);
    const requestJson = canonicalJson(input.request);
    const request = JSON.parse(requestJson) as ImprovementExecutionRequest;
    if (!request || Array.isArray(request) || typeof request !== "object"
      || typeof request.proposal_digest !== "string" || !/^[a-f0-9]{64}$/.test(request.proposal_digest)) {
      throw new Error("Improvement execution requires a proposal_digest");
    }
    const requestSha = improvementExecutionRequestDigest(request);
    return withWrite(this.db, this.dbPath, (d) => {
      const existing = this.row(input.execution_id);
      if (existing !== undefined) {
        if (existing.proposal_id !== input.proposal_id || existing.request_json !== requestJson || existing.request_sha256 !== requestSha) {
          throw new Error(`Improvement execution request conflict: ${input.execution_id}`);
        }
        return { outcome: "replay", execution: toView(existing) };
      }
      const target = request.mode === "local_candidate_to_pr" ? ImprovementPrTarget.parse(request.pr_delivery) : undefined;
      if (input.approve_proposal) {
        if (!target) throw new Error("Combined approval requires a bound PR target");
        const current = listImprovementProposals(d, { proposal_id: input.proposal_id })[0];
        if (!current || !["draft", "approved"].includes(current.status)) throw new Error("Combined approval supports draft or approved proposals only");
        approveImprovementProposal(d, this.dbPath, { proposal_id: input.proposal_id, expected_digest: request.proposal_digest, now: input.now });
      }
      const proposal = listImprovementProposals(d, { proposal_id: input.proposal_id })[0];
      if (proposal?.status !== "approved") throw new Error("Improvement execution requires an approved proposal");
      if (improvementProposalDigest(proposal) !== request.proposal_digest) throw new Error("Improvement proposal digest conflict");
      const active = d.prepare("SELECT execution_id FROM improvement_executions WHERE proposal_id = ? AND state IN ('claimed','running')").get(input.proposal_id);
      const deliveryActive = d.prepare(`SELECT p.execution_id FROM improvement_pr_deliveries p
        JOIN improvement_executions e ON e.execution_id = p.execution_id
        WHERE e.proposal_id = ? AND p.state != 'blocked'`).get(input.proposal_id);
      if (active !== undefined || deliveryActive !== undefined) throw new Error(`Improvement proposal already has an active execution: ${input.proposal_id}`);
      d.prepare(`INSERT INTO improvement_executions
        (execution_id, proposal_id, request_json, request_sha256, state, created_at, updated_at, worker_id)
        VALUES (?, ?, ?, ?, 'claimed', ?, ?, ?)`)
        .run(input.execution_id, input.proposal_id, requestJson, requestSha, input.now, input.now, input.worker_id ?? randomUUID());
      if (target !== undefined) d.prepare(`INSERT INTO improvement_pr_deliveries
        (execution_id, target_json, state, created_at, updated_at) VALUES (?, ?, 'authorized', ?, ?)`)
        .run(input.execution_id, JSON.stringify(target), input.now, input.now);
      return { outcome: "claimed", execution: toView(this.requireRow(input.execution_id)) };
    });
  }

  recordWorktree(id: string, descriptor: ImprovementExecutionWorktree, now: number, worker?: ImprovementExecutionWorker): ImprovementExecutionView {
    checkTime(now);
    const worktreeJson = canonicalJson(descriptor);
    const worktree = JSON.parse(worktreeJson) as ImprovementExecutionWorktree;
    if (!worktree || Array.isArray(worktree) || typeof worktree !== "object"
      || [worktree.repoPath, worktree.worktreePath, worktree.branch, worktree.baseRef, worktree.rootPath]
        .some((part) => typeof part !== "string" || part.trim() === "" || part.includes("\0"))) {
      throw new Error("Invalid improvement execution worktree descriptor");
    }
    return withWrite(this.db, this.dbPath, (d) => {
      const existing = this.requireRow(id);
      assertWritable(existing, worker);
      if (isTerminal(existing.state)) throw new Error("Cannot change a terminal improvement execution worktree");
      if (existing.state === "running") {
        if (existing.worktree_json !== worktreeJson) throw new Error("Improvement execution worktree conflict");
        return toView(existing);
      }
      const changed = d.prepare(`UPDATE improvement_executions SET state = 'running', worktree_json = ?, updated_at = ?
        WHERE execution_id = ? AND state = 'claimed'`).run(worktreeJson, now, id);
      if (changed.changes !== 1) throw new Error("Improvement execution worktree CAS conflict");
      return toView(this.requireRow(id));
    });
  }

  complete(id: string, state: "candidate_verified" | "candidate_failed", result: unknown, now: number, worker?: ImprovementExecutionWorker): ImprovementExecutionView {
    checkTime(now);
    if (!isTerminal(state)) throw new Error("Invalid terminal improvement execution state");
    const resultJson = canonicalJson(result);
    return withWrite(this.db, this.dbPath, (d) => {
      const existing = this.requireRow(id);
      assertWritable(existing, worker);
      if (isTerminal(existing.state)) {
        if (existing.state !== state || existing.result_json !== resultJson) throw new Error("Improvement execution terminal result conflict");
        return toView(existing);
      }
      if (state === "candidate_verified" && (existing.state !== "running" || existing.worktree_json === null)) {
        throw new Error("Only a running improvement execution with a worktree can be candidate_verified");
      }
      const changed = d.prepare(`UPDATE improvement_executions SET state = ?, result_json = ?, updated_at = ?
        WHERE execution_id = ? AND state = ?`).run(state, resultJson, now, id, existing.state);
      if (changed.changes !== 1) throw new Error("Improvement execution completion CAS conflict");
      return toView(this.requireRow(id));
    });
  }

  /** Stage-boundary check only: it cannot stop OS processes or already issued I/O. */
  assertWorker(id: string, worker?: ImprovementExecutionWorker): void {
    const row = this.requireRow(id);
    assertWritable(row, worker);
    if (isTerminal(row.state)) throw new Error("Improvement execution is already terminal");
  }

  /** Invalidates controlled writes but retains the active slot until recovery can prove quiescence. */
  requestStop(id: string, reason: string, now: number, source: ImprovementExecutionStop["source"] = "operator"): ImprovementExecutionView {
    checkTime(now);
    if (source !== "operator" && source !== "system_indeterminate") throw new Error("Invalid improvement execution stop source");
    if (typeof reason !== "string" || reason.trim() === "" || reason.length > 2000 || reason.includes("\0")) {
      throw new Error("Improvement execution stop requires a reason of 1..2000 characters");
    }
    return withWrite(this.db, this.dbPath, (d) => {
      const existing = this.requireRow(id);
      d.prepare(`UPDATE improvement_pr_deliveries SET stop_json = COALESCE(stop_json, ?), updated_at = ?
        WHERE execution_id = ? AND state NOT IN ('delivered','blocked') AND stop_json IS NULL`)
        .run(canonicalJson({ reason, requested_at: now, source }), now, id);
      if (isTerminal(existing.state) || existing.stop_json !== null) return toView(existing);
      d.prepare(`UPDATE improvement_executions SET stop_json = ?, worker_generation = worker_generation + 1, updated_at = ?
        WHERE execution_id = ?`).run(canonicalJson({ reason, requested_at: now, source }), now, id);
      return toView(this.requireRow(id));
    });
  }

  get(id: string): ImprovementExecutionView | undefined {
    const row = this.row(id);
    return row === undefined ? undefined : toView(row);
  }

  list(options: { proposal_id?: string; state?: ImprovementExecutionState; limit?: number } = {}): ImprovementExecutionView[] {
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (options.proposal_id !== undefined) { where.push("proposal_id = ?"); values.push(options.proposal_id); }
    if (options.state !== undefined) { where.push("state = ?"); values.push(options.state); }
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Improvement execution list limit must be 1..1000");
    const rows = this.db.prepare(`SELECT * FROM improvement_executions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, execution_id LIMIT ?`).all(...values, limit) as ExecutionRow[];
    return rows.map(toView);
  }

  /** One SELECT gives one SQLite snapshot; never summarize a paginated list. */
  baseline(options: { now: number; proposal_id?: string }) {
    checkTime(options.now);
    const rows = this.db.prepare(`SELECT * FROM improvement_executions
      ${options.proposal_id === undefined ? "" : "WHERE proposal_id = ?"} ORDER BY execution_id`)
      .all(...(options.proposal_id === undefined ? [] : [options.proposal_id])) as ExecutionRow[];
    const counts = { total: rows.length, claimed: 0, running: 0, candidate_verified: 0, candidate_failed: 0 };
    const stopRequests = { operator: 0, system_indeterminate: 0 };
    const records = rows.map((row) => {
      const view = toView(row);
      counts[view.state]++;
      if (view.stop !== undefined) stopRequests[view.stop.source]++;
      return {
        execution_id: view.execution_id, proposal_id: view.proposal_id, state: view.state,
        request_sha256: view.request_sha256, request: view.request,
        created_at: view.created_at, updated_at: view.updated_at,
        ...(view.worker === undefined ? {} : { worker: view.worker }),
        ...(view.stop === undefined ? {} : { stop: view.stop }),
      };
    });
    const snapshot = {
      schema_version: 1, observed_at: options.now, proposal_id: options.proposal_id ?? null,
      endpoint: "candidate_verification", delivery_effectiveness: "not_measured",
      cost_usd: null, cost_status: "not_collected", manual_go_count: null,
      counts, stop_requests: stopRequests, records,
    };
    return { ...snapshot, sha256: createHash("sha256").update(canonicalJson(snapshot)).digest("hex") };
  }

  private row(id: string): ExecutionRow | undefined {
    return this.db.prepare("SELECT * FROM improvement_executions WHERE execution_id = ?").get(id) as ExecutionRow | undefined;
  }

  private requireRow(id: string): ExecutionRow {
    const row = this.row(id);
    if (row === undefined) throw new Error(`Improvement execution not found: ${id}`);
    return row;
  }
}

function toView(row: ExecutionRow): ImprovementExecutionView {
  return {
    execution_id: row.execution_id, proposal_id: row.proposal_id,
    request: JSON.parse(row.request_json) as ImprovementExecutionRequest, request_sha256: row.request_sha256,
    state: row.state,
    ...(row.worker_id === null ? {} : { worker: { worker_id: row.worker_id, generation: row.worker_generation } }),
    ...(row.stop_json === null ? {} : { stop: JSON.parse(row.stop_json) as ImprovementExecutionStop }),
    ...(row.worktree_json === null ? {} : { worktree: JSON.parse(row.worktree_json) as ImprovementExecutionWorktree }),
    ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as unknown }),
    created_at: row.created_at, updated_at: row.updated_at,
  };
}

function assertWritable(row: ExecutionRow, worker?: ImprovementExecutionWorker): void {
  if (row.stop_json !== null) throw new Error("Improvement execution stop requested; active slot retained, worker termination unconfirmed");
  if (row.worker_id !== null && (worker?.worker_id !== row.worker_id || worker.generation !== row.worker_generation)) {
    throw new Error("Improvement execution worker identity or generation conflict");
  }
  if (row.worker_id === null && worker !== undefined) throw new Error("Legacy improvement execution has no bound worker");
}

function isTerminal(state: ImprovementExecutionState): boolean {
  return state === "candidate_verified" || state === "candidate_failed";
}

function checkIdentifier(id: string): void {
  if (typeof id !== "string" || id.trim() === "" || id.length > 256 || id.includes("\0")) throw new Error("Invalid improvement execution identifier");
}

function checkTime(now: number): void {
  if (!Number.isFinite(now) || now < 0) throw new Error("Invalid improvement execution timestamp");
}

/** Canonical JSON rejects values that JSON.stringify would silently reinterpret. */
function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || ancestors.has(value)) throw new Error("Improvement execution requires finite, acyclic JSON values");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${Array.from(value, (item) => canonicalJson(item, ancestors)).join(",")}]`;
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Improvement execution requires plain JSON objects");
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
