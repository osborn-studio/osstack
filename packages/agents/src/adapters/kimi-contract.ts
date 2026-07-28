import { createHash } from "node:crypto";
import { z } from "zod";

export const KimiReviewVerdict = z.enum([
  "approved",
  "changes_requested",
  "blocked",
  "inconclusive",
]);

export const KimiReviewFinding = z.object({
  rule_id: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  severity: z.enum(["info", "warning", "error"]),
  message: z.string().min(1),
  file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  evidence: z.string().min(1).optional(),
}).strict();

export const KimiEvaluationJudgment = z.object({
  id: z.string().min(1),
  pass: z.boolean(),
  severity: z.enum(["warning", "error"]).default("error"),
  summary: z.string().min(1),
}).strict();

export const KimiReviewResult = z.object({
  schema_version: z.literal(1),
  review_id: z.string().min(1),
  subject_run_id: z.string().min(1),
  reviewer: z.object({
    adapter: z.literal("kimi-code"),
    provider: z.string().min(1),
    model: z.string().min(1),
  }).strict(),
  verdict: KimiReviewVerdict,
  risk: z.enum(["read_only", "low", "medium", "high", "forbidden"]),
  markdown: z.string().min(1),
  evaluation_judgments: z.array(KimiEvaluationJudgment).max(100),
  findings: z.array(KimiReviewFinding).max(100),
  recommended_actions: z.array(z.string().min(1)).max(100),
}).strict().superRefine((result, context) => {
  for (const [index, finding] of result.findings.entries()) {
    if (
      finding.fingerprint !== undefined
      && finding.fingerprint !== fingerprintKimiFinding(finding)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fingerprint does not match stable finding fields",
        path: ["findings", index, "fingerprint"],
      });
    }
  }
});

export type KimiReviewResult = z.infer<typeof KimiReviewResult>;
export type KimiReviewFinding = z.infer<typeof KimiReviewFinding>;
export type ParsedKimiReviewResult = Omit<KimiReviewResult, "findings"> & {
  findings: Array<KimiReviewFinding & { fingerprint: string }>;
};

export interface KimiFindingFingerprintInput {
  rule_id: string;
  severity: KimiReviewFinding["severity"];
  message?: string | undefined;
  file?: string | undefined;
  line?: number | undefined;
}

export function parseKimiReviewResult(raw: unknown): ParsedKimiReviewResult {
  const parsed = KimiReviewResult.parse(raw);
  return {
    ...parsed,
    findings: parsed.findings.map((finding) => ({
      ...finding,
      fingerprint: fingerprintKimiFinding(finding),
    })),
  };
}

export function fingerprintKimiFinding(
  finding: KimiFindingFingerprintInput,
): string {
  const canonical = JSON.stringify({
    rule_id: finding.rule_id,
    severity: finding.severity,
    file: normalizeFindingPath(finding.file),
    line: finding.line ?? 0,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function normalizeFindingPath(file: string | undefined): string {
  return file
    ?.replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+/g, "/") ?? "";
}
