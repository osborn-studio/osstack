import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  loadKnowledgeHygieneConfigV2,
  projectKnowledgeHygieneConfigV2ToV1,
  type LoadedKnowledgeHygieneConfigV2,
} from "./config-v2.js";
import {
  type KnowledgeHygieneEnginePortsV1,
  checkKnowledgeHygiene,
} from "./engine.js";
import {
  detectNarrativeSignals,
  type NarrativeSignalV1,
} from "./narrative-detector.js";
import { matchesKnowledgeHygienePathPatternV1 } from "./path-pattern.js";
import {
  KnowledgeHygieneCheckInputV1,
  KnowledgeHygieneRuleIdV1,
  type KnowledgeHygieneFindingV1,
  type KnowledgeHygieneReportV1,
} from "./types.js";
import {
  type COVERAGE_DIMENSION_ORDER_V2,
  KnowledgeHygieneCheckInputV2,
  KnowledgeHygieneFindingV2,
  KnowledgeHygieneReportV2,
  type KnowledgeHygieneCheckInputV2 as KnowledgeHygieneCheckInput,
  type KnowledgeHygieneFindingV2 as KnowledgeHygieneFinding,
  type KnowledgeHygieneReportV2 as KnowledgeHygieneReport,
  type KnowledgeHygieneRuleIdV2,
} from "./types-v2.js";

const MAX_INSTRUCTION_BYTES = 1024 * 1024;
const severityOrder = { error: 0, warning: 1, info: 2 } as const;
const narrativeRuleIds: readonly KnowledgeHygieneRuleIdV2[] = [
  "rulebook.managed_context_block",
  "rulebook.narrative_block",
  "rulebook.narrative_density",
];

export interface KnowledgeHygieneEnginePortsV2 {
  v1?: KnowledgeHygieneEnginePortsV1;
  load_config?: typeof loadKnowledgeHygieneConfigV2;
  read_instruction?: (
    repoRoot: string,
    path: string,
  ) => Promise<InstructionReadResultV2>;
}

export type InstructionReadResultV2 =
  | { status: "available"; content: string }
  | { status: "absent" }
  | { status: "failed"; reason: string };

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ""
    || (
      pathFromRoot !== ".."
      && !pathFromRoot.startsWith(`..${sep}`)
      && !isAbsolute(pathFromRoot)
    );
}

export async function readKnowledgeHygieneInstructionV2(
  repoRoot: string,
  path: string,
): Promise<InstructionReadResultV2> {
  const candidate = resolve(repoRoot, path);
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(candidate);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "absent" };
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!isInsideRoot(repoRoot, resolvedPath)) {
    return {
      status: "failed",
      reason: `instruction path resolves outside repository: ${path}`,
    };
  }
  try {
    const metadata = await stat(resolvedPath);
    if (!metadata.isFile()) {
      return { status: "failed", reason: `instruction path is not a file: ${path}` };
    }
    if (metadata.size > MAX_INSTRUCTION_BYTES) {
      return {
        status: "failed",
        reason: `instruction path exceeds ${MAX_INSTRUCTION_BYTES} bytes: ${path}`,
      };
    }
    return { status: "available", content: await readFile(resolvedPath, "utf8") };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function v1Input(input: KnowledgeHygieneCheckInput): KnowledgeHygieneCheckInputV1 {
  const projected: Record<string, unknown> = { ...input };
  delete projected.schema_version;
  if (input.checks !== undefined) {
    projected.checks = input.checks.filter(
      (ruleId) => KnowledgeHygieneRuleIdV1.safeParse(ruleId).success,
    );
  }
  if (input.skip_checks !== undefined) {
    projected.skip_checks = input.skip_checks.filter(
      (ruleId) => KnowledgeHygieneRuleIdV1.safeParse(ruleId).success,
    );
  }
  return KnowledgeHygieneCheckInputV1.parse(projected);
}

function v1LoadedConfig(
  loaded: LoadedKnowledgeHygieneConfigV2,
): Awaited<ReturnType<NonNullable<KnowledgeHygieneEnginePortsV1["load_config"]>>> {
  if (loaded.mode === "zero_config") {
    return { mode: "zero_config", path: loaded.path };
  }
  return {
    mode: "configured",
    path: loaded.path,
    sha256: loaded.sha256,
    config: projectKnowledgeHygieneConfigV2ToV1(loaded.config),
  };
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function findingFingerprint(input: {
  ruleId: KnowledgeHygieneRuleIdV2;
  dimension: KnowledgeHygieneFinding["dimension"];
  repoId: string;
  subject: string;
  citationHashes: readonly string[];
}): string {
  return `khf_${sha(JSON.stringify([
    "2",
    input.ruleId,
    input.dimension,
    [input.repoId, input.subject],
    [...input.citationHashes].sort(),
    "1",
  ]))}`;
}

function v1Location(
  finding: KnowledgeHygieneFindingV1,
  repoId: string,
): KnowledgeHygieneFinding["location"] {
  const adapterDelimiter = finding.location.path.indexOf("://");
  if (adapterDelimiter > 0) {
    return {
      kind: "adapter",
      adapter_id: finding.location.path.slice(0, adapterDelimiter),
      uri: finding.location.path,
      ...(finding.location.line === undefined
        ? {}
        : { line: finding.location.line }),
      ...(finding.location.anchor === undefined
        ? {}
        : { anchor: finding.location.anchor }),
    };
  }
  return {
    kind: "repository",
    repo_id: repoId,
    path: finding.location.path,
    ...(finding.location.line === undefined ? {} : { line: finding.location.line }),
    ...(finding.location.anchor === undefined
      ? {}
      : { anchor: finding.location.anchor }),
  };
}

function projectV1Finding(
  finding: KnowledgeHygieneFindingV1,
  repoId: string,
): KnowledgeHygieneFinding {
  const location = v1Location(finding, repoId);
  const closurePolicy = finding.rule_id === "contract.review_required"
    || finding.remediation.mode === "human_decision"
    ? "semantic_confirmation_required"
    : "mechanical_sufficient";
  const subject = location.kind === "repository"
    ? location.path
    : location.kind === "adapter"
      ? location.uri
      : location.obligation_id ?? location.edge_id ?? location.registry_scope;
  return KnowledgeHygieneFindingV2.parse({
    ...finding,
    fingerprint: findingFingerprint({
      ruleId: finding.rule_id,
      dimension: "mechanical",
      repoId,
      subject,
      citationHashes: [],
    }),
    location,
    origin: "mechanical",
    dimension: "mechanical",
    closure_policy: closurePolicy,
    citations: [],
  });
}

const narrativeRationale: Readonly<Record<NarrativeSignalV1["rule_id"], string>> = {
  "rulebook.managed_context_block":
    "Managed session context is transient narrative, not durable instruction authority.",
  "rulebook.narrative_block":
    "A dense sequence of session or dated observations is likely history rather than a durable rule.",
  "rulebook.narrative_density":
    "Narrative signals occupy too much of the instruction surface.",
  "rulebook.invalid_waiver":
    "The suppression pragma is malformed, unknown, or does not govern a matching finding.",
};

function excerptForSignal(content: string, signal: NarrativeSignalV1): {
  excerpt: string;
  startLine: number;
  endLine: number;
} | undefined {
  const lines = content.split(/\r?\n/);
  const selected: string[] = [];
  let endLine = signal.start_line - 1;
  for (
    let lineNumber = signal.start_line;
    lineNumber <= signal.end_line;
    lineNumber += 1
  ) {
    const line = lines[lineNumber - 1];
    if (line === undefined) break;
    const candidate = [...selected, line].join("\n");
    if (Buffer.byteLength(candidate, "utf8") > 1024) break;
    selected.push(line);
    endLine = lineNumber;
  }
  if (selected.length === 0) return undefined;
  return {
    excerpt: selected.join("\n"),
    startLine: signal.start_line,
    endLine,
  };
}

function narrativeFinding(
  signal: NarrativeSignalV1,
  content: string,
  path: string,
  repoId: string,
): KnowledgeHygieneFinding {
  const selected = excerptForSignal(content, signal);
  const contentSha = sha(content);
  const citations = selected === undefined
    ? []
    : [{
        source: { kind: "repository" as const, repo_id: repoId, path },
        blob_sha256: contentSha,
        start_line: selected.startLine,
        end_line: selected.endLine,
        text_sha256: sha(selected.excerpt),
        excerpt: selected.excerpt,
      }];
  return KnowledgeHygieneFindingV2.parse({
    fingerprint: findingFingerprint({
      ruleId: signal.rule_id,
      dimension: signal.rule_id === "rulebook.invalid_waiver"
        ? "mechanical"
        : "narrative",
      repoId,
      subject: path,
      citationHashes: citations.map((citation) => citation.text_sha256),
    }),
    rule_id: signal.rule_id,
    rule_version: "1",
    surface: "instruction",
    severity: signal.severity,
    confidence: signal.confidence,
    location: {
      kind: "repository",
      repo_id: repoId,
      path,
      line: signal.start_line,
      anchor: `lines:${signal.start_line}-${signal.end_line}`,
    },
    observed: signal.observed,
    expected: signal.rule_id === "rulebook.invalid_waiver"
      ? { valid_and_attached_waiver: true }
      : { narrative_signal_absent: true },
    rationale: narrativeRationale[signal.rule_id],
    evidence_refs: [],
    remediation: {
      mode: signal.rule_id === "rulebook.invalid_waiver"
        ? "human_decision"
        : "agent_edit",
    },
    origin: "mechanical",
    dimension: signal.rule_id === "rulebook.invalid_waiver"
      ? "mechanical"
      : "narrative",
    closure_policy: "mechanical_sufficient",
    citations,
  });
}

function selected(
  input: KnowledgeHygieneCheckInput,
  ruleId: KnowledgeHygieneRuleIdV2,
): boolean {
  if (input.checks !== undefined) return input.checks.includes(ruleId);
  if (input.skip_checks !== undefined) return !input.skip_checks.includes(ruleId);
  return true;
}

function suppressed(
  finding: KnowledgeHygieneFinding,
  loaded: LoadedKnowledgeHygieneConfigV2,
): boolean {
  if (finding.location.kind !== "repository") return false;
  const findingPath = finding.location.path;
  return loaded.config.ignore.some(
    (entry) => entry.rule_id === finding.rule_id
      && entry.paths.some((pattern) =>
        matchesKnowledgeHygienePathPatternV1(pattern, findingPath)
      ),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function locationKey(finding: KnowledgeHygieneFinding): string {
  if (finding.location.kind === "repository") return finding.location.path;
  if (finding.location.kind === "adapter") return finding.location.uri;
  return finding.location.obligation_id ?? finding.location.edge_id ?? "";
}

function sortFindings(
  findings: readonly KnowledgeHygieneFinding[],
): KnowledgeHygieneFinding[] {
  return [...findings].sort((left, right) =>
    severityOrder[left.severity] - severityOrder[right.severity]
    || compareText(left.rule_id, right.rule_id)
    || compareText(locationKey(left), locationKey(right))
    || compareText(left.fingerprint, right.fingerprint)
  );
}

function notRequestedCoverage(
  dimension: (typeof COVERAGE_DIMENSION_ORDER_V2)[number],
) {
  return {
    dimension,
    state: "not_assessed" as const,
    source_units_total: 0,
    candidates_generated: 0,
    candidates_assessed: 0,
    candidates_skipped: 0,
    reason_codes: ["not_requested" as const],
  };
}

function expectedHealthClaim(
  findings: readonly KnowledgeHygieneFinding[],
  failed: boolean,
) {
  if (failed) return "assessment_incomplete" as const;
  return findings.length > 0
    ? "findings_present" as const
    : "assessed_scope_clean" as const;
}

export async function checkKnowledgeHygieneV2(
  rawInput: KnowledgeHygieneCheckInput,
  ports: KnowledgeHygieneEnginePortsV2 = {},
): Promise<KnowledgeHygieneReport> {
  const input = KnowledgeHygieneCheckInputV2.parse(rawInput);
  const loadConfig = ports.load_config ?? loadKnowledgeHygieneConfigV2;
  const loadedConfig = await loadConfig({
    repo_root: input.repo_root,
    ...(input.config_path === undefined ? {} : { config_path: input.config_path }),
  });
  const mechanicalReport: KnowledgeHygieneReportV1 = await checkKnowledgeHygiene(
    v1Input(input),
    {
      ...ports.v1,
      load_config: async () => v1LoadedConfig(loadedConfig),
    },
  );
  const repoId = mechanicalReport.repo.repo_id ?? mechanicalReport.repo.root;
  const canonicalPath = loadedConfig.config.instructions?.canonical ?? "AGENTS.md";
  const read = ports.read_instruction ?? readKnowledgeHygieneInstructionV2;
  const narrativeRequested = narrativeRuleIds.some((ruleId) =>
    selected(input, ruleId)
  );
  const invalidWaiverRequested = selected(input, "rulebook.invalid_waiver");
  const u0Requested = narrativeRequested || invalidWaiverRequested;
  const instruction: InstructionReadResultV2 = u0Requested
    ? await read(mechanicalReport.repo.root, canonicalPath)
    : { status: "absent" };

  const signals = instruction.status === "available"
    ? detectNarrativeSignals({ path: canonicalPath, content: instruction.content })
      .filter((signal) => selected(input, signal.rule_id))
    : [];
  const projectedMechanical = mechanicalReport.findings.map((finding) =>
    projectV1Finding(finding, repoId)
  );
  const narrative = instruction.status === "available"
    ? signals.map((signal) =>
        narrativeFinding(signal, instruction.content, canonicalPath, repoId)
      )
    : [];
  const combined = [...projectedMechanical, ...narrative];
  const active = sortFindings(combined.filter((finding) =>
    !suppressed(finding, loadedConfig)
  ));
  const suppressedV2 = combined.length - active.length;
  const mechanicalSignals = signals.filter(
    (signal) => signal.rule_id === "rulebook.invalid_waiver",
  );
  const narrativeSignals = signals.filter(
    (signal) => signal.rule_id !== "rulebook.invalid_waiver",
  );
  const mechanicalFailed = !mechanicalReport.completeness.complete
    || (invalidWaiverRequested && instruction.status === "failed");
  const narrativeFailed = narrativeRequested && instruction.status === "failed";
  const coverage = [
    {
      dimension: "mechanical" as const,
      state: mechanicalFailed ? "failed" as const : "complete" as const,
      source_units_total: mechanicalReport.metrics.length,
      candidates_generated:
        mechanicalReport.findings.length
        + mechanicalReport.summary.suppressed
        + mechanicalSignals.length,
      candidates_assessed:
        mechanicalReport.findings.length
        + mechanicalReport.summary.suppressed
        + mechanicalSignals.length,
      candidates_skipped: 0,
      reason_codes: mechanicalFailed ? ["scan_incomplete" as const] : [],
    },
    !narrativeRequested
      ? notRequestedCoverage("narrative")
      : narrativeFailed
      ? {
          dimension: "narrative" as const,
          state: "failed" as const,
          source_units_total: 0,
          candidates_generated: 0,
          candidates_assessed: 0,
          candidates_skipped: 0,
          reason_codes: ["scan_incomplete" as const],
        }
      : {
          dimension: "narrative" as const,
          state: "partial" as const,
          source_units_total: instruction.status === "available" ? 1 : 0,
          candidates_generated: narrativeSignals.length,
          candidates_assessed: narrativeSignals.length,
          candidates_skipped: 0,
          reason_codes: ["bounded_candidate_generator" as const],
        },
    notRequestedCoverage("contradiction"),
    notRequestedCoverage("drift"),
    notRequestedCoverage("memory_overlap"),
    notRequestedCoverage("cross_repository"),
  ];

  return KnowledgeHygieneReportV2.parse({
    ...mechanicalReport,
    schema_version: "2",
    summary: {
      error: active.filter((finding) => finding.severity === "error").length,
      warning: active.filter((finding) => finding.severity === "warning").length,
      info: active.filter((finding) => finding.severity === "info").length,
      suppressed: mechanicalReport.summary.suppressed + suppressedV2,
    },
    findings: active,
    coverage,
    health_claim: expectedHealthClaim(
      active,
      mechanicalFailed || narrativeFailed,
    ),
    rejection_counts: {},
  });
}
