import { z } from "zod";
import { deriveProbeSeverity, sortProbeItems } from "./priority.js";
import {
  ProbeCategoryV1,
  ProbeReadinessV1,
  ProbeSeverityV1,
  type ProbeEventV1,
  type ProbeGateViolationV1,
  type ProbeItemV1,
  type ProbeSessionV1,
} from "./types.js";

const questionId = z
  .string()
  .regex(/^(?:[a-z][a-z0-9_-]*\.)+[a-z0-9_-]+\.v[1-9][0-9]*$/);
const positiveDays = z.number().int().positive().max(36_500);
const budget = z.number().int().min(1).max(100);

export const ProbeGatePolicyV1 = z
  .object({
    schema_version: z.literal(1),
    enforcement: z.enum(["report", "block"]).default("report"),
    blocking_severities: z
      .array(ProbeSeverityV1)
      .min(1)
      .max(3)
      .default(["high"]),
    accepted_dispositions: z
      .array(z.enum(["resolved", "waived", "invalidated"]))
      .min(1)
      .max(3)
      .default(["resolved", "waived", "invalidated"]),
    require_destination_state: z
      .enum(["pending", "applied", "verified"])
      .default("applied"),
    max_deferred_age_days: positiveDays.default(14),
    required_question_ids: z.array(questionId).max(100).default([]),
    waiver: z
      .object({
        require_human: z.boolean().default(true),
        max_age_days: positiveDays.default(30),
      })
      .strict()
      .default({ require_human: true, max_age_days: 30 }),
    resolution: z
      .object({
        require_human_categories: z
          .array(ProbeCategoryV1)
          .max(32)
          .default([
            "user",
            "outcome",
            "scope",
            "data_model",
            "interface",
            "user_flow",
            "security",
            "migration",
            "rollback",
            "acceptance",
          ]),
      })
      .strict()
      .default({
        require_human_categories: [
          "user",
          "outcome",
          "scope",
          "data_model",
          "interface",
          "user_flow",
          "security",
          "migration",
          "rollback",
          "acceptance",
        ],
      }),
    destination: z
      .object({ verified_require_human: z.boolean().default(true) })
      .strict()
      .default({ verified_require_human: true }),
    invalidation: z
      .object({ required_requires_human: z.boolean().default(true) })
      .strict()
      .default({ required_requires_human: true }),
    budgets: z
      .object({
        quick: budget.default(8),
        standard: budget.default(20),
        deep: budget.default(40),
      })
      .strict()
      .default({ quick: 8, standard: 20, deep: 40 }),
  })
  .strict()
  .superRefine((policy, context) => {
    for (const [path, values] of [
      ["blocking_severities", policy.blocking_severities],
      ["accepted_dispositions", policy.accepted_dispositions],
      ["required_question_ids", policy.required_question_ids],
      [
        "resolution.require_human_categories",
        policy.resolution.require_human_categories,
      ],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: path.split("."),
          message: "policy arrays must not contain duplicates",
        });
      }
    }
  });
export type ProbeGatePolicyV1 = z.infer<typeof ProbeGatePolicyV1>;

export const DEFAULT_PROBE_GATE_POLICY_V1 = ProbeGatePolicyV1.parse({
  schema_version: 1,
});

export interface ProbeDestinationContentV1 {
  exists: boolean;
  sha256?: string;
}

export interface EvaluateProbeGateInputV1 {
  session: ProbeSessionV1;
  items: readonly ProbeItemV1[];
  events: readonly ProbeEventV1[];
  policy: ProbeGatePolicyV1;
  now_ms: number;
  destination_content?: Readonly<
    Record<string, ProbeDestinationContentV1>
  >;
}

export interface ProbeGateResultV1 {
  enforcement: "report" | "block";
  blocked: boolean;
  readiness: z.infer<typeof ProbeReadinessV1>;
}

const dayMs = 86_400_000;
const destinationRank = { pending: 0, applied: 1, verified: 2 } as const;

function eventHasHumanActor(
  events: readonly ProbeEventV1[],
  type: ProbeEventV1["type"],
  itemId: string,
  payloadState?: string,
): boolean {
  return events.some(
    (event) =>
      event.type === type &&
      event.item_id === itemId &&
      event.actor.type === "human" &&
      (payloadState === undefined ||
        event.payload["destination_state"] === payloadState),
  );
}

export function evaluateProbeGate(
  input: EvaluateProbeGateInputV1,
): ProbeGateResultV1 {
  const policy = ProbeGatePolicyV1.parse(input.policy);
  const violations: ProbeGateViolationV1[] = [];
  const blockingSeverities = new Set(policy.blocking_severities);
  const accepted = new Set(policy.accepted_dispositions);
  const policyRequired = new Set(policy.required_question_ids);
  const humanResolutionCategories = new Set(
    policy.resolution.require_human_categories,
  );
  const openBySeverity = { high: 0, medium: 0, low: 0 };
  let requiredDisposed = 0;
  let deferredDue = 0;
  let waivedActive = 0;
  let waivedExpired = 0;
  let destinationPending = 0;
  let destinationApplied = 0;
  let compilationManualRequired = 0;

  const add = (
    violation: Omit<ProbeGateViolationV1, "advisory">,
    forceBlocking = false,
  ) => {
    violations.push({
      ...violation,
      ...(forceBlocking || blockingSeverities.has(violation.severity)
        ? {}
        : { advisory: true }),
    });
  };

  const items = sortProbeItems(input.items);
  const presentQuestionIds = new Set(items.map((item) => item.question_id));
  const missingRequired = new Set(
    input.session.unselected_required_question_ids,
  );
  for (const requiredId of policyRequired) {
    if (!presentQuestionIds.has(requiredId)) missingRequired.add(requiredId);
  }

  let requiredItemCount = 0;
  for (const item of items) {
    const severity = deriveProbeSeverity(item);
    const required = item.required || policyRequired.has(item.question_id);
    if (required) requiredItemCount += 1;
    let disposed = false;

    if (item.state === "open") {
      openBySeverity[severity] += 1;
      add({
        code: required ? "open_required" : "open_advisory",
        severity,
        message: required
          ? "A required question remains open."
          : "An optional question remains open.",
        item_id: item.item_id,
        question_id: item.question_id,
      });
    } else if (item.state === "deferred") {
      const due =
        (item.deferral.review_after_ms !== undefined &&
          item.deferral.review_after_ms <= input.now_ms) ||
        input.now_ms - item.deferral.deferred_at_ms >=
          policy.max_deferred_age_days * dayMs;
      if (due) deferredDue += 1;
      add(
        {
          code: due ? "deferred_due" : "deferred_advisory",
          severity,
          message: due
            ? "A deferred question is due for review."
            : "A question remains deferred.",
          item_id: item.item_id,
          question_id: item.question_id,
        },
        due,
      );
    } else if (item.state === "waived") {
      const expired =
        (item.waiver.expires_at_ms !== undefined &&
          item.waiver.expires_at_ms <= input.now_ms) ||
        input.now_ms - item.waiver.approved_at_ms >=
          policy.waiver.max_age_days * dayMs;
      const humanAuthorized =
        !policy.waiver.require_human ||
        eventHasHumanActor(
          input.events,
          "item_waived",
          item.item_id,
        );
      if (expired) {
        waivedExpired += 1;
        add(
          {
            code: "expired_waiver",
            severity,
            message: "A waiver has expired.",
            item_id: item.item_id,
            question_id: item.question_id,
          },
          true,
        );
      } else {
        waivedActive += 1;
      }
      if (!humanAuthorized) {
        add(
          {
            code: "waiver_authority",
            severity,
            message: "A waiver lacks required human authority evidence.",
            item_id: item.item_id,
            question_id: item.question_id,
          },
          true,
        );
      }
      disposed = !expired && humanAuthorized && accepted.has("waived");
    } else if (item.state === "resolved") {
      const humanAuthorized =
        !humanResolutionCategories.has(item.category) ||
        item.resolution.actor.type === "human";
      if (!humanAuthorized) {
        add(
          {
            code: "resolution_authority",
            severity,
            message: "This resolution category requires a human actor.",
            item_id: item.item_id,
            question_id: item.question_id,
          },
          true,
        );
      }
      if (item.destination.role !== "session_profile") {
        if (item.destination.write_state === "pending") destinationPending += 1;
        else destinationApplied += 1;
        if (
          destinationRank[item.destination.write_state] <
          destinationRank[policy.require_destination_state]
        ) {
          add({
            code: "destination_pending",
            severity,
            message: `A decision destination has not reached ${policy.require_destination_state}.`,
            item_id: item.item_id,
            question_id: item.question_id,
          });
        }
        if (
          item.destination.write_state === "verified" &&
          policy.destination.verified_require_human &&
          !eventHasHumanActor(
            input.events,
            "destination_updated",
            item.item_id,
            "verified",
          )
        ) {
          add(
            {
              code: "destination_verification_authority",
              severity,
              message: "Destination verification lacks human authority evidence.",
              item_id: item.item_id,
              question_id: item.question_id,
            },
            true,
          );
        }
        const actual = input.destination_content?.[item.destination.path];
        if (item.destination.content_sha256 !== undefined && actual !== undefined) {
          if (!actual.exists) {
            add(
              {
                code: "destination_missing",
                severity,
                message: "An attested destination no longer exists.",
                item_id: item.item_id,
                question_id: item.question_id,
              },
              true,
            );
          } else if (actual.sha256 !== item.destination.content_sha256) {
            add(
              {
                code: "destination_stale",
                severity,
                message: "Destination content no longer matches its attestation.",
                item_id: item.item_id,
                question_id: item.question_id,
              },
              true,
            );
          }
        }
      }
      if (item.compilation.state === "manual_required") {
        compilationManualRequired += 1;
      }
      disposed = humanAuthorized && accepted.has("resolved");
    } else if (item.state === "invalidated") {
      const humanAuthorized =
        !required ||
        !policy.invalidation.required_requires_human ||
        item.invalidation.actor.type === "human";
      if (!humanAuthorized) {
        add(
          {
            code: "invalidation_authority",
            severity,
            message: "A required invalidation lacks human authority.",
            item_id: item.item_id,
            question_id: item.question_id,
          },
          true,
        );
      }
      disposed = humanAuthorized && accepted.has("invalidated");
    }

    if (
      required &&
      (item.state === "resolved" ||
        item.state === "waived" ||
        item.state === "invalidated") &&
      !accepted.has(item.state)
    ) {
      add(
        {
          code: "disposition_not_accepted",
          severity,
          message: `The ${item.state} disposition is not accepted by policy.`,
          item_id: item.item_id,
          question_id: item.question_id,
        },
        true,
      );
    }
    if (required && disposed) requiredDisposed += 1;
  }

  for (const requiredId of missingRequired) {
    add(
      {
        code: "missing_required",
        severity: "high",
        message: "A required question is absent from the ledger.",
        question_id: requiredId,
      },
      true,
    );
  }
  const requiredTotal = requiredItemCount + missingRequired.size;
  const completionPercent =
    requiredTotal === 0
      ? 100
      : Math.round((requiredDisposed / requiredTotal) * 10_000) / 100;
  const readiness = ProbeReadinessV1.parse({
    required_total: requiredTotal,
    required_disposed: requiredDisposed,
    open_by_severity: openBySeverity,
    deferred_due: deferredDue,
    waived_active: waivedActive,
    waived_expired: waivedExpired,
    resolved_destination_pending: destinationPending,
    resolved_destination_applied: destinationApplied,
    compilation_manual_required: compilationManualRequired,
    completion_percent: completionPercent,
    eligible: !violations.some((violation) => violation.advisory !== true),
    violations,
  });
  return {
    enforcement: policy.enforcement,
    blocked: policy.enforcement === "block" && !readiness.eligible,
    readiness,
  };
}
