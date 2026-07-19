import { createHash } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { loadKnowledgeHygieneConfigV2 } from "./config-v2.js";
import {
  checkKnowledgeHygieneV2,
  readKnowledgeHygieneInstructionV2,
  type KnowledgeHygieneEnginePortsV2,
} from "./engine-v2.js";
import { detectNarrativeSignals } from "./narrative-detector.js";
import {
  SemanticDecisionV1,
  SemanticEvidencePackV1,
  SemanticJudgeBudgetV1,
  SemanticJudgeError,
  SemanticJudgeRequestV1,
  invokeSemanticJudge,
  jsonSha256,
  type SemanticAuditDimensionV1,
  type SemanticEvidencePackV1 as SemanticEvidencePack,
  type SemanticJudgePort,
} from "./semantic-judge.js";
import {
  KnowledgeHygieneFindingV2,
  KnowledgeHygieneReportV2,
  type CoverageDimensionV2,
  type KnowledgeHygieneCitationV2,
  type KnowledgeHygieneFindingV2 as KnowledgeHygieneFinding,
  type KnowledgeHygieneReportV2 as KnowledgeHygieneReport,
} from "./types-v2.js";

export const SemanticAuditInputV1 = z
  .object({
    repo_root: z.string().min(1),
    mode: z.enum(["all", "worktree", "range", "base_to_worktree"]),
    base_ref: z.string().min(1).optional(),
    head_ref: z.string().min(1).optional(),
    config_path: z.string().min(1).optional(),
    dimensions: z
      .array(z.enum(["narrative", "contradiction", "drift", "memory_overlap"]))
      .min(1),
    budget: SemanticJudgeBudgetV1,
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.dimensions).size !== input.dimensions.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dimensions"],
        message: "semantic dimensions must be unique",
      });
    }
    if (input.mode === "range" && (!input.base_ref || !input.head_ref)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "range mode requires base_ref and head_ref",
      });
    }
    if (input.mode === "base_to_worktree" && !input.base_ref) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "base_to_worktree mode requires base_ref",
      });
    }
    if (
      (input.mode === "all" || input.mode === "worktree")
      && (input.base_ref !== undefined || input.head_ref !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${input.mode} mode does not accept Git refs`,
      });
    }
    if (input.mode === "base_to_worktree" && input.head_ref !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "base_to_worktree mode does not accept head_ref",
      });
    }
  });
export type SemanticAuditInputV1 = z.infer<typeof SemanticAuditInputV1>;

export interface SemanticAuditPortsV1 {
  judge: SemanticJudgePort;
  v2?: KnowledgeHygieneEnginePortsV2;
  signal?: AbortSignal;
}

interface Candidate {
  id: string;
  sources: SemanticEvidencePack["sources"];
}

interface DimensionRun {
  findings: KnowledgeHygieneFinding[];
  coverage: CoverageDimensionV2;
  rejections: Partial<Record<RejectionCode, number>>;
}

type RejectionCode =
  | "schema_error"
  | "quote_mismatch"
  | "input_drift"
  | "unsupported_claim"
  | "low_confidence"
  | "provider_error";

const outputSchema = zodToJsonSchema(SemanticDecisionV1, {
  target: "jsonSchema7",
  $refStrategy: "none",
}) as Record<string, unknown>;
const outputSchemaSha = jsonSha256(outputSchema);

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function excerpt(
  content: string,
  startLine: number,
  requestedEndLine: number,
): { start_line: number; end_line: number; text: string } | undefined {
  const lines = content.split(/\r?\n/);
  const selected: string[] = [];
  let endLine = startLine - 1;
  for (let lineNumber = startLine; lineNumber <= requestedEndLine; lineNumber += 1) {
    const line = lines[lineNumber - 1];
    if (line === undefined) break;
    const candidate = [...selected, line].join("\n");
    if (Buffer.byteLength(candidate, "utf8") > 8 * 1024) break;
    selected.push(line);
    endLine = lineNumber;
  }
  if (selected.length === 0) return undefined;
  return { start_line: startLine, end_line: endLine, text: selected.join("\n") };
}

function sourceForExcerpt(
  repoId: string,
  path: string,
  blobSha: string,
  selected: { start_line: number; end_line: number; text: string },
): SemanticEvidencePack["sources"][number] {
  return {
    source: { kind: "repository", repo_id: repoId, path },
    blob_sha256: blobSha,
    excerpts: [selected],
  };
}

function narrativeCandidates(
  content: string,
  repoId: string,
  path: string,
): Candidate[] {
  const blobSha = sha(content);
  return detectNarrativeSignals({ path, content })
    .filter((signal) => signal.rule_id !== "rulebook.invalid_waiver")
    .flatMap((signal) => {
      const selected = excerpt(content, signal.start_line, signal.end_line);
      if (selected === undefined) return [];
      return [{
        id: `narrative:${signal.rule_id}:${signal.start_line}:${signal.end_line}`,
        sources: [sourceForExcerpt(repoId, path, blobSha, selected)],
      }];
    });
}

interface RuleLine {
  line: number;
  text: string;
  terms: Set<string>;
}

function ruleLines(content: string): RuleLine[] {
  return content.split(/\r?\n/).flatMap((text, index) => {
    const trimmed = text.trim();
    if (
      trimmed.length === 0
      || !/(?:\bmust\b|\bshould\b|\bnever\b|\balways\b|必须|不得|禁止|应当)/iu.test(trimmed)
    ) {
      return [];
    }
    const terms = new Set(
      (trimmed.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? [])
        .filter((term) => !["must", "should", "never", "always"].includes(term)),
    );
    return [{ line: index + 1, text, terms }];
  });
}

function contradictionCandidates(
  content: string,
  repoId: string,
  path: string,
): Candidate[] {
  const rules = ruleLines(content);
  const blobSha = sha(content);
  const candidates: Candidate[] = [];
  for (let leftIndex = 0; leftIndex < rules.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rules.length; rightIndex += 1) {
      const left = rules[leftIndex];
      const right = rules[rightIndex];
      if (left === undefined || right === undefined) continue;
      if (![...left.terms].some((term) => right.terms.has(term))) continue;
      candidates.push({
        id: `contradiction:${left.line}:${right.line}`,
        sources: [
          sourceForExcerpt(repoId, path, blobSha, {
            start_line: left.line,
            end_line: left.line,
            text: left.text,
          }),
          sourceForExcerpt(repoId, path, blobSha, {
            start_line: right.line,
            end_line: right.line,
            text: right.text,
          }),
        ],
      });
      if (candidates.length >= 64) return candidates;
    }
  }
  return candidates;
}

function candidatesForDimension(
  dimension: SemanticAuditDimensionV1,
  content: string,
  repoId: string,
  path: string,
): Candidate[] {
  if (dimension === "narrative") {
    return narrativeCandidates(content, repoId, path);
  }
  if (dimension === "contradiction") {
    return contradictionCandidates(content, repoId, path);
  }
  // Drift requires mechanical history and memory-overlap requires an enabled
  // external memory adapter. An empty bounded candidate set is honest here.
  return [];
}

function buildPack(
  dimension: SemanticAuditDimensionV1,
  candidate: Candidate,
  sourceUnitsTotal: number,
  budget: z.infer<typeof SemanticJudgeBudgetV1>,
): SemanticEvidencePack {
  const body = {
    pack_id: `khep_${sha(JSON.stringify([dimension, candidate.id, candidate.sources]))}`,
    dimension,
    source_units_total: sourceUnitsTotal,
    candidate_generator: { id: `${dimension}-bounded-candidates`, version: "1" },
    sources: candidate.sources,
    candidates: [{
      candidate_id: candidate.id,
      source_indexes: candidate.sources.map((_source, index) => index),
    }],
    redaction_count: 0,
    prompt_version: "1",
    output_schema_sha256: outputSchemaSha,
    budget,
  };
  return SemanticEvidencePackV1.parse({
    ...body,
    pack_sha256: jsonSha256(body),
  });
}

function sourceEquals(
  left: KnowledgeHygieneCitationV2["source"],
  right: KnowledgeHygieneCitationV2["source"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function citationsMatchPack(
  citations: readonly KnowledgeHygieneCitationV2[],
  pack: SemanticEvidencePack,
): boolean {
  return citations.every((citation) => pack.sources.some((sourceEntry) =>
    sourceEquals(citation.source, sourceEntry.source)
    && citation.blob_sha256 === sourceEntry.blob_sha256
    && sourceEntry.excerpts.some((sourceExcerpt) =>
      citation.start_line === sourceExcerpt.start_line
      && citation.end_line === sourceExcerpt.end_line
      && citation.excerpt === sourceExcerpt.text
      && citation.text_sha256 === sha(sourceExcerpt.text)
    )
  ));
}

const semanticRuleId: Readonly<Record<SemanticAuditDimensionV1, KnowledgeHygieneFinding["rule_id"]>> = {
  narrative: "semantic.narrative",
  contradiction: "semantic.contradiction",
  drift: "semantic.drift",
  memory_overlap: "semantic.memory_overlap",
};

function semanticFinding(
  decision: z.infer<typeof SemanticDecisionV1>,
  candidate: Candidate,
  pack: SemanticEvidencePack,
  repoId: string,
  runId: string,
): KnowledgeHygieneFinding {
  const firstCitation = decision.citations[0];
  if (firstCitation === undefined) {
    throw new Error("issue decision requires at least one citation");
  }
  const location = firstCitation.source.kind === "repository"
    ? {
        kind: "repository" as const,
        repo_id: firstCitation.source.repo_id,
        path: firstCitation.source.path,
        line: firstCitation.start_line,
      }
    : {
        kind: "adapter" as const,
        adapter_id: firstCitation.source.adapter_id,
        uri: firstCitation.source.uri,
        line: firstCitation.start_line,
      };
  const ruleId = semanticRuleId[decision.dimension];
  const fingerprint = `khf_${sha(JSON.stringify([
    "2",
    ruleId,
    decision.dimension,
    [repoId, candidate.id],
    decision.citations.map((citation) => citation.text_sha256).sort(),
    "1",
  ]))}`;
  return KnowledgeHygieneFindingV2.parse({
    fingerprint,
    rule_id: ruleId,
    rule_version: "1",
    surface: firstCitation.source.kind === "adapter" ? "memory" : "instruction",
    severity: "warning",
    confidence: decision.confidence,
    location,
    observed: {
      verdict: decision.verdict,
      candidate_id: candidate.id,
      proposed_disposition: decision.proposed_disposition,
    },
    expected: { semantic_issue: false },
    rationale: decision.rationale,
    evidence_refs: [{
      kind: "evidence_pack",
      ref: pack.pack_id,
      sha256: pack.pack_sha256,
      run_id: runId,
    }],
    remediation: { mode: "human_decision" },
    origin: "semantic",
    dimension: decision.dimension,
    closure_policy: "semantic_confirmation_required",
    citations: decision.citations,
  });
}

function increment(
  counts: Partial<Record<RejectionCode, number>>,
  code: RejectionCode,
): void {
  counts[code] = (counts[code] ?? 0) + 1;
}

async function auditDimension(
  dimension: SemanticAuditDimensionV1,
  candidates: readonly Candidate[],
  sourceUnitsTotal: number,
  totalBudget: z.infer<typeof SemanticJudgeBudgetV1>,
  port: SemanticJudgePort,
  repoId: string,
  runId: string,
  signal: AbortSignal,
): Promise<DimensionRun> {
  const findings: KnowledgeHygieneFinding[] = [];
  const rejections: Partial<Record<RejectionCode, number>> = {};
  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  let assessed = 0;
  let failure: "provider_error" | undefined;
  let truncation:
    | "input_budget_exhausted"
    | "output_budget_exhausted"
    | "call_budget_exhausted"
    | undefined;

  for (const candidate of candidates) {
    if (calls >= totalBudget.max_calls) {
      truncation = "call_budget_exhausted";
      break;
    }
    const remaining = {
      max_input_tokens: totalBudget.max_input_tokens - inputTokens,
      max_output_tokens: totalBudget.max_output_tokens - outputTokens,
      max_calls: totalBudget.max_calls - calls,
    };
    if (remaining.max_input_tokens < 1) {
      truncation = "input_budget_exhausted";
      break;
    }
    if (remaining.max_output_tokens < 1) {
      truncation = "output_budget_exhausted";
      break;
    }
    const pack = buildPack(dimension, candidate, sourceUnitsTotal, remaining);
    const estimatedInput = Math.ceil(Buffer.byteLength(JSON.stringify(pack), "utf8") / 4);
    if (estimatedInput > remaining.max_input_tokens) {
      truncation = "input_budget_exhausted";
      break;
    }
    const nonce = `khn_${sha(JSON.stringify([runId, pack.pack_id, calls]))}`;
    const request = SemanticJudgeRequestV1.parse({
      run_id: runId,
      nonce,
      evidence_pack: pack,
      output_schema: outputSchema,
      output_schema_sha256: outputSchemaSha,
      budget: remaining,
    });
    try {
      const judged = await invokeSemanticJudge(port, request, signal);
      calls += judged.response.usage.calls;
      inputTokens += judged.response.usage.input_tokens;
      outputTokens += judged.response.usage.output_tokens;
      assessed += 1;
      const decision = judged.decision;
      if (!citationsMatchPack(decision.citations, pack)) {
        increment(rejections, "quote_mismatch");
        continue;
      }
      if (decision.verdict === "uncertain" || decision.confidence === "low") {
        increment(rejections, "low_confidence");
        continue;
      }
      if (decision.verdict !== "issue") continue;
      if (decision.citations.length === 0) {
        increment(rejections, "unsupported_claim");
        continue;
      }
      findings.push(semanticFinding(decision, candidate, pack, repoId, runId));
    } catch (error) {
      if (error instanceof SemanticJudgeError && error.code === "schema_error") {
        assessed += 1;
        increment(rejections, "schema_error");
        continue;
      }
      if (error instanceof SemanticJudgeError && error.code === "budget_exhausted") {
        truncation = "output_budget_exhausted";
        break;
      }
      failure = "provider_error";
      increment(rejections, "provider_error");
      break;
    }
  }

  const skipped = candidates.length - assessed;
  const coverage: CoverageDimensionV2 = failure !== undefined
    ? {
        dimension,
        state: "failed",
        source_units_total: sourceUnitsTotal,
        candidates_generated: candidates.length,
        candidates_assessed: assessed,
        candidates_skipped: skipped,
        reason_codes: [failure],
      }
    : truncation !== undefined
      ? {
          dimension,
          state: "truncated",
          source_units_total: sourceUnitsTotal,
          candidates_generated: candidates.length,
          candidates_assessed: assessed,
          candidates_skipped: skipped,
          reason_codes: [truncation],
        }
      : {
          dimension,
          state: "partial",
          source_units_total: sourceUnitsTotal,
          candidates_generated: candidates.length,
          candidates_assessed: assessed,
          candidates_skipped: skipped,
          reason_codes: ["bounded_candidate_generator"],
        };
  return { findings, coverage, rejections };
}

function reportHealthClaim(
  findings: readonly KnowledgeHygieneFinding[],
  coverage: readonly CoverageDimensionV2[],
): KnowledgeHygieneReport["health_claim"] {
  if (coverage.some((entry) =>
    entry.state === "failed"
    || entry.state === "truncated"
    || (entry.state === "not_assessed"
      && !entry.reason_codes.includes("not_requested"))
  )) {
    return "assessment_incomplete";
  }
  return findings.length > 0 ? "findings_present" : "assessed_scope_clean";
}

export async function auditKnowledgeHygieneSemantics(
  rawInput: SemanticAuditInputV1,
  ports: SemanticAuditPortsV1,
): Promise<KnowledgeHygieneReport> {
  const input = SemanticAuditInputV1.parse(rawInput);
  const signal = ports.signal ?? new AbortController().signal;
  const baseline = await checkKnowledgeHygieneV2({
    schema_version: "2",
    repo_root: input.repo_root,
    mode: input.mode,
    ...(input.base_ref === undefined ? {} : { base_ref: input.base_ref }),
    ...(input.head_ref === undefined ? {} : { head_ref: input.head_ref }),
    ...(input.config_path === undefined ? {} : { config_path: input.config_path }),
  }, ports.v2);
  const loadedConfig = await loadKnowledgeHygieneConfigV2({
    repo_root: baseline.repo.root,
    ...(input.config_path === undefined ? {} : { config_path: input.config_path }),
  });
  const canonicalPath = loadedConfig.config.instructions?.canonical ?? "AGENTS.md";
  const instruction = await readKnowledgeHygieneInstructionV2(
    baseline.repo.root,
    canonicalPath,
  );
  const repoId = baseline.repo.repo_id ?? baseline.repo.root;
  const runId = `khsr_${sha(JSON.stringify([
    repoId,
    baseline.generated_at,
    input.dimensions,
    ports.judge.id,
  ]))}`;
  const dimensionResults = new Map<SemanticAuditDimensionV1, DimensionRun>();
  for (const dimension of input.dimensions) {
    if (instruction.status === "failed") {
      dimensionResults.set(dimension, {
        findings: [],
        rejections: {},
        coverage: {
          dimension,
          state: "failed",
          source_units_total: 0,
          candidates_generated: 0,
          candidates_assessed: 0,
          candidates_skipped: 0,
          reason_codes: ["scan_incomplete"],
        },
      });
      continue;
    }
    const content = instruction.status === "available" ? instruction.content : "";
    const candidates = candidatesForDimension(
      dimension,
      content,
      repoId,
      canonicalPath,
    );
    dimensionResults.set(dimension, await auditDimension(
      dimension,
      candidates,
      instruction.status === "available" ? 1 : 0,
      input.budget,
      ports.judge,
      repoId,
      runId,
      signal,
    ));
  }

  const coverage = baseline.coverage.map((entry) =>
    dimensionResults.get(entry.dimension as SemanticAuditDimensionV1)?.coverage
      ?? entry
  );
  const semanticFindings = [...dimensionResults.values()].flatMap(
    (result) => result.findings,
  );
  const findings = [...baseline.findings, ...semanticFindings].sort((left, right) =>
    left.rule_id.localeCompare(right.rule_id)
    || left.fingerprint.localeCompare(right.fingerprint)
  );
  const rejectionCounts: Partial<Record<RejectionCode, number>> = {};
  for (const result of dimensionResults.values()) {
    for (const [code, count] of Object.entries(result.rejections)) {
      rejectionCounts[code as RejectionCode] =
        (rejectionCounts[code as RejectionCode] ?? 0) + count;
    }
  }
  return KnowledgeHygieneReportV2.parse({
    ...baseline,
    findings,
    summary: {
      error: findings.filter((finding) => finding.severity === "error").length,
      warning: findings.filter((finding) => finding.severity === "warning").length,
      info: findings.filter((finding) => finding.severity === "info").length,
      suppressed: baseline.summary.suppressed,
    },
    coverage,
    health_claim: reportHealthClaim(findings, coverage),
    rejection_counts: rejectionCounts,
  });
}
