import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { KnowledgeHygieneRuleIdV1 } from "./types.js";

export interface KnowledgeHygieneFingerprintInputV1 {
  schema_version: "1";
  rule_id: KnowledgeHygieneRuleIdV1;
  rule_version: string;
  repo_identity: string;
  location: {
    path: string;
    anchor?: string;
    line?: number;
  };
  rationale?: string;
}

function normalizeRelativePath(value: string): string {
  const posixPath = value.normalize("NFC").replaceAll("\\", "/");
  return posix.normalize(posixPath).replace(/^\.\//, "");
}

export function createKnowledgeHygieneFingerprint(
  input: KnowledgeHygieneFingerprintInputV1,
): string {
  const semanticIdentity = JSON.stringify([
    input.schema_version,
    input.rule_id,
    input.rule_version,
    input.repo_identity.normalize("NFC"),
    normalizeRelativePath(input.location.path),
    input.location.anchor?.normalize("NFC") ?? "",
  ]);
  const digest = createHash("sha256").update(semanticIdentity).digest("hex");
  return `khf_${digest}`;
}
