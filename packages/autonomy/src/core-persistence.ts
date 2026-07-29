import { createHash } from "node:crypto";
import {
  createAutonomyRun,
  getAutonomyRun,
  getContractDecision,
  transitionAutonomyRun,
  type AutonomyRunProjectionRow,
} from "@osstack/core";
import {
  GuardedDeliveryContextSchema,
  type AutonomyRunProjection,
  type GuardedDeliveryContext,
  type GuardedDeliveryTransitionInput,
} from "./engine.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
type JsonObject = Record<string, JsonValue>;
type AutonomyDatabase = Parameters<typeof getAutonomyRun>[0];

export interface SqliteGuardedDeliveryStoreOptions {
  db: AutonomyDatabase;
  dbPath: string;
  now?: () => Date;
}

export function contractDecisionIdForApprovalNonce(nonce: string): string {
  return `cd_${
    createHash("sha256").update(nonce).digest("hex").slice(0, 24)
  }`;
}

function parsedJsonObject(
  value: string | null,
  label: string,
): JsonObject | undefined {
  if (value === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
  ) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as JsonObject;
}

function jsonSafeObject(value: unknown, label: string): JsonObject {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error(`${label} is not JSON serializable`);
  }
  return parsedJsonObject(encoded, label)!;
}

function contextFromRow(
  row: AutonomyRunProjectionRow,
): GuardedDeliveryContext {
  const attempt = parsedJsonObject(
    row.attempt_json,
    "autonomy attempt projection",
  );
  return GuardedDeliveryContextSchema.parse(attempt?.["engine_context"]);
}

function projectionFromRow(
  row: AutonomyRunProjectionRow,
): AutonomyRunProjection {
  return {
    autonomy_run_id: row.autonomy_run_id,
    state: row.state,
    revision: row.revision,
    context: contextFromRow(row),
  };
}

function mergedContext(
  current: GuardedDeliveryContext,
  patch: Partial<GuardedDeliveryContext> | undefined,
): GuardedDeliveryContext {
  return GuardedDeliveryContextSchema.parse({
    ...current,
    ...(patch ?? {}),
  });
}

function transitionId(
  autonomyRunId: string,
  revision: number,
  state: string,
): string {
  return `${autonomyRunId}:${String(revision).padStart(6, "0")}:${state}`;
}

export class SqliteGuardedDeliveryStore {
  private readonly db: AutonomyDatabase;
  private readonly dbPath: string;
  private readonly now: () => Date;

  constructor(options: SqliteGuardedDeliveryStoreOptions) {
    this.db = options.db;
    this.dbPath = options.dbPath;
    this.now = options.now ?? (() => new Date());
  }

  async load(
    autonomyRunId: string,
  ): Promise<AutonomyRunProjection | undefined> {
    const row = getAutonomyRun(this.db, autonomyRunId);
    return row === undefined ? undefined : projectionFromRow(row);
  }

  async persist(
    event: GuardedDeliveryTransitionInput,
  ): Promise<AutonomyRunProjection> {
    const existing = getAutonomyRun(this.db, event.autonomy_run_id);
    const nowSeconds = this.now().getTime() / 1_000;
    let current: AutonomyRunProjection;

    if (existing === undefined) {
      if (event.from_state !== "queued") {
        throw new Error(
          `first autonomy transition must start at queued, found ${event.from_state}`,
        );
      }
      const initialContext = GuardedDeliveryContextSchema.parse(
        event.context_patch,
      );
      const intent = initialContext.intent;
      const budget = initialContext.budget;
      if (intent === undefined || budget === undefined) {
        throw new Error(
          "first autonomy transition requires persisted intent and budget",
        );
      }
      const queued = createAutonomyRun(this.db, this.dbPath, {
        autonomy_run_id: event.autonomy_run_id,
        transition_id: transitionId(
          event.autonomy_run_id,
          1,
          "queued",
        ),
        task_id: intent.task_id,
        repo_id: intent.repo_id,
        workspace_path: intent.workspace_path,
        contract_sha256: intent.contract_sha256,
        routing:
          initialContext.routing === undefined
            ? null
            : jsonSafeObject(
              initialContext.routing,
              "autonomy routing",
            ),
        budget: jsonSafeObject(budget, "autonomy budget"),
        attempt: {
          engine_context: jsonSafeObject(
            initialContext,
            "autonomy engine context",
          ),
        },
        event: {
          kind: "autonomy.transition",
          from_state: null,
          to_state: "queued",
        },
        occurred_at: nowSeconds,
      });
      current = projectionFromRow(queued);
    } else {
      current = projectionFromRow(existing);
    }

    if (current.state !== event.from_state) {
      throw new Error(
        `persisted autonomy state ${current.state} does not match transition source ${event.from_state}`,
      );
    }
    const context = mergedContext(current.context, event.context_patch);
    const verifiedDecision = event.verified_approval?.decision;
    const contractDecisionId =
      verifiedDecision === undefined
        ? undefined
        : contractDecisionIdForApprovalNonce(
          verifiedDecision.payload.nonce,
        );
    if (
      contractDecisionId !== undefined
      && getContractDecision(this.db, contractDecisionId) === undefined
    ) {
      throw new Error(
        "verified approval has no append-only contract decision evidence",
      );
    }

    const transitioned = transitionAutonomyRun(this.db, this.dbPath, {
      autonomy_run_id: event.autonomy_run_id,
      transition_id: transitionId(
        event.autonomy_run_id,
        current.revision + 1,
        event.to_state,
      ),
      expected_revision: current.revision,
      to_state: event.to_state,
      event: jsonSafeObject(
        {
          kind: "autonomy.transition",
          from_state: event.from_state,
          to_state: event.to_state,
          ...(event.risk_level === undefined
            ? {}
            : { risk_level: event.risk_level }),
          ...(event.risk_phase === undefined
            ? {}
            : { risk_phase: event.risk_phase }),
          ...(event.pending_approval_phase === undefined
            ? {}
            : {
                pending_approval_phase:
                  event.pending_approval_phase,
              }),
          ...(event.blocked_delivery_resume_state === undefined
            ? {}
            : {
                blocked_delivery_resume_state:
                  event.blocked_delivery_resume_state,
              }),
          ...(event.recovery === undefined
            ? {}
            : { recovery: event.recovery }),
          context_patch: event.context_patch ?? {},
        },
        "autonomy transition event",
      ),
      ...(contractDecisionId === undefined
        ? {}
        : { contract_decision_id: contractDecisionId }),
      patch: {
        diff_sha256:
          context.local_result === undefined
            ? undefined
            : createHash("sha256")
              .update(
                context.local_result.post_diff.staged_diff_binary,
              )
              .digest("hex"),
        preflight_risk: context.preflight_risk === undefined
          ? undefined
          : jsonSafeObject(
            context.preflight_risk,
            "preflight risk",
          ),
        post_diff_risk: context.post_diff_risk === undefined
          ? undefined
          : jsonSafeObject(
            context.post_diff_risk,
            "post-diff risk",
          ),
        approval:
          context.approval_request === undefined
            ? undefined
            : jsonSafeObject(
              {
                request: context.approval_request,
                ...(context.approval_decision === undefined
                  ? {}
                  : { decision: context.approval_decision }),
              },
              "approval evidence",
            ),
        routing:
          context.routing === undefined
            ? undefined
            : jsonSafeObject(context.routing, "autonomy routing"),
        budget:
          context.budget === undefined
            ? undefined
            : jsonSafeObject(context.budget, "autonomy budget"),
        attempt: {
          engine_context: jsonSafeObject(
            context,
            "autonomy engine context",
          ),
        },
        candidate_proof:
          context.candidate_proof === undefined
            ? undefined
            : jsonSafeObject(
              context.candidate_proof,
              "candidate proof",
            ),
        git_delivery:
          context.git_delivery === undefined
            ? undefined
            : jsonSafeObject(
              context.git_delivery,
              "Git delivery",
            ),
        deploy:
          context.deploy_eligibility === undefined
          && context.deploy_script_authority === undefined
          && context.deploy_staging === undefined
          && context.deploy_production === undefined
          && context.deploy_outcome === undefined
            ? undefined
            : jsonSafeObject(
              {
                ...(context.deploy_eligibility === undefined
                  ? {}
                  : {
                      eligibility:
                        context.deploy_eligibility,
                    }),
                ...(context.deploy_script_authority === undefined
                  ? {}
                  : {
                      script_authority:
                        context.deploy_script_authority,
                    }),
                ...(context.deploy_staging === undefined
                  ? {}
                  : { staging: context.deploy_staging }),
                ...(context.deploy_production === undefined
                  ? {}
                  : { production: context.deploy_production }),
                ...(context.deploy_outcome === undefined
                  ? {}
                  : { outcome: context.deploy_outcome }),
              },
              "deployment evidence",
            ),
        rollback:
          context.deploy_production?.rollback === undefined
          && context.production_freeze === undefined
            ? undefined
            : jsonSafeObject(
              {
                ...(context.deploy_production?.rollback ===
                undefined
                  ? {}
                  : {
                      command:
                        context.deploy_production.rollback,
                    }),
                ...(context.deploy_production
                    ?.post_rollback_health === undefined
                  ? {}
                  : {
                      post_health:
                        context.deploy_production
                          .post_rollback_health,
                    }),
                ...(context.production_freeze === undefined
                  ? {}
                  : { freeze: context.production_freeze }),
              },
              "rollback evidence",
            ),
        final_proof:
          context.final_proof === undefined
            ? undefined
            : jsonSafeObject(context.final_proof, "final proof"),
      },
      occurred_at: nowSeconds,
    });
    return projectionFromRow(transitioned);
  }
}
