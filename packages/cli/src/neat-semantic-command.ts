import { createBuiltInSemanticJudge } from "@osstack/agents";
import {
  auditKnowledgeHygieneSemantics,
  KnowledgeHygieneConfigError,
  loadKnowledgeHygieneConfigV2,
  SemanticAuditInputV1,
  type KnowledgeHygieneEnginePortsV1,
  type KnowledgeHygieneReportV2,
  type LoadedKnowledgeHygieneConfigV2,
  type SemanticAuditPortsV1,
  type SemanticJudgePort,
} from "@osstack/governance";
import {
  AgentCommandResult,
  PROTOCOL_VERSION as AGENT_COMMAND_PROTOCOL_VERSION,
} from "@osstack/protocol";
import { join, resolve } from "node:path";
import { osstackHome } from "./paths.js";
import {
  recordNeatReport,
  type NeatRecordingResultV1,
} from "./neat-record.js";
import {
  createFileSemanticDecisionCacheV1,
  createSemanticEvidenceObserverV1,
} from "./neat-semantic-artifacts.js";

type NeatSemanticFormat = "human" | "json";
type NeatSemanticFailOn = "error" | "warning" | "none";

export interface NeatSemanticCommandOverrides {
  audit?: typeof auditKnowledgeHygieneSemantics;
  judge_factory?: (judgeId: string) => SemanticJudgePort;
  load_config?: typeof loadKnowledgeHygieneConfigV2;
  decision_cache?: SemanticAuditPortsV1["decision_cache"];
  observe_evidence_pack?: SemanticAuditPortsV1["observe_evidence_pack"];
}

export interface NeatSemanticCommandDependencies
  extends NeatSemanticCommandOverrides {
  cwd: () => string;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  render_report: (
    report: KnowledgeHygieneReportV2,
    failOn: NeatSemanticFailOn,
  ) => string;
  engine_ports?: KnowledgeHygieneEnginePortsV1;
  now?: () => Date;
}

interface ParsedNeatSemanticCommand {
  help: boolean;
  repo_root: string;
  mode: "all" | "worktree" | "range" | "base_to_worktree";
  base_ref?: string;
  head_ref?: string;
  config_path?: string;
  dimensions: Array<"narrative" | "contradiction" | "drift" | "memory_overlap">;
  judge_id?: string;
  max_input_tokens: number;
  max_output_tokens: number;
  max_calls: number;
  allow_truncated: boolean;
  format: NeatSemanticFormat;
  record: boolean;
  db_path?: string;
  fail_on: NeatSemanticFailOn;
}

class NeatSemanticUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeatSemanticUsageError";
  }
}

export function renderNeatSemanticHelp(): string {
  return `osstack neat semantic — evidence-bound semantic knowledge hygiene

Usage:
  osstack neat semantic [options]

Options:
  --repo <path>                  Repository root (default: cwd)
  --all                          Audit the complete recognized scope
  --base <git-ref>               Base ref for a change-set audit
  --head <git-ref>               Head ref; valid only with --base
  --dimensions <d,...>          narrative|contradiction|drift|memory-overlap
  --judge <judge-id>             SemanticJudgePort id (default: config)
  --max-input-tokens <n>         Input budget, 1..250000 (default: 32000)
  --max-output-tokens <n>        Output budget, 1..32000 (default: 4000)
  --max-calls <n>                Provider call budget, 1..64 (default: 8)
  --allow-truncated              Accept budget-truncated requested coverage
  --config <path>                Config path (default: .osstack/neat.yaml)
  --schema-version 2             Semantic reports only support V2
  --record                       Persist normalized V2 history
  --db <path>                    State DB override; requires --record
  --format <human|json>          Output format (default: human)
  --json                         Alias for --format json
  --fail-on <error|warning|none> Finding threshold (default: none)
  --help                         Show this help

Built-in no-tools judges:
  anthropic-no-tools  ANTHROPIC_API_KEY + OSSTACK_NEAT_ANTHROPIC_MODEL
  deepseek-no-tools   DEEPSEEK_API_KEY + OSSTACK_NEAT_DEEPSEEK_MODEL
  qwen-no-tools       Beijing DASHSCOPE_API_KEY + OSSTACK_NEAT_QWEN_MODEL

Config semantic.enabled is the provider kill switch.

Exit codes:
  0  Requested coverage completed and threshold was not met
  1  Requested coverage completed and findings met the threshold
  2  Invalid arguments, config, schema, or judge configuration
  3  Failed, unassessed, or unapproved truncated requested coverage`;
}

function requireValue(
  args: readonly string[],
  index: number,
  flag: string,
): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new NeatSemanticUsageError(`${flag} requires a value`);
  }
  return value;
}

function integerInRange(
  value: string,
  flag: string,
  minimum: number,
  maximum: number,
): number {
  if (!/^\d+$/u.test(value)) {
    throw new NeatSemanticUsageError(`${flag} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new NeatSemanticUsageError(
      `${flag} must be between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

const cliDimension = new Map<string, ParsedNeatSemanticCommand["dimensions"][number]>([
  ["narrative", "narrative"],
  ["contradiction", "contradiction"],
  ["drift", "drift"],
  ["memory-overlap", "memory_overlap"],
]);

function parseDimensions(value: string): ParsedNeatSemanticCommand["dimensions"] {
  const values = value.split(",").map((dimension) => dimension.trim());
  if (values.length === 0 || values.some((dimension) => dimension.length === 0)) {
    throw new NeatSemanticUsageError("--dimensions requires a comma-separated list");
  }
  if (new Set(values).size !== values.length) {
    throw new NeatSemanticUsageError("--dimensions contains duplicate dimensions");
  }
  return values.map((value) => {
    const mapped = cliDimension.get(value);
    if (mapped === undefined) {
      throw new NeatSemanticUsageError(`unknown semantic dimension: ${value}`);
    }
    return mapped;
  });
}

function parseNeatSemanticCommand(
  args: readonly string[],
  cwd: string,
): ParsedNeatSemanticCommand {
  if (args.includes("--help") || args.includes("-h")) {
    return {
      help: true,
      repo_root: cwd,
      mode: "worktree",
      dimensions: ["narrative"],
      max_input_tokens: 32_000,
      max_output_tokens: 4_000,
      max_calls: 8,
      allow_truncated: false,
      format: "human",
      record: false,
      fail_on: "none",
    };
  }
  let repoRoot = cwd;
  let all = false;
  let baseRef: string | undefined;
  let headRef: string | undefined;
  let configPath: string | undefined;
  let dimensions: ParsedNeatSemanticCommand["dimensions"] = ["narrative"];
  let judgeId: string | undefined;
  let maxInputTokens = 32_000;
  let maxOutputTokens = 4_000;
  let maxCalls = 8;
  let allowTruncated = false;
  let format: NeatSemanticFormat = "human";
  let explicitFormat: NeatSemanticFormat | undefined;
  let json = false;
  let record = false;
  let dbPath: string | undefined;
  let failOn: NeatSemanticFailOn = "none";
  const seen = new Set<string>();

  const markSeen = (flag: string): void => {
    if (seen.has(flag)) throw new NeatSemanticUsageError(`duplicate flag: ${flag}`);
    seen.add(flag);
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) continue;
    markSeen(flag);
    if (flag === "--repo") {
      repoRoot = resolve(cwd, requireValue(args, index, flag));
      index += 1;
    } else if (flag === "--all") {
      all = true;
    } else if (flag === "--base") {
      baseRef = requireValue(args, index, flag);
      index += 1;
    } else if (flag === "--head") {
      headRef = requireValue(args, index, flag);
      index += 1;
    } else if (flag === "--dimensions") {
      dimensions = parseDimensions(requireValue(args, index, flag));
      index += 1;
    } else if (flag === "--judge") {
      judgeId = requireValue(args, index, flag);
      index += 1;
    } else if (flag === "--max-input-tokens") {
      maxInputTokens = integerInRange(
        requireValue(args, index, flag), flag, 1, 250_000,
      );
      index += 1;
    } else if (flag === "--max-output-tokens") {
      maxOutputTokens = integerInRange(
        requireValue(args, index, flag), flag, 1, 32_000,
      );
      index += 1;
    } else if (flag === "--max-calls") {
      maxCalls = integerInRange(requireValue(args, index, flag), flag, 1, 64);
      index += 1;
    } else if (flag === "--allow-truncated") {
      allowTruncated = true;
    } else if (flag === "--config") {
      configPath = requireValue(args, index, flag);
      index += 1;
    } else if (flag === "--schema-version") {
      const version = requireValue(args, index, flag);
      if (version !== "2") {
        throw new NeatSemanticUsageError("neat semantic only supports schema version 2");
      }
      index += 1;
    } else if (flag === "--record") {
      record = true;
    } else if (flag === "--db") {
      dbPath = resolve(cwd, requireValue(args, index, flag));
      index += 1;
    } else if (flag === "--format") {
      const value = requireValue(args, index, flag);
      if (value !== "human" && value !== "json") {
        throw new NeatSemanticUsageError(`unsupported format: ${value}`);
      }
      explicitFormat = value;
      format = value;
      index += 1;
    } else if (flag === "--json") {
      json = true;
      format = "json";
    } else if (flag === "--fail-on") {
      const value = requireValue(args, index, flag);
      if (value !== "none" && value !== "warning" && value !== "error") {
        throw new NeatSemanticUsageError(`unsupported fail threshold: ${value}`);
      }
      failOn = value;
      index += 1;
    } else {
      throw new NeatSemanticUsageError(`unknown option: ${flag}`);
    }
  }
  if (json && explicitFormat === "human") {
    throw new NeatSemanticUsageError("--json conflicts with --format human");
  }
  if (all && (baseRef !== undefined || headRef !== undefined)) {
    throw new NeatSemanticUsageError("--all cannot be combined with --base or --head");
  }
  if (headRef !== undefined && baseRef === undefined) {
    throw new NeatSemanticUsageError("--head requires --base");
  }
  if (dbPath !== undefined && !record) {
    throw new NeatSemanticUsageError("--db requires --record");
  }
  const mode = all
    ? "all"
    : baseRef === undefined
      ? "worktree"
      : headRef === undefined
        ? "base_to_worktree"
        : "range";
  return {
    help: false,
    repo_root: repoRoot,
    mode,
    dimensions,
    max_input_tokens: maxInputTokens,
    max_output_tokens: maxOutputTokens,
    max_calls: maxCalls,
    allow_truncated: allowTruncated,
    format,
    record,
    fail_on: failOn,
    ...(baseRef === undefined ? {} : { base_ref: baseRef }),
    ...(headRef === undefined ? {} : { head_ref: headRef }),
    ...(configPath === undefined ? {} : { config_path: configPath }),
    ...(judgeId === undefined ? {} : { judge_id: judgeId }),
    ...(dbPath === undefined ? {} : { db_path: dbPath }),
  };
}

function wantsJson(args: readonly string[]): boolean {
  if (args.includes("--json")) return true;
  const index = args.indexOf("--format");
  return index >= 0 && args[index + 1] === "json";
}

function emitError(
  deps: NeatSemanticCommandDependencies,
  json: boolean,
  message: string,
  runtime: boolean,
): void {
  if (json) {
    deps.stdout(JSON.stringify(AgentCommandResult.parse({
      protocol_version: AGENT_COMMAND_PROTOCOL_VERSION,
      status: "error",
      error: {
        code: runtime ? "internal" : "bad_request",
        message,
        retryable: runtime,
      },
    }), null, 2));
  } else {
    deps.stderr(`osstack neat semantic: ${message}`);
  }
}

function defaultJudgeFactory(judgeId: string): SemanticJudgePort {
  try {
    return createBuiltInSemanticJudge(judgeId);
  } catch (error) {
    throw new NeatSemanticUsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function findingExitCode(
  report: KnowledgeHygieneReportV2,
  failOn: NeatSemanticFailOn,
): 0 | 1 {
  if (failOn === "none") return 0;
  if (failOn === "error") return report.summary.error > 0 ? 1 : 0;
  return report.summary.error + report.summary.warning > 0 ? 1 : 0;
}

function coverageExitCode(
  report: KnowledgeHygieneReportV2,
  dimensions: readonly ParsedNeatSemanticCommand["dimensions"][number][],
  allowTruncated: boolean,
): 0 | 3 {
  for (const dimension of dimensions) {
    const coverage = report.coverage.find((entry) => entry.dimension === dimension);
    if (coverage === undefined || coverage.state === "failed" || coverage.state === "not_assessed") {
      return 3;
    }
    if (coverage.state === "truncated" && !allowTruncated) return 3;
  }
  return 0;
}

function uniqueEvidence(report: KnowledgeHygieneReportV2) {
  type ProtocolEvidence = {
    kind: "report" | "scorecard" | "proof" | "loop_state" | "external";
    ref: string;
    sha256?: string;
    run_id?: string;
  };
  const values = new Map<string, ProtocolEvidence>();
  for (const finding of report.findings) {
    for (const evidence of finding.evidence_refs) {
      const protocolEvidence: ProtocolEvidence = {
        kind: evidence.kind === "evidence_pack" || evidence.kind === "obligation"
          ? "external"
          : evidence.kind,
        ref: evidence.ref,
        ...(evidence.sha256 === undefined ? {} : { sha256: evidence.sha256 }),
        ...(evidence.run_id === undefined ? {} : { run_id: evidence.run_id }),
      };
      values.set(JSON.stringify(protocolEvidence), protocolEvidence);
    }
  }
  return [...values.values()];
}

function successEnvelope(
  report: KnowledgeHygieneReportV2,
  recording?: NeatRecordingResultV1,
) {
  const evidence = uniqueEvidence(report);
  return AgentCommandResult.parse({
    protocol_version: AGENT_COMMAND_PROTOCOL_VERSION,
    status: "ok",
    result: {
      command: "knowledge_hygiene.semantic",
      report,
      ...(recording === undefined ? {} : { recording }),
    },
    ...(evidence.length === 0 ? {} : { evidence_refs: evidence }),
  });
}

function semanticConfigError(
  loaded: LoadedKnowledgeHygieneConfigV2,
  parsed: ParsedNeatSemanticCommand,
): string | undefined {
  if (!loaded.config.semantic.enabled) {
    return "semantic.enabled must be true in ConfigV2 to run a live semantic audit";
  }
  if (parsed.judge_id === undefined && loaded.config.semantic.judge_id === undefined) {
    return "semantic judge is required via --judge or ConfigV2 semantic.judge_id";
  }
  return undefined;
}

export async function handleNeatSemanticCommand(
  args: readonly string[],
  deps: NeatSemanticCommandDependencies,
): Promise<number> {
  let parsed: ParsedNeatSemanticCommand;
  try {
    parsed = parseNeatSemanticCommand(args, deps.cwd());
  } catch (error) {
    emitError(
      deps,
      wantsJson(args),
      error instanceof Error ? error.message : String(error),
      false,
    );
    return 2;
  }
  if (parsed.help) {
    deps.stdout(renderNeatSemanticHelp());
    return 0;
  }

  let report: KnowledgeHygieneReportV2;
  try {
    const loaded = await (deps.load_config ?? loadKnowledgeHygieneConfigV2)({
      repo_root: parsed.repo_root,
      ...(parsed.config_path === undefined ? {} : { config_path: parsed.config_path }),
    });
    const configError = semanticConfigError(loaded, parsed);
    if (configError !== undefined) throw new NeatSemanticUsageError(configError);
    const judgeId = parsed.judge_id ?? loaded.config.semantic.judge_id;
    if (judgeId === undefined) throw new NeatSemanticUsageError("semantic judge is required");
    const judge = (deps.judge_factory ?? defaultJudgeFactory)(judgeId);
    const input = SemanticAuditInputV1.parse({
      repo_root: parsed.repo_root,
      mode: parsed.mode,
      ...(parsed.base_ref === undefined ? {} : { base_ref: parsed.base_ref }),
      ...(parsed.head_ref === undefined ? {} : { head_ref: parsed.head_ref }),
      ...(parsed.config_path === undefined ? {} : { config_path: parsed.config_path }),
      dimensions: parsed.dimensions,
      budget: {
        max_input_tokens: parsed.max_input_tokens,
        max_output_tokens: parsed.max_output_tokens,
        max_calls: parsed.max_calls,
      },
    });
    const ports: SemanticAuditPortsV1 = {
      judge,
      decision_cache: deps.decision_cache
        ?? createFileSemanticDecisionCacheV1(osstackHome()),
      ...(deps.observe_evidence_pack !== undefined
        ? { observe_evidence_pack: deps.observe_evidence_pack }
        : process.env["OSSTACK_NEAT_DEBUG_EVIDENCE"] === "1"
          ? {
              observe_evidence_pack: createSemanticEvidenceObserverV1(
                osstackHome(),
                deps.now === undefined ? {} : { now: deps.now },
              ),
            }
          : {}),
      ...(deps.engine_ports === undefined ? {} : { v2: { v1: deps.engine_ports } }),
    };
    report = await (deps.audit ?? auditKnowledgeHygieneSemantics)(input, ports);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const usage = error instanceof NeatSemanticUsageError
      || error instanceof KnowledgeHygieneConfigError;
    const details = error instanceof KnowledgeHygieneConfigError
      && error.details.length > 0
      ? `${message}: ${error.details.join("; ")}`
      : message;
    emitError(deps, parsed.format === "json", details, !usage);
    return usage ? 2 : 3;
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
      emitError(
        deps,
        parsed.format === "json",
        error instanceof Error ? error.message : String(error),
        true,
      );
      return 3;
    }
  }

  const coverageCode = coverageExitCode(
    report,
    parsed.dimensions,
    parsed.allow_truncated,
  );
  const exitCode = coverageCode === 3
    ? 3
    : findingExitCode(report, parsed.fail_on);
  if (parsed.format === "json") {
    deps.stdout(JSON.stringify(successEnvelope(report, recording), null, 2));
  } else {
    const rendered = deps.render_report(report, parsed.fail_on);
    const coverageLine = coverageCode === 3
      ? "Semantic coverage gate: incomplete (exit 3)"
      : "Semantic coverage gate: accepted";
    deps.stdout([
      rendered,
      coverageLine,
      ...(recording === undefined
        ? []
        : [`Recorded: ${recording.run_id} (${recording.inserted ? "inserted" : "existing"}) at ${recording.db_path}`]),
    ].join("\n"));
  }
  return exitCode;
}
