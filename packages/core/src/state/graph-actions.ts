// Daemon-owned effect/resource authority, not a node scheduler. Never forward
// worker JSON to this port: G12 authenticates, authorizes the registry slot and
// verifies adapter evidence under G10 admission before using these methods.
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { GraphEffectIdentity, GraphJsonValue, GraphResult, WorkerActionRequest, computeGraphEffectKey } from "@osstack/protocol";
import type { GraphRun, GraphRunFence } from "./graph-runs.js";
import { fencedGraphTransaction } from "./graph-storage.js";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// biome-ignore lint/suspicious/noControlCharactersInRegex: Persisted references must reject control characters.
const ref = z.string().min(1).max(256).refine((v) => v.trim() === v && !/[\u0000-\u001f\u007f-\u009f]/.test(v));
const keySchema = z.string().regex(/^[a-f0-9]{64}$/);
const admissionSchema = z.object({ epoch: count.max(2), nodeId: ref, effectSlot: ref,
  reservationTokens: count, action: z.unknown() }).strict();
const uncertainSchema = z.object({ state: z.enum(["unknown", "cancel_pending"]), evidenceRef: ref, observedTokens: count }).strict();
const outcomeSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("confirmed"), evidenceRef: ref, actualTokens: count.nullable(), result: z.unknown() }).strict(),
  z.object({ state: z.literal("failed"), evidenceRef: ref, actualTokens: count.nullable(), error: z.unknown(), retrySafe: z.boolean() }).strict(),
]);

/** Host derives epoch/node/slot from the immutable compiled registry and pins its
 * token cap. This is NOT a worker authorization capability. nodeId identifies the
 * retry-budget branch: retries of all its slots share maxBranchAttempts per epoch. */
export interface GraphActionAdmission {
  epoch: number; nodeId: string; effectSlot: string;
  action: WorkerActionRequest["action"];
  reservationTokens: number;
}
export type GraphActionOutcomeInput =
  | { state: "confirmed"; evidenceRef: string; actualTokens: number; result: GraphResult }
  | { state: "failed"; evidenceRef: string; actualTokens: number; error: GraphJsonValue; retrySafe: boolean };
export type GraphActionOutcome =
  | { state: "confirmed"; evidenceRef: string; actualTokens: number | null; result: GraphResult }
  | { state: "failed"; evidenceRef: string; actualTokens: number | null; error: GraphJsonValue; retrySafe: boolean };
export type GraphActionUncertainty = z.infer<typeof uncertainSchema>;
export interface GraphAction {
  effectKey: string;
  effect: GraphEffectIdentity;
  action: WorkerActionRequest["action"];
  businessDigest: string;
  generation: number;
  reservationTokens: number;
  state: "intent" | "running" | "confirmed" | "failed" | "unknown" | "cancel_pending";
  executionRef: string | null;
  outcome: GraphActionOutcome | null;
  uncertainty: GraphActionUncertainty | null;
  actualTokens: number | null;
  observedTokens: number;
  accountingBlocked: boolean;
  retrySafe: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface GraphActionBudget {
  actionStarts: number;
  // Exact decimal totals: several independently overrun actions can exceed the
  // JS safe integer range. Never use SQLite SUM/REAL or round away real usage.
  reservedTokens: string;
  chargedTokens: string;
  accountingBlocked: boolean;
}
export interface GraphActionResult {
  action: GraphAction; run: GraphRun; budget: GraphActionBudget;
  created: boolean; changed: boolean;
}
export type GraphActionStorageErrorCode = "ADMISSION_RELEASE_PENDING" | "ORIGINAL_BUDGET_MISSING" | "ACTION_NOT_FOUND" | "ACTION_INPUT_CONFLICT"
  | "UNRESOLVED_ACTION" | "RETRY_NOT_SAFE" | "NOT_CURRENT_ATTEMPT" | "ACTION_GENERATION_MISMATCH"
  | "INVALID_ACTION_STATE" | "OUTCOME_CONFLICT" | "EXECUTION_CONFLICT" | "EPOCH_BUDGET_EXHAUSTED"
  | "BRANCH_BUDGET_EXHAUSTED" | "ACTION_BUDGET_EXHAUSTED" | "WALL_CLOCK_BUDGET_EXHAUSTED"
  | "TOKEN_BUDGET_EXHAUSTED" | "ACCOUNTING_BLOCKED" | "RUN_STOPPING";
export class GraphActionStorageError extends Error {
  constructor(public readonly code: GraphActionStorageErrorCode) { super(code); this.name = "GraphActionStorageError"; }
}
const fail = (code: GraphActionStorageErrorCode): never => { throw new GraphActionStorageError(code); };
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(",")}}`;
}
interface ActionRow {
  effect_key: string; effect_json: string; action_json: string; business_digest: string; generation: number;
  reservation_tokens: number; state: GraphAction["state"]; execution_ref: string | null;
  outcome_json: string | null; uncertainty_json: string | null; actual_tokens: number | null; observed_tokens: number;
  accounting_blocked: number; retry_safe: number; created_at: number; updated_at: number;
}
function decode(row: ActionRow): GraphAction {
  return { effectKey: row.effect_key, effect: JSON.parse(row.effect_json) as GraphEffectIdentity,
    action: JSON.parse(row.action_json) as WorkerActionRequest["action"], businessDigest: row.business_digest,
    generation: row.generation, reservationTokens: row.reservation_tokens, state: row.state,
    executionRef: row.execution_ref, outcome: row.outcome_json === null ? null : JSON.parse(row.outcome_json) as GraphActionOutcome,
    uncertainty: row.uncertainty_json === null ? null : JSON.parse(row.uncertainty_json) as GraphActionUncertainty,
    actualTokens: row.actual_tokens, observedTokens: row.observed_tokens, accountingBlocked: row.accounting_blocked === 1,
    retrySafe: row.retry_safe === 1, createdAt: row.created_at, updatedAt: row.updated_at };
}
interface Mutation { action: GraphAction; changed: boolean; created: boolean }

/** Internal core snapshot helper; callers own their fenced SQL transaction. */
export function readGraphActionState(db: Database.Database, graphRunId: string): { actions: GraphAction[]; budget: GraphActionBudget } {
  return { actions: (db.prepare("SELECT * FROM graph_actions WHERE graph_run_id=? ORDER BY epoch,node_id,effect_slot,logical_attempt").all(graphRunId) as ActionRow[]).map(decode), budget: graphActionBudget(db, graphRunId) };
}
function graphActionBudget(db: Database.Database, graphRunId: string): GraphActionBudget {
    let reserved = 0n; let charged = 0n; let actionStarts = 0; let accountingBlocked = false;
    // Ledger rows ARE the authoritative budget entries. Derived in the same
    // transaction, so there is no mutable budget mirror to reset on resume.
    const rows = db.prepare(`SELECT state, reservation_tokens, actual_tokens, observed_tokens, accounting_blocked
      FROM graph_actions WHERE graph_run_id = ?`).iterate(graphRunId) as Iterable<Pick<ActionRow,
        "state" | "reservation_tokens" | "actual_tokens" | "observed_tokens" | "accounting_blocked">>;
    for (const row of rows) {
      actionStarts++;
      accountingBlocked ||= row.accounting_blocked === 1;
      if ((row.state === "confirmed" || row.state === "failed") && row.actual_tokens !== null) {
        // Failed attempts consume their full reservation even if less usage was
        // reported. Unknown usage never releases capacity.
        charged += BigInt(row.state === "failed" ? Math.max(row.reservation_tokens, row.actual_tokens) : row.actual_tokens);
      } else reserved += BigInt(Math.max(row.reservation_tokens, row.observed_tokens));
    }
    return { actionStarts, reservedTokens: reserved.toString(), chargedTokens: charged.toString(), accountingBlocked };
}

export class GraphActionStore {
  constructor(private readonly db: Database.Database) {}

  private write(fence: GraphRunFence, fn: (run: GraphRun) => Mutation): GraphActionResult {
    const result = fencedGraphTransaction(this.db, fence, (run) => {
      if (!run.spec) fail("ORIGINAL_BUDGET_MISSING");
      const value = fn(run);
      return { changed: value.changed, value: { ...value, budget: this.budget(run) } };
    });
    return { ...result.value, run: result.run };
  }
  private find(run: GraphRun, key: string): GraphAction {
    const row = this.db.prepare("SELECT * FROM graph_actions WHERE graph_run_id = ? AND effect_key = ?")
      .get(run.graphRunId, key) as ActionRow | undefined;
    return row ? decode(row) : fail("ACTION_NOT_FOUND");
  }
  private current(run: GraphRun, slot: Pick<GraphActionAdmission, "epoch" | "nodeId" | "effectSlot">): GraphAction | null {
    const row = this.db.prepare(`SELECT * FROM graph_actions WHERE graph_run_id = ? AND epoch = ? AND node_id = ? AND effect_slot = ?
      ORDER BY logical_attempt DESC LIMIT 1`).get(run.graphRunId, slot.epoch, slot.nodeId, slot.effectSlot) as ActionRow | undefined;
    return row ? decode(row) : null;
  }
  private budget(run: GraphRun): GraphActionBudget { return graphActionBudget(this.db, run.graphRunId); }
  private checkEpoch(run: GraphRun, epoch: number): void {
    const row = this.db.prepare('SELECT max(epoch) AS epoch FROM graph_delivery_epochs WHERE graph_run_id=?').get(run.graphRunId) as { epoch: number | null };
    if (row.epoch === null && run.identity.compilerVersion.startsWith('code-delivery-functional-')) throw Error('DELIVERY_EPOCH_PERMIT_REQUIRED');
    if (row.epoch !== null && row.epoch !== epoch) throw Error('EPOCH_MISMATCH');
  }
  private admit(run: GraphRun, slot: GraphActionAdmission, retry: boolean, now: number): void {
    const limits = run.spec!.limits;
    this.checkEpoch(run, slot.epoch);
    if (run.status === "cancel_pending" || run.status === "reconciliation_required") fail("RUN_STOPPING");
    if (this.db.prepare(`SELECT 1 FROM graph_actions WHERE graph_run_id = ? AND
      (state IN ('unknown','cancel_pending') OR (state IN ('intent','running') AND generation <> ?)) LIMIT 1`)
      .get(run.graphRunId, run.generation)) fail("UNRESOLVED_ACTION");
    const budget = this.budget(run);
    if (budget.accountingBlocked) fail("ACCOUNTING_BLOCKED");
    if (slot.epoch >= limits.maxEpochs) fail("EPOCH_BUDGET_EXHAUSTED");
    if (now - run.createdAt >= limits.deadlineSeconds * 1000) fail("WALL_CLOCK_BUDGET_EXHAUSTED");
    if (budget.actionStarts >= limits.maxActionStarts) fail("ACTION_BUDGET_EXHAUSTED");
    if (retry) {
      const row = this.db.prepare(`SELECT count(*) AS retries FROM graph_actions
        WHERE graph_run_id = ? AND epoch = ? AND node_id = ? AND logical_attempt > 1`)
        .get(run.graphRunId, slot.epoch, slot.nodeId) as { retries: number };
      if (1 + row.retries >= limits.maxBranchAttempts) fail("BRANCH_BUDGET_EXHAUSTED");
    }
    if (BigInt(budget.reservedTokens) + BigInt(budget.chargedTokens) + BigInt(slot.reservationTokens) > BigInt(limits.tokenReservationLimit)) {
      fail("TOKEN_BUDGET_EXHAUSTED");
    }
  }
  private insert(run: GraphRun, input: GraphActionAdmission, businessDigest: string, attempt: number, now: number): Mutation {
    const effect = GraphEffectIdentity.parse({ schemaVersion: 1, scope: run.scope, graphRunId: run.graphRunId,
      specHash: run.identity.specHash, epoch: input.epoch, nodeId: input.nodeId, effectSlot: input.effectSlot, logicalAttempt: attempt });
    const key = computeGraphEffectKey(effect);
    this.db.prepare(`INSERT INTO graph_actions (effect_key, graph_run_id, epoch, node_id, effect_slot, logical_attempt,
      effect_json, action_json, business_digest, generation, reservation_tokens, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intent', ?, ?)`).run(key, run.graphRunId, effect.epoch, effect.nodeId,
        effect.effectSlot, attempt, canonical(effect), canonical(input.action), businessDigest, run.generation, input.reservationTokens, now, now);
    return { action: this.find(run, key), changed: true, created: true };
  }

  /** Persist intent/reservation before invocation. Existing slots NEVER allocate
   * an attempt. Host must markRunning and invoke only when that call changed=true;
   * a lost response is pending, not permission to invoke again. */
  reserve(fence: GraphRunFence, value: GraphActionAdmission): GraphActionResult {
    const parsed = admissionSchema.parse(GraphJsonValue.parse(value));
    return this.write(fence, (run) => {
      const action = WorkerActionRequest.parse({ schemaVersion: 1, kind: "worker_action", requestId: "storage",
        generation: run.generation, scope: run.scope, graphRunId: run.graphRunId, specHash: run.identity.specHash,
        epoch: parsed.epoch, nodeId: parsed.nodeId, effectSlot: parsed.effectSlot, action: parsed.action }).action;
      const input = { ...parsed, action };
      const digest = createHash("sha256").update(`osstack.graph.action.business.v1\n${canonical(action)}`).digest("hex");
      this.checkEpoch(run, input.epoch);
      const prior = this.current(run, input);
      if (prior) {
        if (prior.businessDigest !== digest || prior.reservationTokens !== input.reservationTokens) fail("ACTION_INPUT_CONFLICT");
        return { action: prior, changed: false, created: false };
      }
      this.admit(run, input, false, fence.now);
      return this.insert(run, input, digest, 1, fence.now);
    });
  }

  /** Fenced evidence lookup, including historical attempts. No raw public cache. */
  get(fence: GraphRunFence, effectKey: string): GraphActionResult {
    keySchema.parse(effectKey);
    return this.write(fence, (run) => ({ action: this.find(run, effectKey), changed: false, created: false }));
  }

  /** Explicit trusted retry command, never a worker flag. Proof of retry safety
   * must already be verified by G12 and recorded on a failed outcome. The old
   * action supplies ALL key/payload/cap inputs. Unknown is not retryable. */
  retry(fence: GraphRunFence, effectKey: string): GraphActionResult {
    keySchema.parse(effectKey);
    return this.write(fence, (run) => {
      const prior = this.find(run, effectKey);
      if (this.current(run, prior.effect)!.effectKey !== effectKey) fail("NOT_CURRENT_ATTEMPT");
      if (prior.state !== "failed" || !prior.retrySafe) fail("RETRY_NOT_SAFE");
      if (this.db.prepare("SELECT 1 FROM graph_action_admissions WHERE effect_key=? AND released_at IS NULL").get(effectKey)) fail("ADMISSION_RELEASE_PENDING");
      const input = { epoch: prior.effect.epoch, nodeId: prior.effect.nodeId, effectSlot: prior.effect.effectSlot,
        action: prior.action, reservationTokens: prior.reservationTokens };
      this.admit(run, input, true, fence.now);
      return this.insert(run, input, prior.businessDigest, prior.effect.logicalAttempt + 1, fence.now);
    });
  }

  markRunning(fence: GraphRunFence, effectKey: string, executionRef: string): GraphActionResult {
    keySchema.parse(effectKey); ref.parse(executionRef);
    return this.write(fence, (run) => {
      const prior = this.find(run, effectKey);
      this.checkEpoch(run, prior.effect.epoch);
      if (prior.generation !== run.generation) fail("ACTION_GENERATION_MISMATCH");
      if (prior.state === "running") {
        if (prior.executionRef !== executionRef) fail("EXECUTION_CONFLICT");
        return { action: prior, changed: false, created: false };
      }
      if (prior.state !== "intent") fail("INVALID_ACTION_STATE");
      // Recheck stopping, unknown and deadline immediately before the host can
      // invoke. Capacity was already reserved by intent, so do not reserve twice.
      if (run.status === "cancel_pending" || run.status === "reconciliation_required") fail("RUN_STOPPING");
      if (this.db.prepare("SELECT 1 FROM graph_actions WHERE graph_run_id = ? AND state IN ('unknown','cancel_pending') LIMIT 1")
        .get(run.graphRunId)) fail("UNRESOLVED_ACTION");
      if (this.budget(run).accountingBlocked) fail("ACCOUNTING_BLOCKED");
      if (fence.now - run.createdAt >= run.spec!.limits.deadlineSeconds * 1000) fail("WALL_CLOCK_BUDGET_EXHAUSTED");
      this.db.prepare("UPDATE graph_actions SET state = 'running', execution_ref = ?, updated_at = ? WHERE effect_key = ?")
        .run(executionRef, fence.now, effectKey);
      return { action: this.find(run, effectKey), changed: true, created: false };
    });
  }

  /** Adapter/supervisor uncertainty only. G11 has no release/reconciliation API:
   * worker receipts or later 'not applied' claims cannot clear unknown capacity. */
  markUncertain(fence: GraphRunFence, effectKey: string, value: GraphActionUncertainty): GraphActionResult {
    keySchema.parse(effectKey);
    const input = uncertainSchema.parse(GraphJsonValue.parse(value));
    return this.write(fence, (run) => {
      const prior = this.find(run, effectKey);
      this.checkEpoch(run, prior.effect.epoch);
      if (prior.generation !== run.generation) fail("ACTION_GENERATION_MISMATCH");
      if (prior.state === "confirmed" || prior.state === "failed") fail("INVALID_ACTION_STATE");
      if (prior.uncertainty && canonical(prior.uncertainty) === canonical(input)) return { action: prior, changed: false, created: false };
      this.db.prepare(`UPDATE graph_actions SET state = ?, uncertainty_json = ?, observed_tokens = ?,
        accounting_blocked = ?, updated_at = ? WHERE effect_key = ?`).run(input.state, canonical(input),
          Math.max(prior.observedTokens, input.observedTokens), Number(prior.accountingBlocked || input.observedTokens > prior.reservationTokens), fence.now, effectKey);
      return { action: this.find(run, effectKey), changed: true, created: false };
    });
  }

  /** Only trusted adapter outcomes, never worker-provided evidence. Invalid usage
   * does not discard a real result: persist null usage, retain capacity and stop
   * new actions. Over-cap actual usage is charged exactly and also stops actions.
   * Settlement after the wall-clock budget elapsed remains allowed with a live
   * fence; effects already started must not disappear because their budget ended. */
  recordOutcome(fence: GraphRunFence, effectKey: string, value: GraphActionOutcomeInput): GraphActionResult {
    keySchema.parse(effectKey);
    const usage = count.safeParse(value.actualTokens);
    const input = outcomeSchema.parse(GraphJsonValue.parse({ ...value, actualTokens: usage.success ? usage.data : null }));
    const outcome: GraphActionOutcome = input.state === "confirmed"
      ? { ...input, result: GraphResult.parse(input.result) }
      : { ...input, error: GraphJsonValue.parse(input.error) };
    return this.write(fence, (run) => {
      const prior = this.find(run, effectKey);
      if (prior.outcome) {
        if (canonical(prior.outcome) !== canonical(outcome)) fail("OUTCOME_CONFLICT");
        return { action: prior, changed: false, created: false };
      }
      this.checkEpoch(run, prior.effect.epoch);
      if (prior.generation !== run.generation) fail("ACTION_GENERATION_MISMATCH");
      if (prior.state === "unknown" || prior.state === "cancel_pending") fail("UNRESOLVED_ACTION");
      if (prior.state !== "running" && !(prior.state === "intent" && outcome.state === "failed")) fail("INVALID_ACTION_STATE");
      const blocked = !usage.success || usage.data > prior.reservationTokens;
      this.db.prepare(`UPDATE graph_actions SET state = ?, outcome_json = ?, actual_tokens = ?, retry_safe = ?,
        accounting_blocked = ?, updated_at = ? WHERE effect_key = ?`).run(outcome.state, canonical(outcome), outcome.actualTokens,
          Number(outcome.state === "failed" && outcome.retrySafe), Number(blocked), fence.now, effectKey);
      return { action: this.find(run, effectKey), changed: true, created: false };
    });
  }
}
