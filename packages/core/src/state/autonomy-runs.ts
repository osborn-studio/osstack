import { AutonomyRunState } from "@osstack/protocol";
import type Database from "better-sqlite3";
import { z } from "zod";
import { withWrite } from "./db.js";
import {
  AutonomyRunProjectionRow,
  AutonomyRunTransitionRow,
} from "./schema.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);
const JsonObjectSchema = z.record(JsonValueSchema);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const JsonPatch = z
  .object({
    diff_sha256: Sha256.nullable().optional(),
    preflight_risk: JsonObjectSchema.nullable().optional(),
    post_diff_risk: JsonObjectSchema.nullable().optional(),
    approval: JsonObjectSchema.nullable().optional(),
    routing: JsonObjectSchema.nullable().optional(),
    budget: JsonObjectSchema.nullable().optional(),
    attempt: JsonObjectSchema.nullable().optional(),
    candidate_proof: JsonObjectSchema.nullable().optional(),
    git_delivery: JsonObjectSchema.nullable().optional(),
    deploy: JsonObjectSchema.nullable().optional(),
    rollback: JsonObjectSchema.nullable().optional(),
    final_proof: JsonObjectSchema.nullable().optional(),
  })
  .strict();

export const CreateAutonomyRunInput = z
  .object({
    autonomy_run_id: z.string().min(1),
    transition_id: z.string().min(1),
    task_id: z.string().min(1),
    repo_id: z.string().min(1),
    workspace_path: z.string().min(1),
    contract_sha256: Sha256,
    routing: JsonObjectSchema.nullable().optional(),
    budget: JsonObjectSchema,
    attempt: JsonObjectSchema,
    event: JsonObjectSchema,
    occurred_at: z.number().finite(),
  })
  .strict();
export type CreateAutonomyRunInput = z.infer<typeof CreateAutonomyRunInput>;

export const TransitionAutonomyRunInput = z
  .object({
    autonomy_run_id: z.string().min(1),
    transition_id: z.string().min(1),
    expected_revision: z.number().int().positive(),
    to_state: AutonomyRunState,
    event: JsonObjectSchema,
    contract_decision_id: z.string().min(1).nullable().optional(),
    patch: JsonPatch.optional(),
    occurred_at: z.number().finite(),
  })
  .strict();
export type TransitionAutonomyRunInput = z.infer<
  typeof TransitionAutonomyRunInput
>;

export class AutonomyRevisionConflictError extends Error {
  constructor(
    readonly autonomyRunId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Autonomy run ${autonomyRunId} revision conflict: expected ` +
        `${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "AutonomyRevisionConflictError";
  }
}

export class AutonomyRepositoryBusyError extends Error {
  constructor(
    readonly repoId: string,
    readonly activeRunId?: string,
  ) {
    super(
      `Repository ${repoId} already has an active autonomy writer` +
        (activeRunId ? ` (${activeRunId})` : ""),
    );
    this.name = "AutonomyRepositoryBusyError";
  }
}

export class AutonomyProjectionMismatchError extends Error {
  constructor(readonly autonomyRunId: string, message: string) {
    super(`Autonomy run ${autonomyRunId} projection mismatch: ${message}`);
    this.name = "AutonomyProjectionMismatchError";
  }
}

function canonicalizeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeJson(child)]),
    );
  }
  return value;
}

function encodeJsonObject(value: unknown): string {
  return JSON.stringify(canonicalizeJson(JsonObjectSchema.parse(value)));
}

function projectionRow(value: unknown): AutonomyRunProjectionRow {
  return AutonomyRunProjectionRow.parse(value);
}

function transitionRow(value: unknown): AutonomyRunTransitionRow {
  return AutonomyRunTransitionRow.parse(value);
}

function activeRunForRepo(
  db: Database.Database,
  repoId: string,
): { autonomy_run_id: string } | undefined {
  return db
    .prepare(
      `SELECT autonomy_run_id
       FROM autonomy_run_projection
       WHERE repo_id = ?
         AND state NOT IN (
           'blocked','delivery_evidence_failed','escalated','cancelled','completed'
         )
       LIMIT 1`,
    )
    .get(repoId) as { autonomy_run_id: string } | undefined;
}

export function createAutonomyRun(
  db: Database.Database,
  dbPath: string,
  value: CreateAutonomyRunInput,
): AutonomyRunProjectionRow {
  const input = CreateAutonomyRunInput.parse(value);
  try {
    return withWrite(
      db,
      dbPath,
      (transaction) => {
        const active = activeRunForRepo(transaction, input.repo_id);
        if (active) {
          throw new AutonomyRepositoryBusyError(
            input.repo_id,
            active.autonomy_run_id,
          );
        }

        const transition = AutonomyRunTransitionRow.parse({
          transition_id: input.transition_id,
          autonomy_run_id: input.autonomy_run_id,
          seq: 1,
          from_state: null,
          to_state: "queued",
          event_json: encodeJsonObject(input.event),
          contract_decision_id: null,
          occurred_at: input.occurred_at,
        });
        transaction
          .prepare(
            `INSERT INTO autonomy_run_transitions (
               transition_id, autonomy_run_id, seq, from_state, to_state,
               event_json, contract_decision_id, occurred_at
             ) VALUES (
               @transition_id, @autonomy_run_id, @seq, @from_state, @to_state,
               @event_json, @contract_decision_id, @occurred_at
             )`,
          )
          .run(transition);

        const projection = AutonomyRunProjectionRow.parse({
          autonomy_run_id: input.autonomy_run_id,
          task_id: input.task_id,
          repo_id: input.repo_id,
          workspace_path: input.workspace_path,
          state: "queued",
          revision: 1,
          contract_sha256: input.contract_sha256,
          diff_sha256: null,
          preflight_risk_json: null,
          post_diff_risk_json: null,
          approval_json: null,
          routing_json:
            input.routing === undefined || input.routing === null
              ? null
              : encodeJsonObject(input.routing),
          budget_json: encodeJsonObject(input.budget),
          attempt_json: encodeJsonObject(input.attempt),
          candidate_proof_json: null,
          git_delivery_json: null,
          deploy_json: null,
          rollback_json: null,
          final_proof_json: null,
          last_transition_id: transition.transition_id,
          created_at: input.occurred_at,
          updated_at: input.occurred_at,
        });
        transaction
          .prepare(
            `INSERT INTO autonomy_run_projection (
               autonomy_run_id, task_id, repo_id, workspace_path, state, revision,
               contract_sha256, diff_sha256, preflight_risk_json,
               post_diff_risk_json, approval_json, routing_json, budget_json,
               attempt_json, candidate_proof_json, git_delivery_json,
               deploy_json, rollback_json, final_proof_json,
               last_transition_id, created_at, updated_at
             ) VALUES (
               @autonomy_run_id, @task_id, @repo_id, @workspace_path, @state,
               @revision, @contract_sha256, @diff_sha256, @preflight_risk_json,
               @post_diff_risk_json, @approval_json, @routing_json, @budget_json,
               @attempt_json, @candidate_proof_json, @git_delivery_json,
               @deploy_json, @rollback_json, @final_proof_json,
               @last_transition_id, @created_at, @updated_at
             )`,
          )
          .run(projection);
        return projection;
      },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed: autonomy_run_projection\.repo_id/.test(
        error.message,
      )
    ) {
      throw new AutonomyRepositoryBusyError(input.repo_id);
    }
    throw error;
  }
}

function patchedJson(
  current: string | null,
  patch: JsonValue | null | undefined,
): string | null {
  if (patch === undefined) return current;
  return patch === null ? null : encodeJsonObject(patch);
}

export function transitionAutonomyRun(
  db: Database.Database,
  dbPath: string,
  value: TransitionAutonomyRunInput,
): AutonomyRunProjectionRow {
  const input = TransitionAutonomyRunInput.parse(value);
  return withWrite(
    db,
    dbPath,
    (transaction) => {
      const current = getAutonomyRun(transaction, input.autonomy_run_id);
      if (!current) {
        throw new Error(`Autonomy run ${input.autonomy_run_id} does not exist`);
      }
      if (current.revision !== input.expected_revision) {
        throw new AutonomyRevisionConflictError(
          input.autonomy_run_id,
          input.expected_revision,
          current.revision,
        );
      }

      const nextRevision = current.revision + 1;
      const transition = AutonomyRunTransitionRow.parse({
        transition_id: input.transition_id,
        autonomy_run_id: input.autonomy_run_id,
        seq: nextRevision,
        from_state: current.state,
        to_state: input.to_state,
        event_json: encodeJsonObject(input.event),
        contract_decision_id: input.contract_decision_id ?? null,
        occurred_at: input.occurred_at,
      });
      transaction
        .prepare(
          `INSERT INTO autonomy_run_transitions (
             transition_id, autonomy_run_id, seq, from_state, to_state,
             event_json, contract_decision_id, occurred_at
           ) VALUES (
             @transition_id, @autonomy_run_id, @seq, @from_state, @to_state,
             @event_json, @contract_decision_id, @occurred_at
           )`,
        )
        .run(transition);

      const patch = input.patch;
      const next = AutonomyRunProjectionRow.parse({
        ...current,
        state: input.to_state,
        revision: nextRevision,
        diff_sha256:
          patch?.diff_sha256 === undefined
            ? current.diff_sha256
            : patch.diff_sha256,
        preflight_risk_json: patchedJson(
          current.preflight_risk_json,
          patch?.preflight_risk,
        ),
        post_diff_risk_json: patchedJson(
          current.post_diff_risk_json,
          patch?.post_diff_risk,
        ),
        approval_json: patchedJson(current.approval_json, patch?.approval),
        routing_json: patchedJson(current.routing_json, patch?.routing),
        budget_json:
          patchedJson(current.budget_json, patch?.budget) ??
          current.budget_json,
        attempt_json:
          patchedJson(current.attempt_json, patch?.attempt) ??
          current.attempt_json,
        candidate_proof_json: patchedJson(
          current.candidate_proof_json,
          patch?.candidate_proof,
        ),
        git_delivery_json: patchedJson(
          current.git_delivery_json,
          patch?.git_delivery,
        ),
        deploy_json: patchedJson(current.deploy_json, patch?.deploy),
        rollback_json: patchedJson(current.rollback_json, patch?.rollback),
        final_proof_json: patchedJson(
          current.final_proof_json,
          patch?.final_proof,
        ),
        last_transition_id: transition.transition_id,
        updated_at: input.occurred_at,
      });
      const result = transaction
        .prepare(
          `UPDATE autonomy_run_projection
           SET state = @state,
               revision = @revision,
               diff_sha256 = @diff_sha256,
               preflight_risk_json = @preflight_risk_json,
               post_diff_risk_json = @post_diff_risk_json,
               approval_json = @approval_json,
               routing_json = @routing_json,
               budget_json = @budget_json,
               attempt_json = @attempt_json,
               candidate_proof_json = @candidate_proof_json,
               git_delivery_json = @git_delivery_json,
               deploy_json = @deploy_json,
               rollback_json = @rollback_json,
               final_proof_json = @final_proof_json,
               last_transition_id = @last_transition_id,
               updated_at = @updated_at
           WHERE autonomy_run_id = @autonomy_run_id
             AND revision = @expected_revision`,
        )
        .run({ ...next, expected_revision: input.expected_revision });
      if (result.changes !== 1) {
        throw new AutonomyRevisionConflictError(
          input.autonomy_run_id,
          input.expected_revision,
          current.revision,
        );
      }
      return next;
    },
  );
}

export function getAutonomyRun(
  db: Database.Database,
  autonomyRunId: string,
): AutonomyRunProjectionRow | undefined {
  const row = db
    .prepare(
      "SELECT * FROM autonomy_run_projection WHERE autonomy_run_id = ?",
    )
    .get(autonomyRunId);
  return row === undefined ? undefined : projectionRow(row);
}

export function listAutonomyRuns(
  db: Database.Database,
  options: { repo_id?: string; limit?: number } = {},
): AutonomyRunProjectionRow[] {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("autonomy run list limit must be between 1 and 1000");
  }
  const rows =
    options.repo_id === undefined
      ? db
          .prepare(
            `SELECT *
             FROM autonomy_run_projection
             ORDER BY updated_at DESC, autonomy_run_id ASC
             LIMIT ?`,
          )
          .all(limit)
      : db
          .prepare(
            `SELECT *
             FROM autonomy_run_projection
             WHERE repo_id = ?
             ORDER BY updated_at DESC, autonomy_run_id ASC
             LIMIT ?`,
          )
          .all(options.repo_id, limit);
  return (rows as unknown[]).map(projectionRow);
}

export function listResumableAutonomyRuns(
  db: Database.Database,
): AutonomyRunProjectionRow[] {
  const rows = db
    .prepare(
      `SELECT *
       FROM autonomy_run_projection
       WHERE state NOT IN (
         'blocked','delivery_evidence_failed','escalated','cancelled','completed'
       )
       ORDER BY updated_at ASC, autonomy_run_id ASC`,
    )
    .all() as unknown[];
  return rows.map(projectionRow);
}

export function listAutonomyTransitions(
  db: Database.Database,
  autonomyRunId: string,
): AutonomyRunTransitionRow[] {
  const rows = db
    .prepare(
      `SELECT *
       FROM autonomy_run_transitions
       WHERE autonomy_run_id = ?
       ORDER BY seq ASC`,
    )
    .all(autonomyRunId) as unknown[];
  return rows.map(transitionRow);
}

export interface ReplayedAutonomyRun {
  autonomy_run_id: string;
  state: z.infer<typeof AutonomyRunState>;
  revision: number;
  last_transition_id: string;
}

export function replayAutonomyRun(
  db: Database.Database,
  autonomyRunId: string,
): ReplayedAutonomyRun | undefined {
  const transitions = listAutonomyTransitions(db, autonomyRunId);
  if (transitions.length === 0) return undefined;

  let previousState: z.infer<typeof AutonomyRunState> | null = null;
  for (const [index, transition] of transitions.entries()) {
    const expectedSeq = index + 1;
    if (
      transition.seq !== expectedSeq ||
      transition.from_state !== previousState
    ) {
      throw new AutonomyProjectionMismatchError(
        autonomyRunId,
        `non-contiguous transition at sequence ${transition.seq}`,
      );
    }
    previousState = transition.to_state;
  }

  const last = transitions.at(-1)!;
  const replayed = {
    autonomy_run_id: autonomyRunId,
    state: last.to_state,
    revision: last.seq,
    last_transition_id: last.transition_id,
  } satisfies ReplayedAutonomyRun;
  const projection = getAutonomyRun(db, autonomyRunId);
  if (
    !projection ||
    projection.state !== replayed.state ||
    projection.revision !== replayed.revision ||
    projection.last_transition_id !== replayed.last_transition_id
  ) {
    throw new AutonomyProjectionMismatchError(
      autonomyRunId,
      "projection does not match append-only transition replay",
    );
  }
  return replayed;
}
