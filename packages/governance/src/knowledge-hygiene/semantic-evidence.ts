import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SemanticJudgeBudgetV1,
  type SemanticEvidencePackV1,
} from "./semantic-judge.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const SEMANTIC_REDACTOR_VERSION_V1 = "1";

export const SemanticCacheKeyInputV1 = z
  .object({
    evidence_pack_sha256: sha256,
    candidate_index_sha256: sha256,
    config_sha256: sha256,
    rule_versions_sha256: sha256,
    prompt_version: z.string().min(1),
    output_schema_sha256: sha256,
    model_id: z.string().min(1),
    judge_id: z.string().min(1),
    budget: SemanticJudgeBudgetV1,
    redactor_version: z.string().min(1),
    associated_blob_sha256: z.array(sha256),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      new Set(input.associated_blob_sha256).size
      !== input.associated_blob_sha256.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["associated_blob_sha256"],
        message: "associated blob hashes must be unique",
      });
    }
  });
export type SemanticCacheKeyInputV1 = z.infer<typeof SemanticCacheKeyInputV1>;

function jsonSha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function composeSemanticCacheKeyV1(
  rawInput: SemanticCacheKeyInputV1,
): string {
  const input = SemanticCacheKeyInputV1.parse(rawInput);
  return `khsc_${jsonSha({
    ...input,
    associated_blob_sha256: [...input.associated_blob_sha256].sort(),
  })}`;
}

const assignmentSecret = /\b((?:[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY)[A-Z0-9_]*)|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd))\s*([=:])\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s\n]+)/giu;
const knownToken = /\b(?:sk-ant-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/gu;
const privateKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu;
const credentialUrl = /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu;

function redactText(value: string): { text: string; count: number } {
  let text = value;
  let count = 0;
  const replace = (
    pattern: RegExp,
    replacement: string | ((...args: string[]) => string),
  ): void => {
    text = text.replace(pattern, (...args: string[]) => {
      count += 1;
      return typeof replacement === "string"
        ? replacement
        : replacement(...args);
    });
  };
  replace(assignmentSecret, (_match, name, separator) =>
    `${name}${separator} [REDACTED]`
  );
  replace(privateKey, "[REDACTED_PRIVATE_KEY]");
  replace(knownToken, "[REDACTED_TOKEN]");
  replace(credentialUrl, (_match, protocol) => `${protocol}[REDACTED]@`);
  return { text, count };
}

export function redactSemanticEvidenceSourcesV1(
  sources: SemanticEvidencePackV1["sources"],
): {
  sources: SemanticEvidencePackV1["sources"];
  redaction_count: number;
} {
  let redactionCount = 0;
  const redacted = sources.map((source) => ({
    ...source,
    excerpts: source.excerpts.map((excerpt) => {
      const result = redactText(excerpt.text);
      redactionCount += result.count;
      return { ...excerpt, text: result.text };
    }),
  }));
  return { sources: redacted, redaction_count: redactionCount };
}
