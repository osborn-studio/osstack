import {
  applyKnowledgeHygieneReviewArtifact,
  applyKnowledgeHygieneReviewArtifactV2,
  checkKnowledgeHygiene,
  checkKnowledgeHygieneV2,
  KnowledgeHygieneCheckInputV1,
  KnowledgeHygieneCheckInputV2,
  KnowledgeHygieneConfigError,
  KnowledgeHygieneGitError,
  KnowledgeHygieneRuleIdV1,
  KnowledgeHygieneRuleIdV2,
  KnowledgeHygienePatchConflictError,
  KnowledgeHygieneReviewError,
  KnowledgeHygieneReviewV2Error,
  type KnowledgeHygieneEnginePortsV1,
  type KnowledgeHygieneReportV1,
  type KnowledgeHygieneReportV2,
  type KnowledgeHygieneEvidenceRefV2,
} from "@osstack/governance";
import {
  AgentCommandResult,
  PROTOCOL_VERSION as AGENT_COMMAND_PROTOCOL_VERSION,
  type ErrorCode,
} from "@osstack/protocol";
import { isAbsolute, join, resolve } from "node:path";
import {
  handleNeatReviewCommand,
  loadNeatReviewArtifact,
  NeatReviewInputError,
} from "./neat-review-command.js";
import {
  handleNeatFixCommand,
  NeatFixInputError,
  type NeatFixCommandOverrides,
} from "./neat-fix-command.js";
import { osstackHome } from "./paths.js";
import {
  recordNeatReport,
  type NeatRecordingResultV1,
} from "./neat-record.js";
import { handleNeatTrendCommand } from "./neat-trend-command.js";
import { handleNeatProposalCommand } from "./neat-proposal-command.js";
import {
  handleNeatSemanticCommand,
  type NeatSemanticCommandOverrides,
} from "./neat-semantic-command.js";
import {
  handleNeatTransactionCommand,
  type NeatTransactionCommandDependencies,
} from "./neat-transaction-command.js";
import {
  handleNeatDependencyCommand,
  type NeatDependencyCommandDependencies,
} from "./neat-dependency-command.js";

export type NeatFailOn = "error" | "warning" | "none";
type NeatFormat = "human" | "json";

export interface NeatCommandDependencies {
  cwd: () => string;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  check?: typeof checkKnowledgeHygiene;
  check_v2?: typeof checkKnowledgeHygieneV2;
  engine_ports?: KnowledgeHygieneEnginePortsV1;
  now?: () => Date;
  fix?: NeatFixCommandOverrides;
  semantic?: NeatSemanticCommandOverrides;
  transaction?: Partial<NeatTransactionCommandDependencies>;
  dependency?: Partial<NeatDependencyCommandDependencies>;
  authorize_write?: (workspacePath: string) => Promise<{
    allow: boolean;
    reason?: string;
  }>;
}

interface ParsedNeatCommand {
  help: boolean;
  format: NeatFormat;
  fail_on: NeatFailOn;
  schema_version: "1" | "2";
  input: KnowledgeHygieneCheckInputV1 | KnowledgeHygieneCheckInputV2;
  review_file?: string;
  record: boolean;
  db_path?: string;
}

class NeatUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeatUsageError";
  }
}

export function renderNeatHelp(): string {
  return `osstack neat — deterministic repository knowledge hygiene

Usage:
  osstack neat [options]
  osstack neat check [options]
  osstack neat review [review options]
  osstack neat fix [fix options]
  osstack neat semantic [semantic options]
  osstack neat memory <plan|approve|apply|recover> [options]
  osstack neat narrative <plan|approve|apply|recover> [options]
  osstack neat dependencies <scan|inbox|confirm|revoke|recover> [options]
  osstack neat trend [trend options]
  osstack neat propose [proposal options]

Options:
  --repo <path>                  Repository root (default: cwd)
  --all                          Audit all recognized knowledge surfaces
  --base <git-ref>               Base ref for range/base-to-worktree mode
  --head <git-ref>               Head ref; valid only with --base
  --config <path>                Config path (default: .osstack/neat.yaml)
  --schema-version <1|2>         Report contract (default: 2; V1 deprecated)
  --checks <id,...>              Run only listed rule ids
  --skip-checks <id,...>         Exclude listed rule ids
  --review-file <path>           Apply matching portable review evidence
  --adapter <claude-code>        Explicitly enable one read-only memory adapter
  --claude-memory-dir <path>     Exact Claude memory dir (absolute or ~/)
  --record                       Persist normalized history explicitly
  --db <path>                    State DB override; requires --record for check
  --format <human|json>          Output format (default: human)
  --json                         Alias for --format json
  --fail-on <error|warning|none> Exit threshold (default: none)
  --help                         Show this help

Trend options:
  --repo-id <id>                 Persisted repository id (default: cwd basename)

Proposal options:
  --min-occurrences <n>          Per-finding threshold (default: 3)
  --min-repositories <n>         Same-rule repository threshold (default: 2)
  --yes                          Persist high-risk drafts; preview otherwise

Exit codes:
  0  Check completed and threshold was not met
  1  Check completed and findings met the threshold
  2  Invalid arguments or invalid config
  3  Runtime/environment failure prevented a complete check`;
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new NeatUsageError(`${flag} requires a value`);
  }
  return value;
}

function parseRuleIds(value: string, flag: string): string[] {
  const rawIds = value.split(",").map((id) => id.trim());
  if (rawIds.length === 0 || rawIds.some((id) => id.length === 0)) {
    throw new NeatUsageError(`${flag} requires a comma-separated rule list`);
  }
  if (new Set(rawIds).size !== rawIds.length) {
    throw new NeatUsageError(`${flag} contains duplicate rule ids`);
  }
  return rawIds;
}

function validateRuleIds(
  ids: readonly string[] | undefined,
  schemaVersion: "1" | "2",
): KnowledgeHygieneRuleIdV1[] | KnowledgeHygieneRuleIdV2[] | undefined {
  if (ids === undefined) return undefined;
  const schema = schemaVersion === "1"
    ? KnowledgeHygieneRuleIdV1
    : KnowledgeHygieneRuleIdV2;
  return ids.map((id) => {
    const parsed = schema.safeParse(id);
    if (!parsed.success) throw new NeatUsageError(`unknown rule id: ${id}`);
    return parsed.data;
  });
}

function parseNeatCommand(
  rawArgs: readonly string[],
  cwd: string,
): ParsedNeatCommand {
  const args = rawArgs[0] === "check" ? rawArgs.slice(1) : [...rawArgs];
  if (args[0] && !args[0].startsWith("-")) {
    throw new NeatUsageError(`unknown subcommand: ${args[0]}`);
  }
  if (args.includes("--help") || args.includes("-h")) {
    return {
      help: true,
      format: "human",
      fail_on: "none",
      schema_version: "2",
      input: { schema_version: "2", repo_root: cwd, mode: "worktree" },
      record: false,
    };
  }

  let repoRoot = cwd;
  let all = false;
  let baseRef: string | undefined;
  let headRef: string | undefined;
  let configPath: string | undefined;
  let rawChecks: string[] | undefined;
  let rawSkipChecks: string[] | undefined;
  let schemaVersion: "1" | "2" = "2";
  let reviewFile: string | undefined;
  let adapter: "claude-code" | undefined;
  let claudeMemoryDir: string | undefined;
  let record = false;
  let dbPath: string | undefined;
  let format: NeatFormat = "human";
  let formatFlag: NeatFormat | undefined;
  let jsonAlias = false;
  let failOn: NeatFailOn = "none";
  const seen = new Set<string>();

  const markSeen = (flag: string): void => {
    if (seen.has(flag)) throw new NeatUsageError(`duplicate flag: ${flag}`);
    seen.add(flag);
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) continue;
    if (flag === "--repo") {
      markSeen(flag);
      repoRoot = resolve(cwd, requireValue(args, index, flag));
      index += 1;
    } else if (flag === "--all") {
      markSeen(flag);
      all = true;
    } else if (flag === "--base") {
      markSeen(flag);
      baseRef = requireValue(args, index, flag);
      index += 1;
    } else if (flag === "--head") {
      markSeen(flag);
      headRef = requireValue(args, index, flag);
      index += 1;
    } else if (flag === "--config") {
      markSeen(flag);
      configPath = requireValue(args, index, flag);
      index += 1;
    } else if (flag === "--schema-version") {
      markSeen(flag);
      const value = requireValue(args, index, flag);
      if (value !== "1" && value !== "2") {
        throw new NeatUsageError(`unsupported schema version: ${value}`);
      }
      schemaVersion = value;
      index += 1;
    } else if (flag === "--checks") {
      markSeen(flag);
      rawChecks = parseRuleIds(requireValue(args, index, flag), flag);
      index += 1;
    } else if (flag === "--skip-checks") {
      markSeen(flag);
      rawSkipChecks = parseRuleIds(requireValue(args, index, flag), flag);
      index += 1;
    } else if (flag === "--review-file") {
      markSeen(flag);
      reviewFile = resolve(cwd, requireValue(args, index, flag));
      index += 1;
    } else if (flag === "--adapter") {
      markSeen(flag);
      const value = requireValue(args, index, flag);
      if (value !== "claude-code") {
        throw new NeatUsageError(`unsupported adapter: ${value}`);
      }
      adapter = value;
      index += 1;
    } else if (flag === "--claude-memory-dir") {
      markSeen(flag);
      claudeMemoryDir = requireValue(args, index, flag);
      index += 1;
    } else if (flag === "--record") {
      markSeen(flag);
      record = true;
    } else if (flag === "--db") {
      markSeen(flag);
      dbPath = resolve(cwd, requireValue(args, index, flag));
      index += 1;
    } else if (flag === "--format") {
      markSeen(flag);
      const value = requireValue(args, index, flag);
      if (value !== "human" && value !== "json") {
        throw new NeatUsageError(`unsupported format: ${value}`);
      }
      formatFlag = value;
      format = value;
      index += 1;
    } else if (flag === "--json") {
      markSeen(flag);
      jsonAlias = true;
      format = "json";
    } else if (flag === "--fail-on") {
      markSeen(flag);
      const value = requireValue(args, index, flag);
      if (value !== "error" && value !== "warning" && value !== "none") {
        throw new NeatUsageError(`unsupported fail threshold: ${value}`);
      }
      failOn = value;
      index += 1;
    } else {
      throw new NeatUsageError(`unknown option: ${flag}`);
    }
  }

  if (jsonAlias && formatFlag === "human") {
    throw new NeatUsageError("--json conflicts with --format human");
  }
  if (all && (baseRef !== undefined || headRef !== undefined)) {
    throw new NeatUsageError("--all cannot be combined with --base or --head");
  }
  if (headRef !== undefined && baseRef === undefined) {
    throw new NeatUsageError("--head requires --base");
  }
  if (rawChecks && rawSkipChecks) {
    throw new NeatUsageError("--checks and --skip-checks are mutually exclusive");
  }
  if (dbPath !== undefined && !record) {
    throw new NeatUsageError("--db requires --record");
  }
  if (claudeMemoryDir !== undefined && adapter !== "claude-code") {
    throw new NeatUsageError(
      "--claude-memory-dir requires --adapter claude-code",
    );
  }
  if (
    claudeMemoryDir !== undefined
    && !isAbsolute(claudeMemoryDir)
    && !claudeMemoryDir.startsWith("~/")
  ) {
    throw new NeatUsageError(
      "--claude-memory-dir must be absolute or start with ~/",
    );
  }

  const mode = all
    ? "all"
    : baseRef === undefined
      ? "worktree"
      : headRef === undefined
        ? "base_to_worktree"
        : "range";
  const checks = validateRuleIds(rawChecks, schemaVersion);
  const skipChecks = validateRuleIds(rawSkipChecks, schemaVersion);
  const rawInput = {
    repo_root: repoRoot,
    mode,
    ...(baseRef === undefined ? {} : { base_ref: baseRef }),
    ...(headRef === undefined ? {} : { head_ref: headRef }),
    ...(configPath === undefined ? {} : { config_path: configPath }),
    ...(checks === undefined ? {} : { checks }),
    ...(skipChecks === undefined ? {} : { skip_checks: skipChecks }),
    ...(adapter === undefined
      ? {}
      : {
          adapters: [{
            id: adapter,
            ...(claudeMemoryDir === undefined
              ? {}
              : { memory_dir: claudeMemoryDir }),
          }],
        }),
  };
  const parsed = schemaVersion === "1"
    ? KnowledgeHygieneCheckInputV1.safeParse(rawInput)
    : KnowledgeHygieneCheckInputV2.safeParse({
        ...rawInput,
        schema_version: "2",
      });
  if (!parsed.success) {
    throw new NeatUsageError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return {
    help: false,
    format,
    fail_on: failOn,
    schema_version: schemaVersion,
    input: parsed.data,
    record,
    ...(reviewFile === undefined ? {} : { review_file: reviewFile }),
    ...(dbPath === undefined ? {} : { db_path: dbPath }),
  };
}

function exitCodeForReport(
  report: KnowledgeHygieneReportV1 | KnowledgeHygieneReportV2,
  failOn: NeatFailOn,
): 0 | 1 {
  if (failOn === "none") return 0;
  if (failOn === "error") return report.summary.error > 0 ? 1 : 0;
  return report.summary.error + report.summary.warning > 0 ? 1 : 0;
}

function evidenceLine(
  evidence: KnowledgeHygieneEvidenceRefV2,
): string {
  const details = [evidence.kind, evidence.ref];
  if (evidence.sha256) details.push(`sha256=${evidence.sha256}`);
  if (evidence.run_id) details.push(`run_id=${evidence.run_id}`);
  return details.join(" ");
}

export function renderKnowledgeHygieneReport(
  report: KnowledgeHygieneReportV1 | KnowledgeHygieneReportV2,
  failOn: NeatFailOn,
): string {
  if (report.schema_version === "2") {
    return renderKnowledgeHygieneReportV2(report, failOn);
  }
  const lines = [
    `Knowledge hygiene: ${report.summary.error} error, ${report.summary.warning} warning, ${report.summary.info} info`,
    ...(report.adapters === undefined
      ? []
      : [`Adapters: ${report.adapters.map((adapter) =>
        `${adapter.id}@${adapter.version} ${adapter.status} (${adapter.source})`).join(", ")}`]),
    "",
  ];
  if (report.findings.length === 0) {
    lines.push(
      "No findings in the mechanical V1 rule set; semantic dimensions were not assessed.",
      "",
    );
  }
  for (const finding of report.findings) {
    const lineSuffix = finding.location.line === undefined
      ? ""
      : `:${finding.location.line}`;
    lines.push(
      `${finding.severity.toUpperCase()} ${finding.rule_id}  ${finding.location.path}${lineSuffix}`,
      `  Rationale: ${finding.rationale}`,
      `  Observed: ${JSON.stringify(finding.observed)}`,
      `  Expected: ${JSON.stringify(finding.expected)}`,
    );
    if (finding.evidence_refs.length === 0) {
      lines.push("  Evidence: none");
    } else {
      finding.evidence_refs.forEach((evidence, index) => {
        lines.push(`  ${index === 0 ? "Evidence" : "Evidence"}: ${evidenceLine(evidence)}`);
      });
    }
    lines.push(
      `  Resolve: ${finding.remediation.mode}${finding.remediation.action_id ? ` (${finding.remediation.action_id})` : ""}`,
      `  Fingerprint: ${finding.fingerprint}`,
      "",
    );
  }

  if (report.completeness.complete) {
    lines.push("Completeness: complete");
  } else {
    lines.push(
      `Completeness: incomplete (${report.completeness.skipped_files} skipped)`,
    );
    for (const reason of report.completeness.reasons) lines.push(`  - ${reason}`);
  }
  lines.push(
    "Semantic coverage: not assessed (V1 mechanical rule set only)",
    `Suppressed: ${report.summary.suppressed}`,
    ...(report.summary.resolved === undefined
      ? []
      : [`Resolved: ${report.summary.resolved}`]),
    `Exit policy: --fail-on ${failOn} (exit ${exitCodeForReport(report, failOn)})`,
  );
  return lines.join("\n");
}

function v2Location(finding: KnowledgeHygieneReportV2["findings"][number]): string {
  if (finding.location.kind === "repository_scope") return `repo:${finding.location.repo_id}`;
  if (finding.location.kind === "repository") return finding.location.path;
  if (finding.location.kind === "adapter") return finding.location.uri;
  return `registry:${finding.location.registry_scope}`;
}

export function renderKnowledgeHygieneReportV2(
  report: KnowledgeHygieneReportV2,
  failOn: NeatFailOn,
): string {
  const lines = [
    `Knowledge hygiene V2: ${report.summary.error} error, ${report.summary.warning} warning, ${report.summary.info} info`,
    ...(report.adapters === undefined
      ? []
      : [`Adapters: ${report.adapters.map((adapter) =>
        `${adapter.id}@${adapter.version} ${adapter.status} (${adapter.source})`).join(", ")}`]),
    "",
  ];
  if (report.findings.length === 0) {
    lines.push("No findings in the assessed scope shown below.", "");
  }
  for (const finding of report.findings) {
    const lineSuffix = "line" in finding.location
        && finding.location.line !== undefined
      ? `:${finding.location.line}`
      : "";
    lines.push(
      `${finding.severity.toUpperCase()} ${finding.rule_id}  ${v2Location(finding)}${lineSuffix}`,
      `  Origin: ${finding.origin}; dimension: ${finding.dimension}`,
      `  Rationale: ${finding.rationale}`,
      `  Observed: ${JSON.stringify(finding.observed)}`,
      `  Expected: ${JSON.stringify(finding.expected)}`,
    );
    if (finding.evidence_refs.length === 0) {
      lines.push("  Evidence: citations only");
    } else {
      finding.evidence_refs.forEach((evidence) => {
        lines.push(`  Evidence: ${evidenceLine(evidence)}`);
      });
    }
    lines.push(
      `  Citations: ${finding.citations.length}`,
      `  Closure: ${finding.closure_policy}`,
      `  Fingerprint: ${finding.fingerprint}`,
      "",
    );
  }
  lines.push(
    report.completeness.complete
      ? "Inventory completeness: complete"
      : `Inventory completeness: incomplete (${report.completeness.skipped_files} skipped)`,
    `Selected rules: ${report.assessment_scope.selected_rule_ids.length === 0 ? "none" : report.assessment_scope.selected_rule_ids.join(",")}`,
    "Coverage:",
  );
  for (const coverage of report.coverage) {
    const reasons = coverage.reason_codes.length === 0
      ? ""
      : `; reasons=${coverage.reason_codes.join(",")}`;
    lines.push(
      `  - ${coverage.dimension}: ${coverage.state} (${coverage.candidates_assessed}/${coverage.candidates_generated} assessed${reasons})`,
    );
  }
  lines.push(
    `Health claim: ${report.health_claim} (limited to the coverage above)`,
    `Suppressed: ${report.summary.suppressed}`,
    ...(report.summary.resolved === undefined
      ? []
      : [`Resolved: ${report.summary.resolved}`]),
    `Exit policy: --fail-on ${failOn} (exit ${exitCodeForReport(report, failOn)})`,
  );
  return lines.join("\n");
}

function uniqueEvidence(
  report: KnowledgeHygieneReportV1 | KnowledgeHygieneReportV2,
) {
  const evidence = new Map<string, KnowledgeHygieneEvidenceRefV2>();
  for (const finding of report.findings) {
    for (const ref of finding.evidence_refs) {
      evidence.set(JSON.stringify(ref), ref);
    }
  }
  return [...evidence.values()];
}

function successEnvelope(
  report: KnowledgeHygieneReportV1 | KnowledgeHygieneReportV2,
  recording?: NeatRecordingResultV1,
) {
  const evidence = uniqueEvidence(report);
  return AgentCommandResult.parse({
    protocol_version: AGENT_COMMAND_PROTOCOL_VERSION,
    status: "ok",
    result: {
      command: "knowledge_hygiene.check",
      report,
      ...(recording === undefined ? {} : { recording }),
    },
    ...(evidence.length === 0 ? {} : { evidence_refs: evidence }),
  });
}

function errorEnvelope(code: ErrorCode, message: string, retryable: boolean) {
  return AgentCommandResult.parse({
    protocol_version: AGENT_COMMAND_PROTOCOL_VERSION,
    status: "error",
    error: { code, message, retryable },
  });
}

function wantsJson(args: readonly string[]): boolean {
  if (args.includes("--json")) return true;
  const index = args.indexOf("--format");
  return index >= 0 && args[index + 1] === "json";
}

function emitError(
  deps: NeatCommandDependencies,
  json: boolean,
  code: ErrorCode,
  message: string,
  retryable: boolean,
): void {
  if (json) {
    deps.stdout(JSON.stringify(errorEnvelope(code, message, retryable), null, 2));
  } else {
    deps.stderr(`osstack neat: ${message}`);
  }
}

export async function handleNeatCommand(
  args: readonly string[],
  deps: NeatCommandDependencies,
): Promise<number> {
  if (args[0] === "dependencies") {
    return handleNeatDependencyCommand(args.slice(1), {
      cwd: deps.cwd,
      stdout: deps.stdout,
      stderr: deps.stderr,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...deps.dependency,
    });
  }
  if (args[0] === "memory" || args[0] === "narrative") {
    return handleNeatTransactionCommand(args[0], args.slice(1), {
      cwd: deps.cwd,
      stdout: deps.stdout,
      stderr: deps.stderr,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...deps.transaction,
    });
  }
  if (args[0] === "semantic") {
    return handleNeatSemanticCommand(args.slice(1), {
      cwd: deps.cwd,
      stdout: deps.stdout,
      stderr: deps.stderr,
      render_report: renderKnowledgeHygieneReportV2,
      ...(deps.engine_ports === undefined ? {} : { engine_ports: deps.engine_ports }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...deps.semantic,
    });
  }
  if (args[0] === "propose") {
    return handleNeatProposalCommand(args.slice(1), {
      cwd: deps.cwd,
      stdout: deps.stdout,
      stderr: deps.stderr,
      now: deps.now ?? deps.engine_ports?.now ?? (() => new Date()),
      ...(deps.authorize_write === undefined
        ? {}
        : { authorize_write: deps.authorize_write }),
    });
  }
  if (args[0] === "trend") {
    return handleNeatTrendCommand(args.slice(1), {
      cwd: deps.cwd,
      stdout: deps.stdout,
      stderr: deps.stderr,
      now: deps.now ?? deps.engine_ports?.now ?? (() => new Date()),
    });
  }
  if (args[0] === "fix") {
    try {
      return await handleNeatFixCommand(args.slice(1), {
        cwd: deps.cwd,
        stdout: deps.stdout,
        now: deps.now ?? deps.engine_ports?.now ?? (() => new Date()),
        ...deps.fix,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof NeatFixInputError) {
        emitError(deps, wantsJson(args), "bad_request", message, false);
        return 2;
      }
      if (error instanceof KnowledgeHygienePatchConflictError) {
        emitError(deps, wantsJson(args), "conflict", message, true);
        return 3;
      }
      emitError(deps, wantsJson(args), "internal", message, true);
      return 3;
    }
  }
  if (args[0] === "review") {
    try {
      return await handleNeatReviewCommand(args.slice(1), {
        cwd: deps.cwd,
        stdout: deps.stdout,
        now: deps.now ?? deps.engine_ports?.now ?? (() => new Date()),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof NeatReviewInputError) {
        emitError(deps, false, "bad_request", message, false);
        return 2;
      }
      emitError(deps, false, "internal", message, true);
      return 3;
    }
  }
  const jsonRequested = wantsJson(args);
  let parsed: ParsedNeatCommand;
  try {
    parsed = parseNeatCommand(args, deps.cwd());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitError(deps, jsonRequested, "bad_request", message, false);
    return 2;
  }
  if (parsed.help) {
    deps.stdout(renderNeatHelp());
    return 0;
  }
  if (parsed.schema_version === "1") {
    deps.stderr(
      "osstack neat: --schema-version 1 is deprecated and will be removed in the next minor release; migrate consumers to V2",
    );
  }

  let report: KnowledgeHygieneReportV1 | KnowledgeHygieneReportV2;
  try {
    report = parsed.schema_version === "1"
      ? await (deps.check ?? checkKnowledgeHygiene)(
          parsed.input as KnowledgeHygieneCheckInputV1,
          deps.engine_ports,
        )
      : await (deps.check_v2 ?? checkKnowledgeHygieneV2)(
          parsed.input as KnowledgeHygieneCheckInputV2,
          deps.engine_ports === undefined ? {} : { v1: deps.engine_ports },
        );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof KnowledgeHygieneConfigError) {
      const details = error.details.length === 0
        ? message
        : `${message}: ${error.details.join("; ")}`;
      emitError(deps, parsed.format === "json", "bad_request", details, false);
      return 2;
    }
    if (error instanceof KnowledgeHygieneGitError) {
      const inputError = error.code === "invalid_input";
      emitError(
        deps,
        parsed.format === "json",
        inputError ? "bad_request" : "conflict",
        message,
        !inputError,
      );
      return inputError ? 2 : 3;
    }
    emitError(deps, parsed.format === "json", "internal", message, true);
    return 3;
  }

  if (parsed.review_file !== undefined) {
    try {
      const artifact = await loadNeatReviewArtifact(parsed.review_file);
      if (report.schema_version === "2") {
        if (artifact.schema_version !== "2") {
          throw new NeatReviewInputError(
            "V2 reports require a V2 lifecycle review artifact",
          );
        }
        report = applyKnowledgeHygieneReviewArtifactV2(report, artifact);
      } else {
        if (artifact.schema_version !== "1") {
          throw new NeatReviewInputError("V1 reports require a V1 review artifact");
        }
        report = applyKnowledgeHygieneReviewArtifact(report, artifact);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        error instanceof NeatReviewInputError ||
        error instanceof KnowledgeHygieneReviewError ||
        error instanceof KnowledgeHygieneReviewV2Error
      ) {
        emitError(deps, parsed.format === "json", "bad_request", message, false);
        return 2;
      }
      emitError(deps, parsed.format === "json", "internal", message, true);
      return 3;
    }
  }

  let recording: NeatRecordingResultV1 | undefined;
  if (parsed.record) {
    try {
      recording = await recordNeatReport(
        report,
        parsed.db_path ?? join(osstackHome(), "state.db"),
        (deps.now ?? deps.engine_ports?.now ?? (() => new Date()))().getTime(),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitError(deps, parsed.format === "json", "internal", message, true);
      return 3;
    }
  }

  if (parsed.format === "json") {
    deps.stdout(JSON.stringify(successEnvelope(report, recording), null, 2));
  } else {
    const rendered = renderKnowledgeHygieneReport(report, parsed.fail_on);
    deps.stdout(recording === undefined
      ? rendered
      : `${rendered}\nRecorded: ${recording.run_id} (${recording.inserted ? "inserted" : "existing"}) at ${recording.db_path}`);
  }
  return exitCodeForReport(report, parsed.fail_on);
}
