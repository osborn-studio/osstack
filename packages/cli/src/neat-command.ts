import {
  applyKnowledgeHygieneReviewArtifact,
  checkKnowledgeHygiene,
  KnowledgeHygieneCheckInputV1,
  KnowledgeHygieneConfigError,
  KnowledgeHygieneGitError,
  KnowledgeHygieneRuleIdV1,
  KnowledgeHygienePatchConflictError,
  KnowledgeHygieneReviewError,
  type KnowledgeHygieneEnginePortsV1,
  type KnowledgeHygieneReportV1,
} from "@osstack/governance";
import {
  AgentCommandResult,
  PROTOCOL_VERSION as AGENT_COMMAND_PROTOCOL_VERSION,
  type ErrorCode,
} from "@osstack/protocol";
import { resolve } from "node:path";
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

export type NeatFailOn = "error" | "warning" | "none";
type NeatFormat = "human" | "json";

export interface NeatCommandDependencies {
  cwd: () => string;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  check?: typeof checkKnowledgeHygiene;
  engine_ports?: KnowledgeHygieneEnginePortsV1;
  now?: () => Date;
  fix?: NeatFixCommandOverrides;
}

interface ParsedNeatCommand {
  help: boolean;
  format: NeatFormat;
  fail_on: NeatFailOn;
  input: KnowledgeHygieneCheckInputV1;
  review_file?: string;
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

Options:
  --repo <path>                  Repository root (default: cwd)
  --all                          Audit all recognized knowledge surfaces
  --base <git-ref>               Base ref for range/base-to-worktree mode
  --head <git-ref>               Head ref; valid only with --base
  --config <path>                Config path (default: .osstack/neat.yaml)
  --checks <id,...>              Run only listed rule ids
  --skip-checks <id,...>         Exclude listed rule ids
  --review-file <path>           Apply matching portable review evidence
  --format <human|json>          Output format (default: human)
  --json                         Alias for --format json
  --fail-on <error|warning|none> Exit threshold (default: none)
  --help                         Show this help

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

function parseRuleIds(value: string, flag: string): KnowledgeHygieneRuleIdV1[] {
  const rawIds = value.split(",").map((id) => id.trim());
  if (rawIds.length === 0 || rawIds.some((id) => id.length === 0)) {
    throw new NeatUsageError(`${flag} requires a comma-separated rule list`);
  }
  if (new Set(rawIds).size !== rawIds.length) {
    throw new NeatUsageError(`${flag} contains duplicate rule ids`);
  }
  return rawIds.map((id) => {
    const parsed = KnowledgeHygieneRuleIdV1.safeParse(id);
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
      input: { repo_root: cwd, mode: "worktree" },
    };
  }

  let repoRoot = cwd;
  let all = false;
  let baseRef: string | undefined;
  let headRef: string | undefined;
  let configPath: string | undefined;
  let checks: KnowledgeHygieneRuleIdV1[] | undefined;
  let skipChecks: KnowledgeHygieneRuleIdV1[] | undefined;
  let reviewFile: string | undefined;
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
    } else if (flag === "--checks") {
      markSeen(flag);
      checks = parseRuleIds(requireValue(args, index, flag), flag);
      index += 1;
    } else if (flag === "--skip-checks") {
      markSeen(flag);
      skipChecks = parseRuleIds(requireValue(args, index, flag), flag);
      index += 1;
    } else if (flag === "--review-file") {
      markSeen(flag);
      reviewFile = resolve(cwd, requireValue(args, index, flag));
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
  if (checks && skipChecks) {
    throw new NeatUsageError("--checks and --skip-checks are mutually exclusive");
  }

  const mode = all
    ? "all"
    : baseRef === undefined
      ? "worktree"
      : headRef === undefined
        ? "base_to_worktree"
        : "range";
  const parsed = KnowledgeHygieneCheckInputV1.safeParse({
    repo_root: repoRoot,
    mode,
    ...(baseRef === undefined ? {} : { base_ref: baseRef }),
    ...(headRef === undefined ? {} : { head_ref: headRef }),
    ...(configPath === undefined ? {} : { config_path: configPath }),
    ...(checks === undefined ? {} : { checks }),
    ...(skipChecks === undefined ? {} : { skip_checks: skipChecks }),
  });
  if (!parsed.success) {
    throw new NeatUsageError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  return {
    help: false,
    format,
    fail_on: failOn,
    input: parsed.data,
    ...(reviewFile === undefined ? {} : { review_file: reviewFile }),
  };
}

function exitCodeForReport(
  report: KnowledgeHygieneReportV1,
  failOn: NeatFailOn,
): 0 | 1 {
  if (failOn === "none") return 0;
  if (failOn === "error") return report.summary.error > 0 ? 1 : 0;
  return report.summary.error + report.summary.warning > 0 ? 1 : 0;
}

function evidenceLine(
  evidence: KnowledgeHygieneReportV1["findings"][number]["evidence_refs"][number],
): string {
  const details = [evidence.kind, evidence.ref];
  if (evidence.sha256) details.push(`sha256=${evidence.sha256}`);
  if (evidence.run_id) details.push(`run_id=${evidence.run_id}`);
  return details.join(" ");
}

export function renderKnowledgeHygieneReport(
  report: KnowledgeHygieneReportV1,
  failOn: NeatFailOn,
): string {
  const lines = [
    `Knowledge hygiene: ${report.summary.error} error, ${report.summary.warning} warning, ${report.summary.info} info`,
    "",
  ];
  if (report.findings.length === 0) {
    lines.push("No active findings.", "");
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
    `Suppressed: ${report.summary.suppressed}`,
    ...(report.summary.resolved === undefined
      ? []
      : [`Resolved: ${report.summary.resolved}`]),
    `Exit policy: --fail-on ${failOn} (exit ${exitCodeForReport(report, failOn)})`,
  );
  return lines.join("\n");
}

function uniqueEvidence(report: KnowledgeHygieneReportV1) {
  const evidence = new Map<string, KnowledgeHygieneReportV1["findings"][number]["evidence_refs"][number]>();
  for (const finding of report.findings) {
    for (const ref of finding.evidence_refs) {
      evidence.set(JSON.stringify(ref), ref);
    }
  }
  return [...evidence.values()];
}

function successEnvelope(report: KnowledgeHygieneReportV1) {
  const evidence = uniqueEvidence(report);
  return AgentCommandResult.parse({
    protocol_version: AGENT_COMMAND_PROTOCOL_VERSION,
    status: "ok",
    result: { command: "knowledge_hygiene.check", report },
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

  let report: KnowledgeHygieneReportV1;
  try {
    report = await (deps.check ?? checkKnowledgeHygiene)(
      parsed.input,
      deps.engine_ports,
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
      report = applyKnowledgeHygieneReviewArtifact(report, artifact);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        error instanceof NeatReviewInputError ||
        error instanceof KnowledgeHygieneReviewError
      ) {
        emitError(deps, parsed.format === "json", "bad_request", message, false);
        return 2;
      }
      emitError(deps, parsed.format === "json", "internal", message, true);
      return 3;
    }
  }

  if (parsed.format === "json") {
    deps.stdout(JSON.stringify(successEnvelope(report), null, 2));
  } else {
    deps.stdout(renderKnowledgeHygieneReport(report, parsed.fail_on));
  }
  return exitCodeForReport(report, parsed.fail_on);
}
