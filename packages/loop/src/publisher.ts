// Post-verify publish finalizer：skill 任务 verify 绿灯后，调用 Hub 的 osstack_publish 命令
// 把 skill 发布到 OSBORN Studio Skill Hub（promote→push 数据仓库→CI 部署→API 校验）。
// 发布结果只记录、绝不改变 verify 结论（非门禁 finalizer）。

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Task } from "./types.js";

const DEFAULT_COMMAND =
  "/Volumes/AIMATE_WORK/Developer/ClaudeCode/01_active/osborn-studio-skill-hub/tooling/osstack_publish.mjs";

// ── Contract 1.1 ─────────────────────────────────────────────────────────

export const PublishResult = z.object({
  contract: z.string(),
  status: z.enum(["published", "blocked", "error", "busy"]),
  id: z.string(),
  score: z.number().nullable().optional(),
  gate: z.string().nullable().optional(),
  committed: z.boolean().optional(),
  pushed: z.boolean().optional(),
  pipeline: z.string().optional(),
  apiVerified: z.boolean().optional(),
  apiVersion: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  durationMs: z.number(),
  reasons: z.array(z.string()).optional(),
  message: z.string().optional(),
}).passthrough();
export type PublishResult = z.infer<typeof PublishResult>;

// ── Config ────────────────────────────────────────────────────────────

export const PublishConfig = z.object({
  enabled: z.boolean().default(false),
  command: z.string().default(DEFAULT_COMMAND),
  gate: z.enum(["team", "client", "commercial"]).default("team"),
  push: z.boolean().default(true),
  onFailure: z.enum(["block", "warn"]).default("block"),
  apiVerifyTimeoutMs: z.number().default(420_000),
});
export type PublishConfig = z.infer<typeof PublishConfig>;

// ── Task inspection helpers ──────────────────────────────────────────────

export function isSkillTask(task: Task): boolean {
  if (task.capability === "skill.publish") return true;
  return skillIdOf(task) !== undefined;
}

export function skillIdOf(task: Task): string | undefined {
  const publish = task.context?.["publish"];
  if (publish === null || typeof publish !== "object" || Array.isArray(publish)) return undefined;
  const skillId = (publish as Record<string, unknown>)["skillId"];
  return typeof skillId === "string" && skillId.trim() !== "" ? skillId : undefined;
}

// ── Publish runner ────────────────────────────────────────────────────

export interface RunPublishDeps {
  runCommand: (argv: string[]) => Promise<{ stdout: string; exitCode: number }>;
  sleep?: (ms: number) => Promise<void>;
}

const BUSY_RETRY_BACKOFF_MS = 5_000;

export async function runPublish(
  skillId: string,
  cfg: PublishConfig,
  deps: RunPublishDeps,
): Promise<PublishResult> {
  const wait = deps.sleep ?? ((ms: number) => sleep(ms));
  const argv = buildArgv(skillId, cfg);

  const first = await execAndParse(skillId, argv, deps.runCommand);
  if (first.status !== "busy") return first;

  await wait(BUSY_RETRY_BACKOFF_MS);
  return await execAndParse(skillId, argv, deps.runCommand);
}

function buildArgv(skillId: string, cfg: PublishConfig): string[] {
  return [
    cfg.command,
    skillId,
    "--gate",
    cfg.gate,
    ...(cfg.push ? [] : ["--no-push"]),
    "--timeout-ms",
    String(cfg.apiVerifyTimeoutMs),
  ];
}

async function execAndParse(
  skillId: string,
  argv: string[],
  runCommand: RunPublishDeps["runCommand"],
): Promise<PublishResult> {
  const { stdout } = await runCommand(argv);
  return parsePublishOutput(skillId, stdout);
}

function parsePublishOutput(skillId: string, stdout: string): PublishResult {
  const lastLine = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);

  if (lastLine !== undefined) {
    try {
      const parsed = PublishResult.safeParse(JSON.parse(lastLine));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through to synthesized error result
    }
  }

  return {
    contract: "1.1",
    status: "error",
    id: skillId,
    durationMs: 0,
    reasons: ["malformed_output"],
    message: stdout.trim().slice(-300),
  };
}

// ── Real command runner (node:child_process) ─────────────────────────────

export async function runCommandReal(argv: string[]): Promise<{ stdout: string; exitCode: number }> {
  const [command, ...args] = argv;
  if (command === undefined) {
    return { stdout: "", exitCode: 1 };
  }
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", () => {
      // stderr intentionally not surfaced in the parsed result; contract lives on stdout.
    });
    child.on("error", () => {
      resolve({ stdout, exitCode: 1 });
    });
    child.on("close", (code) => {
      resolve({ stdout, exitCode: code ?? 1 });
    });
  });
}
