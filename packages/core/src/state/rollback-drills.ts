import type Database from "better-sqlite3";
import { z } from "zod";
import { withWrite } from "./db.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const CommandEvidence = z
  .object({
    argv: z.array(z.string().min(1)).min(1),
    exit_code: z.number().int(),
    duration_ms: z.number().int().nonnegative(),
    stdout_summary: z.string(),
    stderr_summary: z.string(),
    timed_out: z.boolean(),
  })
  .strict();

export const RecordRollbackDrillInput = z
  .object({
    drill_id: z.string().min(1),
    repo_id: z.string().min(1),
    workspace_path: z.string().min(1),
    deploy_script_digest_sha256: Sha256,
    rollback: CommandEvidence,
    post_rollback_health: CommandEvidence.optional(),
    started_at: z.number().finite(),
    completed_at: z.number().finite(),
  })
  .strict()
  .refine((value) => value.completed_at >= value.started_at, {
    message: "rollback drill cannot complete before it starts",
  });
export type RecordRollbackDrillInput = z.infer<
  typeof RecordRollbackDrillInput
>;

export interface RollbackDrillRecord {
  drill_id: string;
  repo_id: string;
  target: "controlled_non_production";
  workspace_path: string;
  deploy_script_digest_sha256: string;
  rollback: z.infer<typeof CommandEvidence>;
  post_rollback_health?: z.infer<typeof CommandEvidence>;
  passed: boolean;
  failure_reason:
    | "rollback_failed"
    | "post_rollback_health_failed"
    | null;
  started_at: number;
  completed_at: number;
}

interface RollbackDrillRow {
  drill_id: string;
  repo_id: string;
  target: "controlled_non_production";
  workspace_path: string;
  deploy_script_digest_sha256: string;
  rollback_evidence_json: string;
  post_rollback_health_json: string | null;
  passed: 0 | 1;
  failure_reason:
    | "rollback_failed"
    | "post_rollback_health_failed"
    | null;
  started_at: number;
  completed_at: number;
}

function decode(row: RollbackDrillRow): RollbackDrillRecord {
  const rollback = CommandEvidence.parse(
    JSON.parse(row.rollback_evidence_json) as unknown,
  );
  const postRollbackHealth =
    row.post_rollback_health_json === null
      ? undefined
      : CommandEvidence.parse(
          JSON.parse(row.post_rollback_health_json) as unknown,
        );
  return {
    drill_id: row.drill_id,
    repo_id: row.repo_id,
    target: row.target,
    workspace_path: row.workspace_path,
    deploy_script_digest_sha256:
      row.deploy_script_digest_sha256,
    rollback,
    ...(postRollbackHealth === undefined
      ? {}
      : { post_rollback_health: postRollbackHealth }),
    passed: row.passed === 1,
    failure_reason: row.failure_reason,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

function getRow(
  db: Database.Database,
  drillId: string,
): RollbackDrillRow | undefined {
  return db
    .prepare(
      `SELECT *
       FROM autonomy_rollback_drills
       WHERE drill_id = ?`,
    )
    .get(drillId) as RollbackDrillRow | undefined;
}

export function getRollbackDrill(
  db: Database.Database,
  drillId: string,
): RollbackDrillRecord | undefined {
  const row = getRow(db, drillId);
  return row === undefined ? undefined : decode(row);
}

export function listRollbackDrills(
  db: Database.Database,
  repoId: string,
): RollbackDrillRecord[] {
  return (
    db
      .prepare(
        `SELECT *
         FROM autonomy_rollback_drills
         WHERE repo_id = ?
         ORDER BY completed_at DESC, drill_id ASC`,
      )
      .all(repoId) as RollbackDrillRow[]
  ).map(decode);
}

export function getLatestSuccessfulRollbackDrill(
  db: Database.Database,
  repoId: string,
): RollbackDrillRecord | undefined {
  const row = db
    .prepare(
      `SELECT *
       FROM autonomy_rollback_drills
       WHERE repo_id = ?
       ORDER BY completed_at DESC, drill_id ASC
       LIMIT 1`,
    )
    .get(repoId) as RollbackDrillRow | undefined;
  if (row === undefined || row.passed !== 1) return undefined;
  return decode(row);
}

function equivalent(
  left: RollbackDrillRecord,
  right: RollbackDrillRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function recordRollbackDrill(
  db: Database.Database,
  dbPath: string,
  value: RecordRollbackDrillInput,
): RollbackDrillRecord {
  const input = RecordRollbackDrillInput.parse(value);
  const rollbackPassed =
    input.rollback.exit_code === 0 && !input.rollback.timed_out;
  const healthPassed =
    input.post_rollback_health?.exit_code === 0
    && !input.post_rollback_health.timed_out;
  const passed = rollbackPassed && healthPassed;
  const failureReason = rollbackPassed
    ? passed
      ? null
      : "post_rollback_health_failed" as const
    : "rollback_failed" as const;
  const expected: RollbackDrillRecord = {
    drill_id: input.drill_id,
    repo_id: input.repo_id,
    target: "controlled_non_production",
    workspace_path: input.workspace_path,
    deploy_script_digest_sha256:
      input.deploy_script_digest_sha256,
    rollback: input.rollback,
    ...(input.post_rollback_health === undefined
      ? {}
      : { post_rollback_health: input.post_rollback_health }),
    passed,
    failure_reason: failureReason,
    started_at: input.started_at,
    completed_at: input.completed_at,
  };
  return withWrite(db, dbPath, (transaction) => {
    const current = getRollbackDrill(transaction, input.drill_id);
    if (current !== undefined) {
      if (equivalent(current, expected)) return current;
      throw new Error("conflicting rollback drill idempotency replay");
    }
    transaction
      .prepare(
        `INSERT INTO autonomy_rollback_drills (
           drill_id, repo_id, target, workspace_path,
           deploy_script_digest_sha256, rollback_evidence_json,
           post_rollback_health_json, passed, failure_reason,
           started_at, completed_at
         ) VALUES (
           @drill_id, @repo_id, 'controlled_non_production',
           @workspace_path, @deploy_script_digest_sha256,
           @rollback_evidence_json, @post_rollback_health_json,
           @passed, @failure_reason, @started_at, @completed_at
         )`,
      )
      .run({
        drill_id: input.drill_id,
        repo_id: input.repo_id,
        workspace_path: input.workspace_path,
        deploy_script_digest_sha256:
          input.deploy_script_digest_sha256,
        rollback_evidence_json: JSON.stringify(input.rollback),
        post_rollback_health_json:
          input.post_rollback_health === undefined
            ? null
            : JSON.stringify(input.post_rollback_health),
        passed: passed ? 1 : 0,
        failure_reason: failureReason,
        started_at: input.started_at,
        completed_at: input.completed_at,
      });
    return getRollbackDrill(transaction, input.drill_id)!;
  });
}

export function rollbackDrillEligibilityEvidence(
  record: RollbackDrillRecord | undefined,
):
  | {
      passed_at: string;
      deploy_script_digest_sha256: string;
      post_rollback_health_passed: true;
    }
  | undefined {
  if (record === undefined || !record.passed) return undefined;
  return {
    passed_at: new Date(record.completed_at * 1_000).toISOString(),
    deploy_script_digest_sha256:
      record.deploy_script_digest_sha256,
    post_rollback_health_passed: true,
  };
}
