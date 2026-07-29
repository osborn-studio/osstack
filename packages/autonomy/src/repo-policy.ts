import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AutonomyRepoPolicy,
  DeployChangeType,
  DeployEnvironmentName,
  FreezeWindow,
  type DeployRepoPolicy,
  type DeployTargetPolicy,
} from "@osstack/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\b(?:authorization)\s*:\s*bearer\s+\S+/i,
  /(?:^|[\s"'`])(?:[a-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)[a-z0-9_-]*)\s*(?:=|:)\s*\S+/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_-]{20,}\b/,
] as const;

const PrivatePolicyString = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, {
    message: "private policy strings must not have surrounding whitespace",
  })
  .refine(
    (value) => !CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value)),
    { message: "private policy must not contain credential-shaped values" },
  );

const PrivatePolicyPath = PrivatePolicyString.refine(
  (value) => {
    try {
      normalizePolicyPath(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: "private policy path must be a safe repository-relative prefix" },
);

function uniquePrivateStringList(minimum = 0) {
  return z
    .array(PrivatePolicyString)
    .min(minimum)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "private policy lists must not contain duplicates",
        });
      }
    });
}

function uniquePrivatePathList(minimum = 0) {
  return z
    .array(PrivatePolicyPath)
    .min(minimum)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "private policy path lists must not contain duplicates",
        });
      }
    });
}

const PrivateDeployChangeTypes = z
  .array(DeployChangeType)
  .min(1)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "allowed_change_types must not contain duplicates",
      });
    }
  });

const PrivateDeployEnvironment = z
  .array(DeployEnvironmentName)
  .max(64)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "allowed_environment must not contain duplicates",
      });
    }
  });

const PrivateAutonomyOverlay = AutonomyRepoPolicy.partial().strict();

const PrivateDeployTargetOverlay = z
  .object({
    enabled: z.boolean().optional(),
    timeout_ms: z.number().int().min(1_000).max(1_800_000).optional(),
    health_timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
    allowed_change_types: PrivateDeployChangeTypes.optional(),
    allowed_paths: uniquePrivatePathList(1).optional(),
    forbidden_paths: uniquePrivatePathList().optional(),
    allowed_base_branches: uniquePrivateStringList(1).optional(),
    allowed_environment: PrivateDeployEnvironment.optional(),
    freeze_windows: z.array(FreezeWindow).optional(),
  })
  .strict();

const PrivateDeployOverlay = z
  .object({
    staging: PrivateDeployTargetOverlay.optional(),
    production: PrivateDeployTargetOverlay.optional(),
  })
  .strict();

export const PrivateRepoOverlay = z
  .object({
    schema_version: z.literal(1),
    autonomy: PrivateAutonomyOverlay.optional(),
    deploy: PrivateDeployOverlay.optional(),
  })
  .strict();
export type PrivateRepoOverlay = z.infer<typeof PrivateRepoOverlay>;

export interface RepositoryPolicyInput {
  autonomy: AutonomyRepoPolicy;
  deploy?: DeployRepoPolicy;
}

export interface EffectiveRepositoryPolicy {
  autonomy: AutonomyRepoPolicy;
  deploy?: DeployRepoPolicy;
}

function normalizePolicyPath(value: string): string {
  const normalized = value.startsWith("./") ? value.slice(2) : value;
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0")
  ) {
    throw new Error(`invalid repository policy path: ${value}`);
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment, index) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        (segment.includes("*") &&
          !(segment === "**" && index === segments.length - 1)),
    )
  ) {
    throw new Error(`invalid repository policy path: ${value}`);
  }
  return normalized;
}

function pathRoot(value: string): string {
  return value.endsWith("/**") ? value.slice(0, -3) : value;
}

function intersectPathPair(left: string, right: string): string | undefined {
  const normalizedLeft = normalizePolicyPath(left);
  const normalizedRight = normalizePolicyPath(right);
  const leftRoot = pathRoot(normalizedLeft);
  const rightRoot = pathRoot(normalizedRight);

  if (leftRoot === rightRoot) {
    if (normalizedLeft === normalizedRight) return normalizedLeft;
    return normalizedLeft.endsWith("/**") ? normalizedRight : normalizedLeft;
  }
  if (rightRoot.startsWith(`${leftRoot}/`)) return normalizedRight;
  if (leftRoot.startsWith(`${rightRoot}/`)) return normalizedLeft;
  return undefined;
}

export function intersectPolicyPaths(
  repositoryPaths: readonly string[],
  privatePaths: readonly string[],
): string[] {
  const intersections = new Set<string>();
  for (const repositoryPath of repositoryPaths) {
    for (const privatePath of privatePaths) {
      const intersection = intersectPathPair(repositoryPath, privatePath);
      if (intersection !== undefined) intersections.add(intersection);
    }
  }
  return [...intersections].sort();
}

function intersectStrings(
  repositoryValues: readonly string[],
  privateValues: readonly string[],
): string[] {
  const privateSet = new Set(privateValues);
  return [...new Set(repositoryValues.filter((value) => privateSet.has(value)))].sort();
}

function mergeFreezeWindows(
  repositoryWindows: DeployTargetPolicy["freeze_windows"],
  privateWindows: DeployTargetPolicy["freeze_windows"],
): DeployTargetPolicy["freeze_windows"] {
  const windows = new Map<string, DeployTargetPolicy["freeze_windows"][number]>();
  for (const window of [...repositoryWindows, ...privateWindows]) {
    const key = JSON.stringify({
      timezone: window.timezone,
      days: [...window.days].sort((left, right) => left - right),
      start: window.start,
      end: window.end,
    });
    windows.set(key, window);
  }
  return [...windows.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, window]) => window);
}

function mergeDeployTarget(
  repository: DeployTargetPolicy,
  overlay: z.infer<typeof PrivateDeployTargetOverlay>,
): DeployTargetPolicy {
  const allowedChangeTypes =
    overlay.allowed_change_types === undefined
      ? [...repository.allowed_change_types]
      : intersectStrings(
          repository.allowed_change_types,
          overlay.allowed_change_types,
        );
  const allowedPaths =
    overlay.allowed_paths === undefined
      ? repository.allowed_paths.map(normalizePolicyPath).sort()
      : intersectPolicyPaths(repository.allowed_paths, overlay.allowed_paths);
  const allowedBaseBranches =
    overlay.allowed_base_branches === undefined
      ? [...repository.allowed_base_branches].sort()
      : intersectStrings(
          repository.allowed_base_branches,
          overlay.allowed_base_branches,
        );
  const forbiddenPaths = [
    ...new Set(
      [
        ...repository.forbidden_paths,
        ...(overlay.forbidden_paths ?? []),
      ].map(normalizePolicyPath),
    ),
  ].sort();
  const allowedEnvironment =
    overlay.allowed_environment === undefined
      ? [...repository.allowed_environment].sort()
      : intersectStrings(
          repository.allowed_environment,
          overlay.allowed_environment,
        );
  const enabled =
    repository.enabled &&
    (overlay.enabled ?? true) &&
    allowedChangeTypes.length > 0 &&
    allowedPaths.length > 0 &&
    allowedBaseBranches.length > 0;

  return {
    enabled,
    command: [...repository.command],
    verify_command: [...repository.verify_command],
    health_check: [...repository.health_check],
    rollback: [...repository.rollback],
    timeout_ms: Math.min(
      repository.timeout_ms,
      overlay.timeout_ms ?? repository.timeout_ms,
    ),
    health_timeout_ms: Math.min(
      repository.health_timeout_ms,
      overlay.health_timeout_ms ?? repository.health_timeout_ms,
    ),
    allowed_change_types: allowedChangeTypes as DeployTargetPolicy["allowed_change_types"],
    allowed_paths: allowedPaths,
    forbidden_paths: forbiddenPaths,
    allowed_base_branches: allowedBaseBranches,
    allowed_environment: allowedEnvironment,
    freeze_windows: mergeFreezeWindows(
      repository.freeze_windows,
      overlay.freeze_windows ?? [],
    ),
  };
}

function lowerRisk(
  repository: AutonomyRepoPolicy["max_auto_risk"],
  overlay: AutonomyRepoPolicy["max_auto_risk"] | undefined,
): AutonomyRepoPolicy["max_auto_risk"] {
  if (overlay === "R1" || repository === "R1") return "R1";
  return "R2";
}

function mergeAutonomyPolicy(
  repository: AutonomyRepoPolicy,
  overlay: z.infer<typeof PrivateAutonomyOverlay> | undefined,
): AutonomyRepoPolicy {
  if (overlay === undefined) return { ...repository };
  return {
    max_auto_risk: lowerRisk(repository.max_auto_risk, overlay.max_auto_risk),
    require_independent_evaluator:
      repository.require_independent_evaluator ||
      (overlay.require_independent_evaluator ?? false),
    max_builder_iterations: Math.min(
      repository.max_builder_iterations,
      overlay.max_builder_iterations ?? repository.max_builder_iterations,
    ),
    max_review_rounds: Math.min(
      repository.max_review_rounds,
      overlay.max_review_rounds ?? repository.max_review_rounds,
    ),
    max_wall_time_minutes: Math.min(
      repository.max_wall_time_minutes,
      overlay.max_wall_time_minutes ?? repository.max_wall_time_minutes,
    ),
    max_no_progress_rounds: Math.min(
      repository.max_no_progress_rounds,
      overlay.max_no_progress_rounds ?? repository.max_no_progress_rounds,
    ),
  };
}

export function parsePrivateRepoOverlay(value: unknown): PrivateRepoOverlay {
  return PrivateRepoOverlay.parse(value);
}

export async function loadPrivateRepoOverlay(
  osstackHome: string,
  repoId: string,
): Promise<PrivateRepoOverlay | undefined> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(repoId) ||
    repoId === "." ||
    repoId === ".."
  ) {
    throw new Error(`invalid private policy repo id: ${repoId}`);
  }
  const path = join(osstackHome, "repos", `${repoId}.yaml`);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  return parsePrivateRepoOverlay(parseYaml(text));
}

export function mergeRepoPolicy(
  repository: RepositoryPolicyInput,
  overlay: PrivateRepoOverlay | undefined,
): EffectiveRepositoryPolicy {
  const deploy: DeployRepoPolicy = {};
  for (const target of ["staging", "production"] as const) {
    const repositoryTarget = repository.deploy?.[target];
    const privateTarget = overlay?.deploy?.[target];
    if (privateTarget !== undefined && repositoryTarget === undefined) {
      throw new Error(
        `private policy cannot introduce missing ${target} deploy target`,
      );
    }
    if (repositoryTarget !== undefined) {
      deploy[target] = mergeDeployTarget(repositoryTarget, privateTarget ?? {});
    }
  }

  return {
    autonomy: mergeAutonomyPolicy(repository.autonomy, overlay?.autonomy),
    ...(Object.keys(deploy).length === 0 ? {} : { deploy }),
  };
}
