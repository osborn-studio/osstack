import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { defaultAdapters } from "@osstack/agents";
import type { GovernanceFinding } from "@osstack/governance";
import {
  enqueueTask,
  LoopEngine,
  type LoopEvent,
  type LoopState,
} from "@osstack/loop";
import { makePolicyGate } from "./policy-gate.js";

type DeliverGovernanceProofEvidence =
  | {
    status: "pass" | "fail";
    ok: boolean;
    scanned_files: number;
    findings: GovernanceFinding[];
  }
  | {
    status: "unknown";
    ok: false;
    scanned_files: 0;
    reason: string;
    findings: GovernanceFinding[];
  };

export type DeliverGovernanceMode = "warn" | "strict";

export type DeliverGovernanceEvidence =
  DeliverGovernanceProofEvidence & {
    mode: DeliverGovernanceMode;
    blocking: boolean;
    error_findings: number;
  };

export interface DeliverEvidenceArtifacts {
  report?: string;
  scorecard_markdown?: string;
  scorecard_html?: string;
  proof_dir?: string;
  proof_zip?: string;
  proof_manifest?: string;
}

export interface DeliverCommandDeps {
  enforceObservePolicyGate: (
    workspacePath: string,
  ) => Promise<number | undefined>;
  createShadowCheckpoint: (
    workspacePath: string,
  ) => Promise<unknown>;
  createLoopGovernanceEvidence: (
    mode: DeliverGovernanceMode,
    workspacePath: string,
  ) => Promise<DeliverGovernanceEvidence>;
  appendGovernanceVerifyEvent: (
    events: LoopEvent[],
    loopId: string,
    governance: DeliverGovernanceEvidence,
  ) => LoopEvent[];
  observeLoopProbeEvents: (
    workspacePath: string,
    events: readonly unknown[],
  ) => Promise<unknown>;
  writeRequestedLoopArtifacts: (
    state: LoopState,
    workspacePath: string,
    args: string[],
    events: LoopEvent[],
    governance?: DeliverGovernanceEvidence,
  ) => Promise<DeliverEvidenceArtifacts | undefined>;
  learnLessonsFromLoopState: (
    state: LoopState,
  ) => Promise<unknown>;
}

export async function handleDeliverCommand(
  args: string[],
  deps: DeliverCommandDeps,
): Promise<number> {
  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(`osstack deliver — product entry from one intent to proof

  osstack deliver "Add billing dashboard" [--workspace P] [--execute CMD] [--verify CMD] [--auto-agent] [--worktree] [--checkpoint] [--govern [warn|strict]] [--json]

Stages:
  intake -> plan -> execute-loop -> verify-review -> proof
`);
    return 0;
  }

  const prompt = firstPositionalValue(args, new Set([
    "--workspace",
    "--state",
    "--execute",
    "--verify",
    "--agent",
    "--capability",
    "--priority",
    "--max-iter",
    "--worktree-root",
    "--govern",
  ]));
  if (prompt === undefined) {
    console.error("osstack: deliver requires a prompt");
    return 1;
  }
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const policyGate = await deps.enforceObservePolicyGate(workspacePath);
  if (policyGate !== undefined) return policyGate;
  const stateFilePath = flagValue(args, "--state") ?? "LOOP-STATE.json";
  const executeCommand = flagValue(args, "--execute");
  const agentId = flagValue(args, "--agent");
  const capability = flagValue(args, "--capability") ?? "code.write";
  const priority = parsePositiveIntegerFlag(
    flagValue(args, "--priority"),
    "--priority",
  );
  if (priority instanceof Error) {
    console.error(`osstack: ${priority.message}`);
    return 1;
  }
  const maxIterations = parsePositiveIntegerFlag(
    flagValue(args, "--max-iter"),
    "--max-iter",
  );
  if (maxIterations instanceof Error) {
    console.error(`osstack: ${maxIterations.message}`);
    return 1;
  }
  const verifyCommands = flagValues(args, "--verify");
  const suggestedVerify = await suggestVerifyCommand(workspacePath);
  const governanceMode = parseDeliverGovernanceMode(args);
  if (governanceMode instanceof Error) {
    console.error(`osstack: ${governanceMode.message}`);
    return 1;
  }
  const autoAgent = args.includes("--auto-agent");
  const useWorktree = args.includes("--worktree");
  const checkpoint = args.includes("--checkpoint") && !useWorktree
    ? await deps.createShadowCheckpoint(realpathSync(workspacePath))
    : undefined;
  const stages = [
    "intake",
    "plan",
    "execute-loop",
    "verify-review",
    "proof",
  ];
  const task = await enqueueTask({
    workspacePath,
    prompt,
    capability,
    ...(priority !== undefined ? { priority } : {}),
    context: {
      deliver_pipeline: {
        stages,
        suggested_verify: suggestedVerify,
        verify_commands: verifyCommands,
        auto_agent: autoAgent,
      },
    },
  });
  const adapters = agentId !== undefined || autoAgent
    ? defaultAdapters()
    : undefined;
  const worktreeRoot = flagValue(args, "--worktree-root");
  const engine = new LoopEngine({
    workspacePath,
    stateFilePath,
    ...(executeCommand !== undefined ? { executeCommand } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(autoAgent ? { autoAgent } : {}),
    ...(adapters !== undefined ? { adapters } : {}),
    ...(verifyCommands.length > 0 ? { verifyCommands } : {}),
    sources: ["task_queue"],
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(useWorktree ? { useWorktree: true } : {}),
    ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
    policyGate: makePolicyGate(workspacePath),
  });
  const result = await engine.runOnce();
  const artifactArgs = ensureFlags(
    args,
    ["--report", "--scorecard", "--proof"],
  );
  const governance = governanceMode === undefined
    ? undefined
    : await deps.createLoopGovernanceEvidence(
      governanceMode,
      workspacePath,
    );
  const events = governance === undefined
    ? result.events
    : deps.appendGovernanceVerifyEvent(
      result.events,
      result.loop_id,
      governance,
    );
  const probeObservation = await deps.observeLoopProbeEvents(
    workspacePath,
    events,
  );
  const artifacts = await deps.writeRequestedLoopArtifacts(
    result.state,
    workspacePath,
    artifactArgs,
    events,
    governance,
  );
  const learnedLessons = await deps.learnLessonsFromLoopState(result.state);
  const summary = {
    prompt,
    stages,
    suggested_verify: suggestedVerify,
    verify_commands: verifyCommands,
    task: task.task,
    task_path: task.path,
    loop_id: result.loop_id,
    json_path: result.jsonPath,
    markdown_path: result.markdownPath,
    completed_tasks: result.state.completed_tasks,
    events,
    ...(probeObservation === undefined
      ? {}
      : { probe_observation: probeObservation }),
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(artifacts !== undefined ? { artifacts } : {}),
    ...(governance !== undefined ? { governance } : {}),
    ...(learnedLessons !== undefined
      ? { learned_lessons: learnedLessons }
      : {}),
    ...(result.state.key_metrics !== undefined
      ? { metrics: result.state.key_metrics }
      : {}),
  };
  if (args.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`deliver=${result.loop_id}`);
    console.log(`task=${task.path}`);
    if (suggestedVerify !== undefined) {
      console.log(`suggested_verify=${suggestedVerify}`);
    }
    if (governance !== undefined) {
      console.log(
        `governance=${governance.status} mode=${governance.mode} blocking=${governance.blocking ? "yes" : "no"}`,
      );
    }
    if (artifacts?.report !== undefined) {
      console.log(`report=${artifacts.report}`);
    }
    if (artifacts?.proof_dir !== undefined) {
      console.log(`proof=${artifacts.proof_dir}`);
    }
  }
  return result.state.completed_tasks.some(
    (completed) => completed.outcome !== "success",
  ) || governance?.blocking === true
    ? 2
    : 0;
}

function ensureFlags(args: string[], flags: string[]): string[] {
  const next = [...args];
  for (const flag of flags) {
    if (!next.includes(flag)) next.push(flag);
  }
  return next;
}

export async function suggestVerifyCommand(
  workspacePath: string,
): Promise<string | undefined> {
  if (await fileExists(join(workspacePath, "pnpm-lock.yaml"))) {
    return "pnpm test";
  }
  if (
    await fileExists(join(workspacePath, "bun.lockb"))
    || await fileExists(join(workspacePath, "bun.lock"))
  ) {
    return "bun test";
  }
  if (await fileExists(join(workspacePath, "package-lock.json"))) {
    return "npm test";
  }
  try {
    const packageJson = JSON.parse(
      await readFile(join(workspacePath, "package.json"), "utf-8"),
    ) as unknown;
    if (
      isRecord(packageJson)
      && isRecord(packageJson["scripts"])
      && typeof packageJson["scripts"]["test"] === "string"
    ) {
      return "npm test";
    }
  } catch {
    // No package.json or unreadable package metadata.
  }
  return undefined;
}

function parseDeliverGovernanceMode(
  args: string[],
): DeliverGovernanceMode | undefined | Error {
  const index = args.indexOf("--govern");
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) return "warn";
  if (value === "warn" || value === "strict") return value;
  return new Error("--govern must be warn or strict");
}

function parsePositiveIntegerFlag(
  value: string | undefined,
  name: string,
): number | undefined | Error {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function firstPositionalValue(
  args: string[],
  flagsWithValues: Set<string>,
): string | undefined {
  return positionalValues(args, flagsWithValues)[0];
}

function positionalValues(
  args: string[],
  flagsWithValues: Set<string>,
): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (flagsWithValues.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("--")) continue;
    values.push(arg);
  }
  return values;
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length
    ? args[index + 1]
    : undefined;
}

function flagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && i + 1 < args.length) {
      values.push(args[i + 1]!);
      i++;
    }
  }
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
