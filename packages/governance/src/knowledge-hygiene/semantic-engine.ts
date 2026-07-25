import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  loadKnowledgeHygieneConfigV2,
  type KnowledgeHygieneConfigV2,
} from "./config-v2.js";
import {
  checkKnowledgeHygieneV2,
  readKnowledgeHygieneInstructionV2,
  type KnowledgeHygieneEnginePortsV2,
} from "./engine-v2.js";
import { detectNarrativeSignals } from "./narrative-detector.js";
import {
  SEMANTIC_REDACTOR_VERSION_V1,
  composeSemanticCacheKeyV1,
  redactSemanticEvidenceSourcesV1,
} from "./semantic-evidence.js";
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
  decision_cache?: {
    read: (key: string) => Promise<unknown | undefined>;
    write: (key: string, decision: z.infer<typeof SemanticDecisionV1>) => Promise<void>;
  };
  observe_evidence_pack?: (
    pack: SemanticEvidencePack,
    cacheKey: string,
    runId: string,
  ) => Promise<void>;
}

interface Candidate {
  id: string;
  sources: SemanticEvidencePack["sources"];
}

interface CandidateBuild {
  candidates: Candidate[];
  source_units_total: number;
  status: "available" | "unavailable" | "failed";
}

interface DimensionRun {
  findings: KnowledgeHygieneFinding[];
  coverage: CoverageDimensionV2;
  rejections: Partial<Record<RejectionCode, number>>;
  usage: { input_tokens: number; output_tokens: number; calls: number };
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

function sourceForAdapterExcerpt(
  adapterId: string,
  uri: string,
  blobSha: string,
  selected: { start_line: number; end_line: number; text: string },
): SemanticEvidencePack["sources"][number] {
  return {
    source: { kind: "adapter", adapter_id: adapterId, uri },
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

function firstDifferenceExcerpt(
  content: string,
  other: string,
): { start_line: number; end_line: number; text: string } | undefined {
  const lines = content.split(/\r?\n/);
  const otherLines = other.split(/\r?\n/);
  const maximum = Math.max(lines.length, otherLines.length);
  let differentLine = 1;
  for (let index = 0; index < maximum; index += 1) {
    if (lines[index] !== otherLines[index]) {
      differentLine = index + 1;
      break;
    }
  }
  return excerpt(content, Math.max(1, differentLine - 2), differentLine + 2);
}

async function driftCandidates(input: {
  repo_root: string;
  repo_id: string;
  canonical_path: string;
  canonical_content: string;
  mirror_paths: readonly string[];
  read: typeof readKnowledgeHygieneInstructionV2;
}): Promise<CandidateBuild> {
  const canonicalSha = sha(input.canonical_content);
  const candidates: Candidate[] = [];
  let sourceUnits = 1;
  for (const mirrorPath of [...input.mirror_paths].sort()) {
    const mirror = await input.read(input.repo_root, mirrorPath);
    if (mirror.status === "failed") {
      return { candidates: [], source_units_total: sourceUnits, status: "failed" };
    }
    if (mirror.status !== "available") continue;
    sourceUnits += 1;
    if (mirror.content === input.canonical_content) continue;
    const canonicalExcerpt = firstDifferenceExcerpt(
      input.canonical_content,
      mirror.content,
    );
    const mirrorExcerpt = firstDifferenceExcerpt(
      mirror.content,
      input.canonical_content,
    );
    if (canonicalExcerpt === undefined || mirrorExcerpt === undefined) continue;
    candidates.push({
      id: `drift:${mirrorPath}:${canonicalSha}:${sha(mirror.content)}`,
      sources: [
        sourceForExcerpt(
          input.repo_id,
          input.canonical_path,
          canonicalSha,
          canonicalExcerpt,
        ),
        sourceForExcerpt(
          input.repo_id,
          mirrorPath,
          sha(mirror.content),
          mirrorExcerpt,
        ),
      ],
    });
  }
  return { candidates, source_units_total: sourceUnits, status: "available" };
}

interface MemoryEntry {
  id: string;
  uri: string;
  blob_sha256: string;
  excerpt: { start_line: number; end_line: number; text: string };
  terms: Set<string>;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === ""
    || (fromRoot !== ".."
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot));
}

function semanticTerms(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? [])
      .filter((term) => !["the", "and", "with", "that", "this", "from"].includes(term)),
  );
}

function memoryEntry(
  relativePath: string,
  content: string,
): MemoryEntry | undefined {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim().length > 0);
  if (startIndex < 0) return undefined;
  let endIndex = startIndex;
  let nonEmpty = 0;
  for (let index = startIndex; index < lines.length && index < startIndex + 30; index += 1) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.trim().length > 0) nonEmpty += 1;
    endIndex = index;
    if (nonEmpty >= 2 && line.trim().length === 0) break;
  }
  const selected = excerpt(content, startIndex + 1, endIndex + 1);
  if (selected === undefined) return undefined;
  const terms = semanticTerms(selected.text);
  if (terms.size === 0) return undefined;
  return {
    id: relativePath,
    uri: `claude-code://auto-memory/${relativePath}`,
    blob_sha256: sha(content),
    excerpt: selected,
    terms,
  };
}

function overlap(left: Set<string>, right: Set<string>): {
  shared: number;
  score: number;
} {
  const shared = [...left].filter((term) => right.has(term)).length;
  const union = new Set([...left, ...right]).size;
  return { shared, score: union === 0 ? 0 : shared / union };
}

async function readMemoryEntries(
  configuredRoot: string,
): Promise<{ status: "available" | "failed"; entries: MemoryEntry[] }> {
  const expanded = configuredRoot.startsWith("~/")
    ? resolve(homedir(), configuredRoot.slice(2))
    : resolve(configuredRoot);
  if (!isAbsolute(configuredRoot) && !configuredRoot.startsWith("~/")) {
    return { status: "failed", entries: [] };
  }
  try {
    const root = await realpath(expanded);
    const pending = [root];
    const files: string[] = [];
    let entriesInspected = 0;
    while (pending.length > 0 && files.length < 1_000) {
      const directory = pending.shift();
      if (directory === undefined) break;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        entriesInspected += 1;
        if (entriesInspected > 5_000) {
          return { status: "failed", entries: [] };
        }
        const path = resolve(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) pending.push(path);
        if (entry.isFile() && /\.md$/iu.test(entry.name)) files.push(path);
        if (files.length >= 1_000) break;
      }
    }
    const memoryEntries: MemoryEntry[] = [];
    for (const path of files.sort()) {
      const resolved = await realpath(path);
      if (!isInsideRoot(root, resolved)) return { status: "failed", entries: [] };
      const stats = await lstat(resolved);
      if (!stats.isFile() || stats.size > 2 * 1024 * 1024) continue;
      const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: string;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > 2 * 1024 * 1024) continue;
        content = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      const parsed = memoryEntry(relative(root, resolved).split(sep).join("/"), content);
      if (parsed !== undefined) memoryEntries.push(parsed);
    }
    return { status: "available", entries: memoryEntries };
  } catch {
    return { status: "failed", entries: [] };
  }
}

async function memoryOverlapCandidates(
  enabled: boolean,
  memoryDirectory: string | undefined,
): Promise<CandidateBuild> {
  if (!enabled || memoryDirectory === undefined) {
    return { candidates: [], source_units_total: 0, status: "unavailable" };
  }
  const read = await readMemoryEntries(memoryDirectory);
  if (read.status === "failed") {
    return { candidates: [], source_units_total: 0, status: "failed" };
  }
  const candidates: Candidate[] = [];
  for (let leftIndex = 0; leftIndex < read.entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < read.entries.length; rightIndex += 1) {
      const left = read.entries[leftIndex];
      const right = read.entries[rightIndex];
      if (left === undefined || right === undefined) continue;
      const similarity = overlap(left.terms, right.terms);
      if (similarity.shared < 3 || similarity.score < 0.35) continue;
      candidates.push({
        id: `memory_overlap:${left.id}:${right.id}`,
        sources: [
          sourceForAdapterExcerpt(
            "claude-code",
            left.uri,
            left.blob_sha256,
            left.excerpt,
          ),
          sourceForAdapterExcerpt(
            "claude-code",
            right.uri,
            right.blob_sha256,
            right.excerpt,
          ),
        ],
      });
      if (candidates.length >= 64) break;
    }
    if (candidates.length >= 64) break;
  }
  return {
    candidates,
    source_units_total: read.entries.length,
    status: "available",
  };
}

function localCandidatesForDimension(
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
  return [];
}

function buildPack(
  dimension: SemanticAuditDimensionV1,
  candidate: Candidate,
  sourceUnitsTotal: number,
  budget: z.infer<typeof SemanticJudgeBudgetV1>,
): SemanticEvidencePack {
  const redacted = redactSemanticEvidenceSourcesV1(candidate.sources);
  const body = {
    pack_id: `khep_${sha(JSON.stringify([dimension, candidate.id, redacted.sources]))}`,
    dimension,
    source_units_total: sourceUnitsTotal,
    candidate_generator: { id: `${dimension}-bounded-candidates`, version: "1" },
    sources: redacted.sources,
    candidates: [{
      candidate_id: candidate.id,
      source_indexes: redacted.sources.map((_source, index) => index),
    }],
    redaction_count: redacted.redaction_count,
    prompt_version: "1",
    output_schema_sha256: outputSchemaSha,
    budget,
  };
  return SemanticEvidencePackV1.parse({
    ...body,
    pack_sha256: jsonSha256(body),
  });
}

function semanticCacheKey(
  pack: SemanticEvidencePack,
  candidate: Candidate,
  configSha: string,
  port: SemanticJudgePort,
) {
  return composeSemanticCacheKeyV1({
    evidence_pack_sha256: pack.pack_sha256,
    candidate_index_sha256: sha(JSON.stringify({
      id: candidate.id,
      sources: candidate.sources.map((source) => ({
        source: source.source,
        excerpts: source.excerpts.map((selected) => ({
          start_line: selected.start_line,
          end_line: selected.end_line,
        })),
      })),
    })),
    config_sha256: configSha,
    rule_versions_sha256: sha(JSON.stringify({
      rule_id: semanticRuleId[pack.dimension],
      rule_version: "1",
      candidate_generator: pack.candidate_generator,
    })),
    prompt_version: port.prompt_version,
    output_schema_sha256: pack.output_schema_sha256,
    model_id: port.model_id,
    judge_id: port.id,
    budget: pack.budget,
    redactor_version: SEMANTIC_REDACTOR_VERSION_V1,
    associated_blob_sha256: [...new Set(
      candidate.sources.map((source) => source.blob_sha256),
    )],
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
  cross_repository: "semantic.cross_repository_impact",
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
  configSha: string,
  cache: SemanticAuditPortsV1["decision_cache"],
  observeEvidencePack: SemanticAuditPortsV1["observe_evidence_pack"],
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
    const cacheKey = semanticCacheKey(pack, candidate, configSha, port);
    if (observeEvidencePack !== undefined) {
      await observeEvidencePack(pack, cacheKey, runId);
    }
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
      let decision: z.infer<typeof SemanticDecisionV1> | undefined;
      if (cache !== undefined) {
        try {
          const cached = SemanticDecisionV1.safeParse(await cache.read(cacheKey));
          if (cached.success && cached.data.dimension === dimension) {
            decision = cached.data;
          }
        } catch {
          // A cache is an optimization. Corrupt or unavailable cache state must
          // never become a finding or prevent a fresh evidence-bound decision.
        }
      }
      if (decision === undefined) {
        calls += 1;
        const judged = await invokeSemanticJudge(port, request, signal);
        calls += Math.max(1, judged.response.usage.calls) - 1;
        inputTokens += judged.response.usage.input_tokens;
        outputTokens += judged.response.usage.output_tokens;
        decision = judged.decision;
        if (cache !== undefined) {
          try {
            await cache.write(cacheKey, decision);
          } catch {
            // See cache-read comment above: cache I/O is never authoritative.
          }
        }
      }
      assessed += 1;
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
  return {
    findings,
    coverage,
    rejections,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, calls },
  };
}

async function buildCandidatesForDimension(input: {
  dimension: SemanticAuditDimensionV1;
  instruction: Awaited<ReturnType<typeof readKnowledgeHygieneInstructionV2>>;
  config: KnowledgeHygieneConfigV2;
  repo_root: string;
  repo_id: string;
  canonical_path: string;
  read: typeof readKnowledgeHygieneInstructionV2;
}): Promise<CandidateBuild> {
  if (input.dimension === "memory_overlap") {
    const adapter = input.config.adapters?.claude_code;
    return memoryOverlapCandidates(
      adapter?.enabled ?? false,
      adapter?.memory_dir,
    );
  }
  if (input.instruction.status === "failed") {
    return { candidates: [], source_units_total: 0, status: "failed" };
  }
  if (input.instruction.status !== "available") {
    return { candidates: [], source_units_total: 0, status: "available" };
  }
  if (input.dimension === "drift") {
    return driftCandidates({
      repo_root: input.repo_root,
      repo_id: input.repo_id,
      canonical_path: input.canonical_path,
      canonical_content: input.instruction.content,
      mirror_paths: (input.config.instructions?.mirrors ?? []).map(
        (mirror) => mirror.path,
      ),
      read: input.read,
    });
  }
  return {
    candidates: localCandidatesForDimension(
      input.dimension,
      input.instruction.content,
      input.repo_id,
      input.canonical_path,
    ),
    source_units_total: 1,
    status: "available",
  };
}

function unavailableDimension(
  dimension: SemanticAuditDimensionV1,
  state: "failed" | "not_assessed",
): DimensionRun {
  return {
    findings: [],
    rejections: {},
    usage: { input_tokens: 0, output_tokens: 0, calls: 0 },
    coverage: {
      dimension,
      state,
      source_units_total: 0,
      candidates_generated: 0,
      candidates_assessed: 0,
      candidates_skipped: 0,
      reason_codes: state === "failed"
        ? ["scan_incomplete"]
        : ["judge_unavailable"],
    },
  };
}

function exhaustedDimension(
  dimension: SemanticAuditDimensionV1,
  build: CandidateBuild,
  reason:
    | "input_budget_exhausted"
    | "output_budget_exhausted"
    | "call_budget_exhausted",
): DimensionRun {
  return {
    findings: [],
    rejections: {},
    usage: { input_tokens: 0, output_tokens: 0, calls: 0 },
    coverage: {
      dimension,
      state: "truncated",
      source_units_total: build.source_units_total,
      candidates_generated: build.candidates.length,
      candidates_assessed: 0,
      candidates_skipped: build.candidates.length,
      reason_codes: [reason],
    },
  };
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
  const readInstruction = ports.v2?.read_instruction
    ?? readKnowledgeHygieneInstructionV2;
  const instruction = await readInstruction(
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
  const configSha = loadedConfig.mode === "configured"
    ? loadedConfig.sha256
    : sha(JSON.stringify(loadedConfig.config));
  const dimensionResults = new Map<SemanticAuditDimensionV1, DimensionRun>();
  const consumed = { input_tokens: 0, output_tokens: 0, calls: 0 };
  for (const dimension of input.dimensions) {
    const build = await buildCandidatesForDimension({
      dimension,
      instruction,
      config: loadedConfig.config,
      repo_root: baseline.repo.root,
      repo_id: repoId,
      canonical_path: canonicalPath,
      read: readInstruction,
    });
    if (build.status === "failed") {
      dimensionResults.set(dimension, unavailableDimension(dimension, "failed"));
      continue;
    }
    if (build.status === "unavailable") {
      dimensionResults.set(
        dimension,
        unavailableDimension(dimension, "not_assessed"),
      );
      continue;
    }
    const remaining = {
      max_input_tokens: input.budget.max_input_tokens - consumed.input_tokens,
      max_output_tokens: input.budget.max_output_tokens - consumed.output_tokens,
      max_calls: input.budget.max_calls - consumed.calls,
    };
    if (build.candidates.length > 0 && remaining.max_calls < 1) {
      dimensionResults.set(
        dimension,
        exhaustedDimension(dimension, build, "call_budget_exhausted"),
      );
      continue;
    }
    if (build.candidates.length > 0 && remaining.max_input_tokens < 1) {
      dimensionResults.set(
        dimension,
        exhaustedDimension(dimension, build, "input_budget_exhausted"),
      );
      continue;
    }
    if (build.candidates.length > 0 && remaining.max_output_tokens < 1) {
      dimensionResults.set(
        dimension,
        exhaustedDimension(dimension, build, "output_budget_exhausted"),
      );
      continue;
    }
    const result = await auditDimension(
      dimension,
      build.candidates,
      build.source_units_total,
      {
        max_input_tokens: Math.max(1, remaining.max_input_tokens),
        max_output_tokens: Math.max(1, remaining.max_output_tokens),
        max_calls: Math.max(1, remaining.max_calls),
      },
      ports.judge,
      repoId,
      runId,
      signal,
      configSha,
      ports.decision_cache,
      ports.observe_evidence_pack,
    );
    consumed.input_tokens += result.usage.input_tokens;
    consumed.output_tokens += result.usage.output_tokens;
    consumed.calls += result.usage.calls;
    dimensionResults.set(dimension, result);
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
