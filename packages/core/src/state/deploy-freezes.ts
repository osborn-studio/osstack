import type Database from "better-sqlite3";
import { z } from "zod";
import { withWrite } from "./db.js";
import {
  AutonomyDeployFreezeRow,
  type AutonomyDeployFreezeRow as AutonomyDeployFreezeRowType,
} from "./schema.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const AuditReason = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, {
    message: "reason must not have surrounding whitespace",
  });

export const FreezeProductionInput = z
  .object({
    repo_id: z.string().min(1),
    reason: AuditReason,
    source_run_id: z.string().min(1),
    frozen_at: z.number().finite(),
  })
  .strict();
export type FreezeProductionInput = z.infer<typeof FreezeProductionInput>;

export const VerifiedFreezeClearAuthority = z
  .object({
    actor_type: z.literal("human", {
      errorMap: () => ({
        message: "production freeze clear requires verified human authority",
      }),
    }),
    actor_id: z.string().min(1),
    key_id: z.string().min(1),
    decision_sha256: Sha256,
    freeze_frozen_at: z.number().finite(),
  })
  .strict();
export type VerifiedFreezeClearAuthority = z.infer<
  typeof VerifiedFreezeClearAuthority
>;

export const ClearProductionFreezeInput = z
  .object({
    repo_id: z.string().min(1),
    reason: AuditReason,
    cleared_at: z.number().finite(),
    authority: VerifiedFreezeClearAuthority,
  })
  .strict();
export type ClearProductionFreezeInput = z.infer<
  typeof ClearProductionFreezeInput
>;

function freezeRow(value: unknown): AutonomyDeployFreezeRowType {
  return AutonomyDeployFreezeRow.parse(value);
}

export function getProductionFreeze(
  db: Database.Database,
  repoId: string,
): AutonomyDeployFreezeRowType | undefined {
  const row = db
    .prepare(
      `SELECT *
       FROM autonomy_deploy_freezes
       WHERE repo_id = ? AND target = 'production'`,
    )
    .get(repoId);
  return row === undefined ? undefined : freezeRow(row);
}

export function listProductionFreezes(
  db: Database.Database,
  options: { active_only?: boolean } = {},
): AutonomyDeployFreezeRowType[] {
  const rows = (
    options.active_only
      ? db
          .prepare(
            `SELECT *
             FROM autonomy_deploy_freezes
             WHERE target = 'production' AND frozen = 1
             ORDER BY frozen_at DESC, repo_id ASC`,
          )
          .all()
      : db
          .prepare(
            `SELECT *
             FROM autonomy_deploy_freezes
             WHERE target = 'production'
             ORDER BY frozen_at DESC, repo_id ASC`,
          )
          .all()
  ) as unknown[];
  return rows.map(freezeRow);
}

export function freezeProduction(
  db: Database.Database,
  dbPath: string,
  value: FreezeProductionInput,
): AutonomyDeployFreezeRowType {
  const input = FreezeProductionInput.parse(value);
  return withWrite(db, dbPath, (transaction) => {
    const sourceRun = transaction
      .prepare(
        `SELECT repo_id
         FROM autonomy_run_projection
         WHERE autonomy_run_id = ?`,
      )
      .get(input.source_run_id) as { repo_id: string } | undefined;
    if (sourceRun === undefined || sourceRun.repo_id !== input.repo_id) {
      throw new Error(
        "production freeze source run must exist and belong to the repository",
      );
    }

    const current = getProductionFreeze(transaction, input.repo_id);
    if (current !== undefined) {
      if (input.frozen_at < current.frozen_at) {
        throw new Error("stale production freeze event");
      }
      if (input.frozen_at === current.frozen_at) {
        if (
          current.source_run_id === input.source_run_id &&
          current.reason === input.reason &&
          current.frozen === 1
        ) {
          return current;
        }
        throw new Error("conflicting production freeze event");
      }
    }

    transaction
      .prepare(
        `INSERT INTO autonomy_deploy_freezes (
           repo_id, target, frozen, reason, source_run_id, frozen_at,
           cleared_at, cleared_by_type, cleared_by_id, clear_reason,
           clear_decision_sha256, clear_key_id
         ) VALUES (
           @repo_id, 'production', 1, @reason, @source_run_id, @frozen_at,
           NULL, NULL, NULL, NULL, NULL, NULL
         )
         ON CONFLICT(repo_id, target) DO UPDATE SET
           frozen = 1,
           reason = excluded.reason,
           source_run_id = excluded.source_run_id,
           frozen_at = excluded.frozen_at,
           cleared_at = NULL,
           cleared_by_type = NULL,
           cleared_by_id = NULL,
           clear_reason = NULL,
           clear_decision_sha256 = NULL,
           clear_key_id = NULL`,
      )
      .run(input);
    return getProductionFreeze(transaction, input.repo_id)!;
  });
}

export function clearProductionFreeze(
  db: Database.Database,
  dbPath: string,
  value: ClearProductionFreezeInput,
): AutonomyDeployFreezeRowType {
  const input = ClearProductionFreezeInput.parse(value);
  return withWrite(db, dbPath, (transaction) => {
    const current = getProductionFreeze(transaction, input.repo_id);
    if (current === undefined) {
      throw new Error(`production freeze not found for ${input.repo_id}`);
    }
    if (current.frozen === 0) {
      if (
        current.clear_decision_sha256 ===
          input.authority.decision_sha256 &&
        current.clear_key_id === input.authority.key_id
      ) {
        return current;
      }
      throw new Error("production freeze is already cleared");
    }
    if (current.frozen_at !== input.authority.freeze_frozen_at) {
      throw new Error("stale freeze-clear authority does not bind current freeze");
    }
    if (input.cleared_at < current.frozen_at) {
      throw new Error("production freeze cannot be cleared before it was created");
    }

    const result = transaction
      .prepare(
        `UPDATE autonomy_deploy_freezes
         SET frozen = 0,
             cleared_at = @cleared_at,
             cleared_by_type = @actor_type,
             cleared_by_id = @actor_id,
             clear_reason = @reason,
             clear_decision_sha256 = @decision_sha256,
             clear_key_id = @key_id
         WHERE repo_id = @repo_id
           AND target = 'production'
           AND frozen = 1
           AND frozen_at = @freeze_frozen_at`,
      )
      .run({
        repo_id: input.repo_id,
        reason: input.reason,
        cleared_at: input.cleared_at,
        ...input.authority,
      });
    if (result.changes !== 1) {
      throw new Error("production freeze changed before clear could commit");
    }
    return getProductionFreeze(transaction, input.repo_id)!;
  });
}
