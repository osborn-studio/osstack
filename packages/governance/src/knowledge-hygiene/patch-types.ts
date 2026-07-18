import { z } from "zod";
import { assertKnowledgeHygieneRepositoryPathV1 } from "./path-pattern.js";
import {
  KnowledgeHygieneEvidenceRefV1,
  KnowledgeHygieneFindingV1,
} from "./types.js";

const sha256 = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "sha256 must be 64 lowercase hex characters");
const fingerprint = z.string().regex(/^khf_[a-f0-9]{64}$/);
const diffId = z.string().regex(/^diff_[a-f0-9]{64}$/);

const repositoryPath = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, context) => {
    try {
      assertKnowledgeHygieneRepositoryPathV1(value);
    } catch (error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

export const KnowledgeHygienePatchActionV1 = z
  .object({
    schema_version: z.literal("1"),
    action_id: z.string().regex(/^kha_[a-f0-9]{64}$/),
    kind: z.literal("create_instruction_import"),
    risk: z.literal("low"),
    policy_category: z.literal("docs"),
    target_path: repositoryPath,
    before: z
      .object({
        exists: z.literal(false),
        sha256: z.null(),
      })
      .strict(),
    after: z
      .object({
        content: z.string().min(1),
        sha256,
      })
      .strict(),
    source_fingerprint: fingerprint,
    source_finding: KnowledgeHygieneFindingV1,
    evidence_refs: z.array(KnowledgeHygieneEvidenceRefV1),
  })
  .strict()
  .superRefine((action, context) => {
    if (action.source_fingerprint !== action.source_finding.fingerprint) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_fingerprint"],
        message: "source_fingerprint must match source_finding.fingerprint",
      });
    }
    if (
      action.source_finding.rule_id !== "instruction.mirror_missing" ||
      action.source_finding.remediation.mode !== "safe_patch"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_finding"],
        message: "source finding must be a safe-patch instruction.mirror_missing finding",
      });
    }
    if (action.target_path !== action.source_finding.location.path) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["target_path"],
        message: "target_path must match source finding location",
      });
    }
  });
export type KnowledgeHygienePatchActionV1 = z.infer<
  typeof KnowledgeHygienePatchActionV1
>;

export const KnowledgeHygienePatchPlanV1 = z
  .object({
    schema_version: z.literal("1"),
    patch_id: z.string().regex(/^khp_[a-f0-9]{64}$/),
    generated_at: z.string().datetime(),
    repo: z
      .object({
        root: z.string().min(1),
        repo_id: z.string().min(1).optional(),
      })
      .strict(),
    diff_id: diffId,
    actions: z.array(KnowledgeHygienePatchActionV1),
  })
  .strict()
  .superRefine((plan, context) => {
    const actionIds = plan.actions.map((action) => action.action_id);
    if (new Set(actionIds).size !== actionIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actions"],
        message: "actions must have unique action_id values",
      });
    }
  });
export type KnowledgeHygienePatchPlanV1 = z.infer<
  typeof KnowledgeHygienePatchPlanV1
>;
