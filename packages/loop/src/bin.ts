#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  LoopEngine,
  countTaskQueueTasks,
  enqueueTask,
  readLoopState,
  renderLoopStateMarkdown,
} from "./index.js";

const VERSION = "0.0.0";

type CheckStatus = "ok" | "warn" | "error";

interface LoopDoctorCheck {
  id: string;
  status: CheckStatus;
  summary: string;
  details?: Record<string, unknown>;
}

interface LoopDoctorResult {
  ok: boolean;
  workspace_path: string;
  state_json: string;
  checks: LoopDoctorCheck[];
}

interface LoopRunSummary {
  loop_id: string;
  json_path: string;
  markdown_path: string;
  completed_tasks: Array<{
    task_id: string;
    outcome: "success" | "failed" | "escalated";
    iterations: number;
    agent_id: string;
    duration_ms: number;
  }>;
  metrics?: { success_rate: number };
  goal?: {
    command: string;
    pass: boolean;
    exitCode: number;
    durationMs: number;
    summary: string;
  };
  cycles?: Array<{
    discovered_task_count: number;
    executed_task_count: number;
    skipped_task_count: number;
    goal?: LoopRunSummary["goal"];
  }>;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const cmd = args[0];

  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(`osstack-loop ${VERSION}`);
    return 0;
  }

  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return 0;
  }

  if (cmd === "run") return await handleRun(args.slice(1));
  if (cmd === "enqueue") return await handleEnqueue(args.slice(1));
  if (cmd === "status") return await handleStatus(args.slice(1));
  if (cmd === "doctor") return await handleDoctor(args.slice(1));

  console.error(`osstack-loop: unknown command "${cmd}"`);
  return 1;
}

async function handleRun(args: string[]): Promise<number> {
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const stateFilePath = flagValue(args, "--state") ?? "LOOP-STATE.json";
  const markdownPath = flagValue(args, "--markdown");
  const executeCommand = flagValue(args, "--execute");
  const goalCommand = flagValue(args, "--goal");
  const worktreeRoot = flagValue(args, "--worktree-root");
  const verifyCommands = flagValues(args, "--verify");
  const sources = flagValues(args, "--source");
  const cycles = parsePositiveIntegerFlag(flagValue(args, "--cycles"), "--cycles");
  if (cycles instanceof Error) return printError(cycles);
  const intervalMs = parseNonNegativeIntegerFlag(flagValue(args, "--interval-ms"), "--interval-ms");
  if (intervalMs instanceof Error) return printError(intervalMs);
  const maxIterations = parsePositiveIntegerFlag(flagValue(args, "--max-iter"), "--max-iter");
  if (maxIterations instanceof Error) return printError(maxIterations);
  const stopWhenIdle = args.includes("--stop-when-idle");
  const runCycles = cycles !== undefined || intervalMs !== undefined || stopWhenIdle;

  const engine = new LoopEngine({
    workspacePath,
    stateFilePath,
    ...(markdownPath !== undefined ? { markdownPath } : {}),
    ...(executeCommand !== undefined ? { executeCommand } : {}),
    ...(goalCommand !== undefined ? { goalCommand } : {}),
    ...(verifyCommands.length > 0 ? { verifyCommands } : {}),
    ...(sources.length > 0 ? { sources } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(args.includes("--archive-completed") ? { archiveCompletedTasks: true } : {}),
    ...(args.includes("--worktree") ? { useWorktree: true } : {}),
    ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
  });

  const result = runCycles
    ? await engine.runCycles({
        ...(cycles !== undefined ? { cycles } : {}),
        ...(intervalMs !== undefined ? { intervalMs } : {}),
        ...(stopWhenIdle ? { stopWhenIdle } : {}),
      })
    : await engine.runOnce();
  const goal = "goal" in result
    ? result.goal
    : "cycles" in result
      ? result.cycles.at(-1)?.goal
      : undefined;
  const summary: LoopRunSummary = {
    loop_id: result.loop_id,
    json_path: result.jsonPath,
    markdown_path: result.markdownPath,
    completed_tasks: result.state.completed_tasks,
    ...(result.state.key_metrics !== undefined ? { metrics: result.state.key_metrics } : {}),
    ...(goal !== undefined ? { goal } : {}),
    ...("cycles" in result ? { cycles: result.cycles.map((cycle) => ({
      discovered_task_count: cycle.discoveredTaskCount,
      executed_task_count: cycle.executedTaskCount,
      skipped_task_count: cycle.skippedTaskCount,
      ...(cycle.goal !== undefined ? { goal: cycle.goal } : {}),
    })) } : {}),
  };
  printLoopRun(summary, args.includes("--json"));
  return summary.completed_tasks.some((task) => task.outcome !== "success") ? 2 : 0;
}

async function handleEnqueue(args: string[]): Promise<number> {
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const capability = flagValue(args, "--capability");
  const taskId = flagValue(args, "--id");
  const priority = parsePositiveIntegerFlag(flagValue(args, "--priority"), "--priority");
  if (priority instanceof Error) return printError(priority);
  if (priority !== undefined && priority > 100) {
    console.error("osstack-loop: --priority must be between 1 and 100");
    return 1;
  }
  const context = parseContextJson(flagValue(args, "--context-json"));
  if (context instanceof Error) return printError(context);
  const prompt = positionalValues(args, new Set([
    "--workspace",
    "--capability",
    "--id",
    "--priority",
    "--context-json",
  ])).join(" ").trim();
  if (prompt === "") {
    console.error("osstack-loop: enqueue requires a prompt");
    return 1;
  }

  const result = await enqueueTask({
    workspacePath,
    prompt,
    ...(capability !== undefined ? { capability } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(context !== undefined ? { context } : {}),
  });

  if (args.includes("--json")) {
    console.log(JSON.stringify({ task: result.task, path: result.path }, null, 2));
  } else {
    console.log(`task_id=${result.task.task_id}`);
    console.log(`path=${result.path}`);
  }
  return 0;
}

async function handleStatus(args: string[]): Promise<number> {
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const stateFilePath = resolveLoopPath(flagValue(args, "--state") ?? "LOOP-STATE.json", workspacePath);
  const state = await readLoopState(stateFilePath);
  if (state !== null) {
    if (args.includes("--json")) console.log(JSON.stringify(state, null, 2));
    else console.log(renderLoopStateMarkdown(state));
    return 0;
  }

  const markdownPath = stateFilePath.endsWith(".json")
    ? stateFilePath.replace(/[^/]+$/, "STATE.md")
    : resolveLoopPath("STATE.md", workspacePath);
  try {
    console.log(await readFile(markdownPath, "utf-8"));
    return 0;
  } catch {
    console.error(`osstack-loop: no loop state found at ${stateFilePath}`);
    return 1;
  }
}

async function handleDoctor(args: string[]): Promise<number> {
  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const stateFilePath = resolveLoopPath(flagValue(args, "--state") ?? "LOOP-STATE.json", workspacePath);
  const result = await loopDoctor({ workspacePath, stateFilePath });
  if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else printLoopDoctor(result);
  return result.ok ? 0 : 1;
}

async function loopDoctor(input: { workspacePath: string; stateFilePath: string }): Promise<LoopDoctorResult> {
  const checks: LoopDoctorCheck[] = [];
  const add = (id: string, status: CheckStatus, summary: string, details?: Record<string, unknown>) => {
    checks.push(details === undefined ? { id, status, summary } : { id, status, summary, details });
  };

  let workspaceReady = false;
  try {
    const workspace = await stat(input.workspacePath);
    if (workspace.isDirectory()) {
      workspaceReady = true;
      add("workspace", "ok", "workspace directory exists");
    } else {
      add("workspace", "error", "workspace path is not a directory");
    }
  } catch (error) {
    add("workspace", "error", "workspace directory is not accessible", { error: errorMessage(error) });
  }

  if (workspaceReady) {
    await checkTaskQueue(input.workspacePath, add);
    await checkLoopState(input.stateFilePath, add);
  }

  return {
    ok: !checks.some((check) => check.status === "error"),
    workspace_path: input.workspacePath,
    state_json: input.stateFilePath,
    checks,
  };
}

async function checkTaskQueue(
  workspacePath: string,
  add: (id: string, status: CheckStatus, summary: string, details?: Record<string, unknown>) => void,
): Promise<void> {
  const taskDir = join(workspacePath, "tasks");
  let entries: string[];
  try {
    entries = await readdir(taskDir);
  } catch (error) {
    add("task_queue", "warn", "tasks/ directory is missing; enqueue will create it", {
      path: taskDir,
      error: errorMessage(error),
    });
    return;
  }

  const jsonFiles = entries.filter((entry) => entry.endsWith(".json")).sort();
  let validTasks = 0;
  const invalidFiles: string[] = [];
  const invalidDetails: Record<string, string> = {};
  for (const file of jsonFiles) {
    const path = join(taskDir, file);
    try {
      validTasks += countTaskQueueTasks(JSON.parse(await readFile(path, "utf-8")) as unknown);
    } catch (error) {
      invalidFiles.push(file);
      invalidDetails[file] = errorMessage(error);
    }
  }
  if (invalidFiles.length > 0) {
    add("task_queue", "error", "task queue contains invalid JSON task files", {
      path: taskDir,
      json_files: jsonFiles.length,
      valid_tasks: validTasks,
      invalid_files: invalidFiles,
      invalid_details: invalidDetails,
    });
    return;
  }
  add("task_queue", "ok", "task queue is readable", {
    path: taskDir,
    json_files: jsonFiles.length,
    valid_tasks: validTasks,
  });
}

async function checkLoopState(
  stateFilePath: string,
  add: (id: string, status: CheckStatus, summary: string, details?: Record<string, unknown>) => void,
): Promise<void> {
  const state = await readLoopState(stateFilePath);
  if (state === null) {
    add("state", "warn", "loop state does not exist yet", { path: stateFilePath });
    return;
  }
  add("state", "ok", "loop state is readable", {
    path: stateFilePath,
    loop_id: state.loop_id,
    completed_tasks: state.completed_tasks.length,
  });
}

function printLoopRun(result: LoopRunSummary, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`loop_id=${result.loop_id}`);
  console.log(`state_json=${result.json_path}`);
  console.log(`state_markdown=${result.markdown_path}`);
  console.log(`tasks=${result.completed_tasks.length} success_rate=${Math.round((result.metrics?.success_rate ?? 1) * 100)}%`);
  if (result.goal !== undefined) console.log(`goal=${result.goal.pass ? "passed" : "not_met"} exit_code=${result.goal.exitCode}`);
  if (result.cycles !== undefined) {
    console.log(`cycles=${result.cycles.length}`);
    result.cycles.forEach((cycle, index) => {
      const goal = cycle.goal === undefined ? "" : ` goal=${cycle.goal.pass ? "passed" : "not_met"}`;
      console.log(`  cycle ${index + 1}: discovered=${cycle.discovered_task_count} executed=${cycle.executed_task_count} skipped=${cycle.skipped_task_count}${goal}`);
    });
  }
  for (const task of result.completed_tasks) {
    console.log(`  ${task.task_id}: ${task.outcome} (${task.iterations} iteration${task.iterations === 1 ? "" : "s"})`);
  }
}

function printLoopDoctor(result: LoopDoctorResult): void {
  console.log(`workspace=${result.workspace_path}`);
  console.log(`state_json=${result.state_json}`);
  for (const check of result.checks) {
    console.log(`${check.status.toUpperCase()} ${check.id}: ${check.summary}`);
    if (check.details !== undefined) console.log(`  ${JSON.stringify(check.details)}`);
  }
}

function printHelp(): void {
  console.log(`osstack-loop ${VERSION} — standalone Loop Engineering runner

Usage:
  osstack-loop run [options]       Run discover→execute→verify→iterate locally
  osstack-loop enqueue <prompt>    Add a JSON task under tasks/
  osstack-loop status [options]    Print LOOP-STATE.json as Markdown
  osstack-loop doctor [options]    Check workspace, queue, and state readiness

Options:
  --workspace P       Workspace to scan and run commands in (default: cwd)
  --source S          Discovery source; repeatable. git_diff | task_queue
  --execute CMD       Shell command to run for each task
  --verify CMD        Shell verifier; repeatable. Non-zero exit marks failure
  --goal CMD          Global shell command; loop stops when it exits 0
  --archive-completed Move successful single-task queue files into tasks/archive/
  --worktree          Run each task in an isolated git worktree, merge success back
  --worktree-root P   Directory for temporary isolated worktrees
  --max-iter N        Iterations before escalation (default: 1)
  --cycles N          Run multiple cycles before exiting
  --interval-ms N     Delay between cycles in milliseconds
  --stop-when-idle    Stop after the first cycle that executes no tasks
  --state P           JSON state path (default: LOOP-STATE.json)
  --markdown P        Markdown state path (default: STATE.md beside JSON)
  --json              Emit machine-readable output

Example:
  osstack-loop enqueue "Run local checks" --capability code.test
  osstack-loop run --source task_queue --execute "pnpm build" --verify "pnpm test"
  osstack-loop status
`);
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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

function positionalValues(args: string[], flagsWithValues: Set<string>): string[] {
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

function parsePositiveIntegerFlag(value: string | undefined, name: string): number | undefined | Error {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseNonNegativeIntegerFlag(value: string | undefined, name: string): number | undefined | Error {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function parseContextJson(value: string | undefined): Record<string, unknown> | undefined | Error {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`--context-json must be valid JSON: ${message}`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    return new Error("--context-json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function resolveLoopPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

function printError(error: Error): 1 {
  console.error(`osstack-loop: ${error.message}`);
  return 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  }, (error) => {
    console.error("osstack-loop:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
