// Discovery governance — separate "discovering possible work" from
// "authorizing execution". AI may scan for tasks, but the human-defined
// policy decides what runs automatically, what waits for approval, what is
// merely suggested, and what is blocked outright.
//
// Governance is opt-in: when no DiscoveryPolicy is configured, the loop
// behaves exactly as before (every discovered task executes). This preserves
// explicit task_queue local runs and all legacy CLI behavior.
//
// Note: only `import type` from ./types.js is allowed here — types.ts imports
// the TaskAuthorization value from this module, so a runtime import back into
// types.ts would create a module cycle.

import { z } from "zod";
import type { Task } from "./types.js";

export const TaskAuthorization = z.enum([
  "auto_execute",
  "needs_approval",
  "suggest_only",
  "blocked",
]);
export type TaskAuthorization = z.infer<typeof TaskAuthorization>;

// Local mirror of DiscoverSource in ./types.ts. Kept as a literal here because
// types.ts imports the TaskAuthorization *value* from this module at runtime;
// importing the DiscoverSource value back would create a module cycle. Keep in
// sync with DiscoverSource — the superRefine below validates policy keys against
// it so a typo'd source is rejected instead of silently ignored.
const DISCOVERY_SOURCE_KEYS = [
  "git_diff",
  "gh_issue",
  "github_branch",
  "ci_log",
  "task_queue",
  "manual",
] as const;

export const DiscoveryPolicy = z.object({
  default_authorization: TaskAuthorization.default("needs_approval"),
  /** Capabilities (exact or dotted prefix) that may execute automatically. */
  auto_execute_capabilities: z.array(z.string()).default([]),
  /** Capabilities (exact or dotted prefix) that must never execute. */
  blocked_capabilities: z.array(z.string()).default([]),
  /** Path prefixes a task's context files must not touch. */
  blocked_paths: z.array(z.string()).default([]),
  /** Tasks above this priority always need approval, even when auto-eligible. */
  max_auto_priority: z.number().min(0).max(100).default(80),
  /** Per-discovery-source authorization overrides (e.g. git_diff -> suggest_only). */
  source_authorization: z.record(TaskAuthorization).default({}),
}).superRefine((policy, ctx) => {
  // Reject unknown source keys. z.record validates the values but leaves keys
  // open, so a typo like `task_quee` used to be accepted and then silently never
  // matched at lookup — the task would fall through to default_authorization
  // with no signal. Fail-closed: a misconfigured policy must error loudly.
  const known = new Set<string>(DISCOVERY_SOURCE_KEYS);
  for (const key of Object.keys(policy.source_authorization)) {
    if (!known.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source_authorization", key],
        message: `unknown discovery source "${key}"; valid sources: ${DISCOVERY_SOURCE_KEYS.join(", ")}`,
      });
    }
  }
});
export type DiscoveryPolicy = z.infer<typeof DiscoveryPolicy>;

/**
 * Conservative default: explicit task_queue work runs automatically (matching
 * legacy local behavior), git_diff discoveries are suggestions, and
 * github_branch discoveries wait for approval.
 */
export const DEFAULT_DISCOVERY_POLICY: DiscoveryPolicy = DiscoveryPolicy.parse({
  source_authorization: {
    task_queue: "auto_execute",
    manual: "auto_execute",
    git_diff: "suggest_only",
    github_branch: "needs_approval",
  },
});

export interface TaskAuthorizationDecision {
  authorization: TaskAuthorization;
  reason: string;
}

export function authorizeTask(task: Task, policy: DiscoveryPolicy): TaskAuthorizationDecision {
  const blockedCapability = policy.blocked_capabilities.find((entry) =>
    capabilityMatches(task.capability, entry)
  );
  if (blockedCapability !== undefined) {
    return {
      authorization: "blocked",
      reason: `capability ${task.capability} matches blocked capability ${blockedCapability}`,
    };
  }

  const blockedPath = findBlockedPath(task, policy.blocked_paths);
  if (blockedPath !== undefined) {
    return {
      authorization: "blocked",
      reason: `task context touches blocked path ${blockedPath}`,
    };
  }

  const autoCapability = policy.auto_execute_capabilities.find((entry) =>
    capabilityMatches(task.capability, entry)
  );
  const sourceAuthorization = policy.source_authorization[task.source];
  let authorization: TaskAuthorization;
  let reason: string;
  if (autoCapability !== undefined) {
    authorization = "auto_execute";
    reason = `capability ${task.capability} matches auto-execute capability ${autoCapability}`;
  } else if (sourceAuthorization !== undefined) {
    authorization = sourceAuthorization;
    reason = `source ${task.source} defaults to ${sourceAuthorization}`;
  } else {
    authorization = policy.default_authorization;
    reason = `policy default authorization is ${policy.default_authorization}`;
  }

  if (authorization === "auto_execute" && task.priority > policy.max_auto_priority) {
    return {
      authorization: "needs_approval",
      reason: `priority ${task.priority} exceeds max auto priority ${policy.max_auto_priority}`,
    };
  }

  return { authorization, reason };
}

function capabilityMatches(capability: string, entry: string): boolean {
  const normalized = entry.trim();
  if (normalized === "") return false;
  return capability === normalized || capability.startsWith(`${normalized}.`);
}

function findBlockedPath(task: Task, blockedPaths: readonly string[]): string | undefined {
  if (blockedPaths.length === 0) return undefined;
  const contextFiles = taskContextPaths(task);
  for (const blocked of blockedPaths) {
    const normalizedBlocked = normalizePath(blocked);
    if (normalizedBlocked === "") continue;
    const hit = contextFiles.find((file) =>
      file === normalizedBlocked || file.startsWith(`${normalizedBlocked}/`)
    );
    if (hit !== undefined) return blocked;
  }
  return undefined;
}

function taskContextPaths(task: Task): string[] {
  const context = task.context ?? {};
  const values = [
    context["file"],
    context["files"],
    context["target_paths"],
    context["targetPaths"],
  ];
  const paths: string[] = [];
  for (const value of values) {
    if (typeof value === "string") paths.push(value);
    if (Array.isArray(value)) {
      paths.push(...value.filter((item): item is string => typeof item === "string"));
    }
  }
  // Evaluation specs carry first-class path fields; a blocked path reachable
  // only through the evaluation harness must not bypass the guardrail.
  for (const spec of task.evaluation ?? []) {
    paths.push(...spec.target_paths, ...spec.forbidden_paths);
  }
  return paths.map(normalizePath).filter((path) => path !== "");
}

function normalizePath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    // Strip a leading slash so an absolute context path and a repo-relative
    // blocked path compare on the same footing (both become repo-relative).
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}
