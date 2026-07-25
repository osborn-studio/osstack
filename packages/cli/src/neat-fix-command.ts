import { loadPolicyProfile } from "@osstack/core";
import {
  applyKnowledgeHygienePatchPlan,
  loadKnowledgeHygieneConfig,
  planKnowledgeHygienePatches,
  KnowledgeHygieneConfigError,
  KnowledgeHygienePatchProviderError,
  type KnowledgeHygienePatchApplyResultV1,
  type KnowledgeHygienePatchPlanV1,
  type KnowledgeHygieneReportV1,
} from "@osstack/governance";
import {
  AgentCommandResult,
  PROTOCOL_VERSION as AGENT_COMMAND_PROTOCOL_VERSION,
} from "@osstack/protocol";
import { resolve } from "node:path";
import { evaluateNeatPatchPolicy } from "./neat-patch-policy.js";
import {
  loadNeatReport,
  NeatReviewInputError,
} from "./neat-review-command.js";

interface ParsedFixCommand {
  help: boolean;
  from?: string;
  apply: boolean;
  yes: boolean;
  json: boolean;
}

export interface NeatFixCommandOverrides {
  load_policy?: typeof loadPolicyProfile;
  load_config?: typeof loadKnowledgeHygieneConfig;
  plan_patch?: typeof planKnowledgeHygienePatches;
  apply_patch?: typeof applyKnowledgeHygienePatchPlan;
}

export interface NeatFixCommandDependencies extends NeatFixCommandOverrides {
  cwd: () => string;
  stdout: (value: string) => void;
  now: () => Date;
}

export class NeatFixInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeatFixInputError";
  }
}

export function renderNeatFixHelp(): string {
  return `osstack neat fix — preview or apply closed safe patches

Usage:
  osstack neat fix --from <report.json> [--json]
  osstack neat fix --from <report.json> --apply --yes [--json]

Options:
  --from <path>                 Raw report or successful CLI JSON envelope
  --apply                       Apply the previewed low-risk actions
  --yes                         Required confirmation for --apply
  --json                        Emit a strict AgentCommandResult
  --help                        Show this help`;
}

function inputError(message: string): never {
  throw new NeatFixInputError(message);
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return inputError(`${flag} requires a value`);
  }
  return value;
}

function parseFixCommand(args: readonly string[], cwd: string): ParsedFixCommand {
  if (args.includes("--help") || args.includes("-h")) {
    return { help: true, apply: false, yes: false, json: false };
  }
  let from: string | undefined;
  let apply = false;
  let yes = false;
  let json = false;
  const seen = new Set<string>();
  const markSeen = (flag: string): void => {
    if (seen.has(flag)) inputError(`duplicate flag: ${flag}`);
    seen.add(flag);
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === undefined) continue;
    if (flag === "--from") {
      markSeen(flag);
      from = resolve(cwd, requireValue(args, index, flag));
      index += 1;
    } else if (flag === "--apply") {
      markSeen(flag);
      apply = true;
    } else if (flag === "--yes") {
      markSeen(flag);
      yes = true;
    } else if (flag === "--json") {
      markSeen(flag);
      json = true;
    } else {
      inputError(`unknown fix option: ${flag}`);
    }
  }
  if (from === undefined) inputError("--from is required");
  if (apply && !yes) inputError("--apply requires --yes");
  if (yes && !apply) inputError("--yes requires --apply");
  return { help: false, from, apply, yes, json };
}

function successEnvelope(
  mode: "preview" | "apply",
  patchPlan: KnowledgeHygienePatchPlanV1,
  applyResult?: KnowledgeHygienePatchApplyResultV1,
) {
  return AgentCommandResult.parse({
    protocol_version: AGENT_COMMAND_PROTOCOL_VERSION,
    status: "ok",
    result: {
      command: "knowledge_hygiene.fix",
      mode,
      patch_plan: patchPlan,
      ...(applyResult === undefined ? {} : { apply_result: applyResult }),
    },
  });
}

function renderPreview(plan: KnowledgeHygienePatchPlanV1): string {
  const lines = [
    `Patch preview ${plan.patch_id}`,
    `Actions: ${plan.actions.length}`,
  ];
  for (const action of plan.actions) {
    lines.push(
      `  CREATE ${action.target_path}`,
      "    Before: absent",
      `    After sha256: ${action.after.sha256}`,
      `    Source: ${action.source_fingerprint}`,
    );
  }
  if (plan.actions.length === 0) lines.push("No eligible safe patches.");
  lines.push("Preview only. Re-run with --apply --yes after review.");
  return lines.join("\n");
}

function renderApply(result: KnowledgeHygienePatchApplyResultV1): string {
  const lines = [
    `Patch applied ${result.patch_id}`,
    `Actions: ${result.actions.length}`,
  ];
  for (const action of result.actions) {
    lines.push(
      `  ${action.status.toUpperCase()} ${action.target_path}`,
      `    Before sha256: ${action.before.sha256 ?? "absent"}`,
      `    After sha256: ${action.after.sha256}`,
    );
  }
  return lines.join("\n");
}

export async function handleNeatFixCommand(
  args: readonly string[],
  deps: NeatFixCommandDependencies,
): Promise<0> {
  const parsed = parseFixCommand(args, deps.cwd());
  if (parsed.help) {
    deps.stdout(renderNeatFixHelp());
    return 0;
  }

  let report: KnowledgeHygieneReportV1;
  try {
    report = await loadNeatReport(parsed.from as string, "--from");
  } catch (error) {
    if (error instanceof NeatReviewInputError) inputError(error.message);
    throw error;
  }
  const loadConfig = deps.load_config ?? loadKnowledgeHygieneConfig;
  let loadedConfig: Awaited<ReturnType<typeof loadKnowledgeHygieneConfig>>;
  try {
    loadedConfig = await loadConfig({
      repo_root: report.repo.root,
      ...(report.input.config_path === undefined
        ? {}
        : { config_path: report.input.config_path }),
    });
  } catch (error) {
    if (error instanceof KnowledgeHygieneConfigError) inputError(error.message);
    throw error;
  }
  if (loadedConfig.mode !== "configured") {
    inputError("safe patch planning requires .osstack/neat.yaml");
  }
  if (report.input.config_sha256 === undefined) {
    inputError("source report has no config_sha256");
  }
  if (loadedConfig.sha256 !== report.input.config_sha256) {
    inputError("current neat config does not match source report config_sha256");
  }

  let patchPlan: KnowledgeHygienePatchPlanV1;
  try {
    patchPlan = await (deps.plan_patch ?? planKnowledgeHygienePatches)({
      report,
      config: loadedConfig.config,
    }, {
      now: deps.now,
      allow_already_applied: parsed.apply,
    });
  } catch (error) {
    if (error instanceof KnowledgeHygienePatchProviderError) {
      inputError(error.message);
    }
    throw error;
  }

  if (!parsed.apply) {
    deps.stdout(parsed.json
      ? JSON.stringify(successEnvelope("preview", patchPlan), null, 2)
      : renderPreview(patchPlan));
    return 0;
  }
  if (!report.completeness.complete) {
    inputError("cannot apply a patch from an incomplete report");
  }

  let profile: Awaited<ReturnType<typeof loadPolicyProfile>>;
  try {
    profile = await (deps.load_policy ?? loadPolicyProfile)(report.repo.root);
  } catch (error) {
    inputError(error instanceof Error ? error.message : String(error));
  }
  const policy = evaluateNeatPatchPolicy(profile);
  if (!policy.allow) inputError(`policy_denied: ${policy.reason}`);

  const applyResult = await (deps.apply_patch ?? applyKnowledgeHygienePatchPlan)(
    patchPlan,
    { now: deps.now },
  );
  deps.stdout(parsed.json
    ? JSON.stringify(successEnvelope("apply", patchPlan, applyResult), null, 2)
    : renderApply(applyResult));
  return 0;
}
