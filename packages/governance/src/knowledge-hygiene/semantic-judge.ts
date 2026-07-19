import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { KnowledgeHygieneCitationV2 } from "./types-v2.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const SemanticAuditDimensionV1 = z.enum([
  "narrative",
  "contradiction",
  "drift",
  "memory_overlap",
  "cross_repository",
]);
export type SemanticAuditDimensionV1 = z.infer<
  typeof SemanticAuditDimensionV1
>;

export const SemanticJudgeBudgetV1 = z
  .object({
    max_input_tokens: z.number().int().min(1).max(250_000),
    max_output_tokens: z.number().int().min(1).max(32_000),
    max_calls: z.number().int().min(1).max(64),
  })
  .strict();
export type SemanticJudgeBudgetV1 = z.infer<typeof SemanticJudgeBudgetV1>;

const source = KnowledgeHygieneCitationV2.innerType().shape.source;

const evidenceSource = z
  .object({
    source,
    blob_sha256: sha256,
    excerpts: z
      .array(
        z
          .object({
            start_line: z.number().int().positive(),
            end_line: z.number().int().positive(),
            text: z
              .string()
              .refine(
                (value) => Buffer.byteLength(value, "utf8") <= 8 * 1024,
                "evidence excerpt must not exceed 8 KiB",
              ),
          })
          .strict()
          .refine((excerpt) => excerpt.end_line >= excerpt.start_line, {
            message: "evidence excerpt end_line precedes start_line",
          }),
      )
      .min(1),
  })
  .strict();

const evidenceCandidate = z
  .object({
    candidate_id: z.string().min(1),
    source_indexes: z.array(z.number().int().nonnegative()).min(1),
    subject: z.record(z.unknown()).optional(),
  })
  .strict();

export const SemanticEvidencePackV1 = z
  .object({
    pack_id: z.string().regex(/^khep_[a-f0-9]{64}$/),
    dimension: SemanticAuditDimensionV1,
    source_units_total: z.number().int().nonnegative(),
    candidate_generator: z
      .object({ id: z.string().min(1), version: z.string().min(1) })
      .strict(),
    sources: z.array(evidenceSource),
    candidates: z.array(evidenceCandidate),
    redaction_count: z.number().int().nonnegative(),
    prompt_version: z.string().min(1),
    output_schema_sha256: sha256,
    budget: SemanticJudgeBudgetV1,
    pack_sha256: sha256,
  })
  .strict()
  .superRefine((pack, context) => {
    if (
      new Set(pack.candidates.map((candidate) => candidate.candidate_id)).size
      !== pack.candidates.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidates"],
        message: "candidate ids must be unique",
      });
    }
    for (const [candidateIndex, candidate] of pack.candidates.entries()) {
      if (new Set(candidate.source_indexes).size !== candidate.source_indexes.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidates", candidateIndex, "source_indexes"],
          message: "candidate source indexes must be unique",
        });
      }
      if (candidate.source_indexes.some((index) => index >= pack.sources.length)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["candidates", candidateIndex, "source_indexes"],
          message: "candidate references an absent evidence source",
        });
      }
    }
    if (Buffer.byteLength(JSON.stringify(pack), "utf8") > 2 * 1024 * 1024) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "semantic evidence pack exceeds 2 MiB",
      });
    }
  });
export type SemanticEvidencePackV1 = z.infer<typeof SemanticEvidencePackV1>;

const closureCondition = z.union([
  z
    .object({
      type: z.literal("source_bytes_absent"),
      path: z.string().min(1),
      sha256,
    })
    .strict(),
  z
    .object({
      type: z.literal("target_contains_bytes"),
      path: z.string().min(1),
      sha256,
    })
    .strict(),
  z
    .object({
      type: z.literal("target_contains_anchor"),
      path: z.string().min(1),
      anchor: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("budget_within"),
      path: z.string().min(1),
      max_lines: z.number().int().positive().optional(),
      max_bytes: z.number().int().positive().optional(),
    })
    .strict()
    .refine(
      (condition) => condition.max_lines !== undefined
        || condition.max_bytes !== undefined,
      "budget_within requires max_lines or max_bytes",
    ),
  z
    .object({
      type: z.literal("claim_ledger_complete"),
      plan_id: z.string().min(1),
    })
    .strict(),
]);

export const SemanticDecisionV1 = z
  .object({
    dimension: SemanticAuditDimensionV1,
    verdict: z.enum(["issue", "no_issue", "uncertain"]),
    confidence: z.enum(["high", "medium", "low"]),
    citations: z.array(KnowledgeHygieneCitationV2),
    rationale: z.string().trim().min(1),
    proposed_disposition: z.enum([
      "move",
      "compress",
      "delete",
      "review",
      "none",
    ]),
    closure_conditions: z.array(closureCondition),
  })
  .strict();
export type SemanticDecisionV1 = z.infer<typeof SemanticDecisionV1>;

export const SemanticJudgeRequestV1 = z
  .object({
    run_id: z.string().min(1),
    nonce: z.string().regex(/^khn_[a-f0-9]{64}$/),
    evidence_pack: SemanticEvidencePackV1,
    output_schema: z.record(z.unknown()),
    output_schema_sha256: sha256,
    budget: SemanticJudgeBudgetV1,
  })
  .strict()
  .superRefine((request, context) => {
    if (jsonSha256(request.output_schema) !== request.output_schema_sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["output_schema_sha256"],
        message: "output schema hash mismatch",
      });
    }
    const { pack_sha256: _packSha, ...packBody } = request.evidence_pack;
    if (jsonSha256(packBody) !== request.evidence_pack.pack_sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence_pack", "pack_sha256"],
        message: "evidence pack hash mismatch",
      });
    }
    if (
      request.output_schema_sha256
        !== request.evidence_pack.output_schema_sha256
      || JSON.stringify(request.budget) !== JSON.stringify(request.evidence_pack.budget)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "request contract differs from the evidence pack contract",
      });
    }
  });
export type SemanticJudgeRequestV1 = z.infer<typeof SemanticJudgeRequestV1>;

export const SemanticJudgeResponseV1 = z
  .object({
    nonce: z.string().regex(/^khn_[a-f0-9]{64}$/),
    raw_output: z.unknown(),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        calls: z.number().int().nonnegative(),
      })
      .strict(),
    provider_request_id: z.string().min(1).optional(),
  })
  .strict();
export type SemanticJudgeResponseV1 = z.infer<typeof SemanticJudgeResponseV1>;

export interface SemanticJudgePort {
  readonly id: string;
  readonly model_id: string;
  readonly prompt_version: string;
  readonly supports_no_tools: true;
  judge(
    input: SemanticJudgeRequestV1,
    signal: AbortSignal,
  ): Promise<SemanticJudgeResponseV1>;
}

export type SemanticJudgeErrorCode =
  | "cancelled"
  | "provider_error"
  | "schema_error"
  | "stale_nonce"
  | "budget_exhausted";

export class SemanticJudgeError extends Error {
  readonly code: SemanticJudgeErrorCode;

  constructor(code: SemanticJudgeErrorCode, message: string) {
    super(message);
    this.name = "SemanticJudgeError";
    this.code = code;
  }
}

export function jsonSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function invokeSemanticJudge(
  port: SemanticJudgePort,
  rawRequest: SemanticJudgeRequestV1,
  signal: AbortSignal,
): Promise<{
  decision: SemanticDecisionV1;
  response: SemanticJudgeResponseV1;
}> {
  if (signal.aborted) {
    throw new SemanticJudgeError("cancelled", "semantic judge call was cancelled");
  }
  let rawResponse: SemanticJudgeResponseV1;
  try {
    rawResponse = await port.judge(rawRequest, signal);
  } catch (error) {
    if (signal.aborted) {
      throw new SemanticJudgeError("cancelled", "semantic judge call was cancelled");
    }
    throw new SemanticJudgeError(
      "provider_error",
      error instanceof Error ? error.message : String(error),
    );
  }
  const response = SemanticJudgeResponseV1.safeParse(rawResponse);
  if (!response.success) {
    throw new SemanticJudgeError(
      "schema_error",
      response.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  if (response.data.nonce !== rawRequest.nonce) {
    throw new SemanticJudgeError("stale_nonce", "semantic judge nonce mismatch");
  }
  if (
    response.data.usage.input_tokens > rawRequest.budget.max_input_tokens
    || response.data.usage.output_tokens > rawRequest.budget.max_output_tokens
    || response.data.usage.calls > rawRequest.budget.max_calls
  ) {
    throw new SemanticJudgeError("budget_exhausted", "semantic judge exceeded its budget");
  }
  const decision = SemanticDecisionV1.safeParse(response.data.raw_output);
  if (!decision.success) {
    throw new SemanticJudgeError(
      "schema_error",
      decision.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  if (decision.data.dimension !== rawRequest.evidence_pack.dimension) {
    throw new SemanticJudgeError(
      "schema_error",
      "semantic decision dimension does not match the evidence pack",
    );
  }
  return { decision: decision.data, response: response.data };
}
