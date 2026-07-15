// Post-verify publish finalizer：skill 任务 verify 绿灯后，调用 Hub 的 osstack_publish 命令
// 把 skill 发布到 OSBORN Studio Skill Hub（promote→push 数据仓库→CI 部署→API 校验）。
// 发布结果只记录、绝不改变 verify 结论（非门禁 finalizer）。

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { PublishedAssetEvidence, Task } from "./types.js";

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

// ── Durable release evidence mapping (Phase 2B) ──────────────────────────

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
// release_id = <ns-kind>__<ns-id>/<asset-id>@<version>; namespace = <kind>/<id>.
const RELEASE_ID_RE = /^[a-z0-9][a-z0-9-]*__[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*@[0-9][0-9A-Za-z.-]*$/;
const NAMESPACE_RE = /^(personal|organization)\/[a-z0-9][a-z0-9-]*$/;

/** Accept only a logical, relative locator — never a dist/packages path or an
 *  absolute/drive path. Rejects ANY drive prefix (incl. drive-relative like
 *  "C:x"), backslashes, a leading "/", and dist/packages CASE-INSENSITIVELY
 *  (case-insensitive filesystems alias DIST/PACKAGES). */
export function safeStorageKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\\")) return undefined;
  if (/(^|\/)dist\/packages(\/|$)/i.test(value) || /^dist\//i.test(value)) return undefined;
  if (value.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return undefined;
  return value;
}

/** Accept a release_id only if it matches the logical identity shape (never an
 *  absolute path / dist path masquerading as an id). */
export function safeReleaseId(value: unknown): string | undefined {
  return typeof value === "string" && RELEASE_ID_RE.test(value) ? value : undefined;
}

/** Accept a namespace only in <kind>/<id> logical form. */
export function safeNamespace(value: unknown): string | undefined {
  return typeof value === "string" && NAMESPACE_RE.test(value) ? value : undefined;
}

const PUBLISH_GATES = ["team", "client", "commercial"] as const;
function normalizeGate(value: unknown, fallback: PublishConfig["gate"]): PublishConfig["gate"] {
  return (PUBLISH_GATES as readonly string[]).includes(value as string)
    ? (value as PublishConfig["gate"]) : fallback;
}

/**
 * Map a Hub publish result into durable, auditable PublishedAssetEvidence.
 * release_id/digest are attached ONLY on a successful `published` result; a
 * malformed digest is dropped. storage_key comes from the safe locator
 * (`storage_key`, or a `packagePath` only if it is a safe relative locator —
 * never dist/packages). blocked/error carry status + reasons, no release identity.
 */
export function toPublishedAssetEvidence(
  result: PublishResult,
  defaultGate: PublishConfig["gate"],
): PublishedAssetEvidence {
  const extra = result as Record<string, unknown>;
  const status: PublishedAssetEvidence["status"] =
    result.status === "published" ? "published" : result.status === "blocked" ? "blocked" : "error";
  const base: PublishedAssetEvidence = {
    status,
    asset_id: result.id,
    gate: normalizeGate(result.gate ?? undefined, defaultGate),
    reasons: result.reasons ?? [],
  };
  if (status !== "published") return base;

  // Validate EVERY identity field — never persist an absolute/dist path smuggled
  // in via releaseId or namespace (they are rendered verbatim in report/events).
  const releaseId = safeReleaseId(extra["releaseId"]);
  const digestRaw = typeof extra["digest"] === "string" ? (extra["digest"] as string) : undefined;
  const digest = digestRaw !== undefined && DIGEST_RE.test(digestRaw) ? digestRaw : undefined;
  const namespace = safeNamespace(extra["namespace"]);
  const storageKey = safeStorageKey(extra["storage_key"]) ?? safeStorageKey(extra["packagePath"]);

  return {
    ...base,
    ...(releaseId !== undefined ? { release_id: releaseId } : {}),
    ...(digest !== undefined ? { digest } : {}),
    ...(namespace !== undefined ? { namespace } : {}),
    ...(storageKey !== undefined ? { storage_key: storageKey } : {}),
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
