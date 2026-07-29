import type {
  DeployChangeType,
  DeployTargetPolicy,
  FreezeWindow,
} from "@osstack/core";
import type { AutonomyRiskLevel } from "@osstack/protocol";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ROLLBACK_DRILL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export interface DeployDiffStats {
  additions: number;
  deletions: number;
  files_changed: number;
}

export interface DerivedDeployChangeTypes {
  change_types: DeployChangeType[];
  unknown_paths: string[];
}

export interface RollbackDrillEvidence {
  passed_at: string;
  deploy_script_digest_sha256: string;
  post_rollback_health_passed: boolean;
}

export interface DeployEligibilityInput {
  target: "staging" | "production";
  base_branch: string;
  changed_paths: string[];
  diff_stats: DeployDiffStats;
  final_risk: AutonomyRiskLevel;
  deterministic_pass: boolean;
  kimi_pass: boolean;
  governance_pass: boolean;
  ci_pass: boolean;
  candidate_proof_sha256: string;
  deploy_script_digest_sha256: string;
  production_frozen: boolean;
  rollback_drill?: RollbackDrillEvidence;
  now: Date;
}

export interface DeployEligibilityDecision {
  allowed: boolean;
  reasons: string[];
  requires_approval: boolean;
  change_types: DeployChangeType[];
  unknown_paths: string[];
}

function normalizeChangedPath(value: string): string | undefined {
  const normalized = value.startsWith("./") ? value.slice(2) : value;
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0")
  ) {
    return undefined;
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return undefined;
  }
  return normalized;
}

function hasPathPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function classifyChangedPath(path: string): DeployChangeType | undefined {
  const name = basename(path).toLowerCase();
  const lower = path.toLowerCase();

  if (
    hasPathPrefix(lower, ".github/workflows") ||
    hasPathPrefix(lower, ".github/actions") ||
    name === "azure-pipelines.yml" ||
    name === ".gitlab-ci.yml"
  ) {
    return "ci";
  }
  if (
    hasPathPrefix(lower, "migrations") ||
    lower.includes("/migrations/") ||
    hasPathPrefix(lower, "prisma/migrations")
  ) {
    return "database_migrations";
  }
  if (
    name === "package.json" ||
    name === "pnpm-lock.yaml" ||
    name === "package-lock.json" ||
    name === "yarn.lock" ||
    name === "bun.lock" ||
    name === "bun.lockb"
  ) {
    return "dependencies";
  }
  if (
    name === "biome.json" ||
    name === "biome.jsonc" ||
    name.startsWith(".eslintrc") ||
    name.startsWith("eslint.config.") ||
    name.startsWith(".prettierrc") ||
    name === "prettier.config.js"
  ) {
    return "lint";
  }
  if (
    name === "dockerfile" ||
    name.startsWith("docker-compose.") ||
    hasPathPrefix(lower, "deploy") ||
    hasPathPrefix(lower, "infra") ||
    hasPathPrefix(lower, "config/production")
  ) {
    return "production_config";
  }
  if (
    hasPathPrefix(lower, "test") ||
    hasPathPrefix(lower, "tests") ||
    lower.includes("/__tests__/") ||
    /\.(?:test|spec)\.[^.]+$/i.test(name)
  ) {
    return "tests";
  }
  if (
    hasPathPrefix(lower, "docs") ||
    name === "readme" ||
    name.startsWith("readme.") ||
    /\.(?:md|mdx|rst)$/i.test(name)
  ) {
    return "docs";
  }
  if (
    hasPathPrefix(lower, "src") ||
    lower.includes("/src/") ||
    hasPathPrefix(lower, "packages") && lower.includes("/src/")
  ) {
    return "source";
  }
  if (hasPathPrefix(lower, "product")) return "product_scope";
  return undefined;
}

function validateDiffStats(
  changedPaths: readonly string[],
  diffStats: DeployDiffStats,
): void {
  for (const [name, value] of Object.entries(diffStats)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`invalid deploy diff stat ${name}`);
    }
  }
  if (diffStats.files_changed !== changedPaths.length) {
    throw new Error("deploy diff stat files_changed does not match changed paths");
  }
  if (new Set(changedPaths).size !== changedPaths.length) {
    throw new Error("deploy changed paths must not contain duplicates");
  }
}

export function deriveChangeTypes(
  changedPaths: readonly string[],
  diffStats: DeployDiffStats,
): DerivedDeployChangeTypes {
  validateDiffStats(changedPaths, diffStats);
  const changeTypes = new Set<DeployChangeType>();
  const unknownPaths = new Set<string>();

  for (const rawPath of changedPaths) {
    const path = normalizeChangedPath(rawPath);
    if (path === undefined) {
      unknownPaths.add(rawPath);
      continue;
    }
    const changeType = classifyChangedPath(path);
    if (changeType === undefined) unknownPaths.add(path);
    else changeTypes.add(changeType);
  }

  return {
    change_types: [...changeTypes].sort(),
    unknown_paths: [...unknownPaths].sort(),
  };
}

function policyPathMatches(pattern: string, rawPath: string): boolean {
  const path = normalizeChangedPath(rawPath);
  const normalizedPattern = normalizeChangedPath(
    pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern,
  );
  if (path === undefined || normalizedPattern === undefined) return false;
  return hasPathPrefix(path, normalizedPattern);
}

const WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function clockMinutes(value: string): number {
  const [hours = "0", minutes = "0"] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function localDayAndMinutes(
  now: Date,
  timezone: string,
): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const day = weekday === undefined ? undefined : WEEKDAYS[weekday];
  if (day === undefined || hour === undefined || minute === undefined) {
    throw new Error("failed to resolve deployment freeze-window clock");
  }
  return {
    day,
    minutes: Number(hour) * 60 + Number(minute),
  };
}

function freezeWindowActive(window: FreezeWindow, now: Date): boolean {
  try {
    const local = localDayAndMinutes(now, window.timezone);
    const start = clockMinutes(window.start);
    const end = clockMinutes(window.end);
    if (start < end) {
      return (
        window.days.includes(local.day) &&
        local.minutes >= start &&
        local.minutes < end
      );
    }

    // Equal endpoints intentionally mean a 24-hour window beginning on each
    // listed day. A start later than end carries into the following local day.
    const previousDay = (local.day + 6) % 7;
    return (
      (window.days.includes(local.day) && local.minutes >= start) ||
      (window.days.includes(previousDay) && local.minutes < end)
    );
  } catch {
    return true;
  }
}

function addReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function evaluateRollbackDrill(
  input: DeployEligibilityInput,
  reasons: string[],
): void {
  const drill = input.rollback_drill;
  if (drill === undefined) {
    addReason(reasons, "rollback_drill_missing");
    return;
  }
  if (!drill.post_rollback_health_passed) {
    addReason(reasons, "rollback_drill_failed");
  }
  const passedAt = Date.parse(drill.passed_at);
  const age = input.now.getTime() - passedAt;
  if (
    !Number.isFinite(passedAt) ||
    age < -MAX_FUTURE_CLOCK_SKEW_MS
  ) {
    addReason(reasons, "rollback_drill_timestamp_invalid");
  } else if (age > ROLLBACK_DRILL_MAX_AGE_MS) {
    addReason(reasons, "rollback_drill_stale");
  }
  if (
    drill.deploy_script_digest_sha256 !==
    input.deploy_script_digest_sha256
  ) {
    addReason(reasons, "rollback_drill_digest_mismatch");
  }
}

export function evaluateDeployEligibility(
  policy: DeployTargetPolicy,
  input: DeployEligibilityInput,
): DeployEligibilityDecision {
  const reasons: string[] = [];
  if (!Number.isFinite(input.now.getTime())) {
    addReason(reasons, "evaluation_clock_invalid");
  }
  let derived: DerivedDeployChangeTypes;
  try {
    derived = deriveChangeTypes(input.changed_paths, input.diff_stats);
  } catch {
    derived = { change_types: [], unknown_paths: [...input.changed_paths].sort() };
    addReason(reasons, "diff_stats_invalid");
  }

  if (!policy.enabled) addReason(reasons, "target_disabled");
  if (!policy.allowed_base_branches.includes(input.base_branch)) {
    addReason(reasons, `base_branch_not_allowed:${input.base_branch}`);
  }

  let forbiddenPath = false;
  for (const path of [...input.changed_paths].sort()) {
    if (!policy.allowed_paths.some((pattern) => policyPathMatches(pattern, path))) {
      addReason(reasons, `path_not_allowed:${path}`);
    }
    if (policy.forbidden_paths.some((pattern) => policyPathMatches(pattern, path))) {
      forbiddenPath = true;
      addReason(reasons, `forbidden_path:${path}`);
    }
  }
  for (const changeType of derived.change_types) {
    if (!policy.allowed_change_types.includes(changeType)) {
      addReason(reasons, `change_type_not_allowed:${changeType}`);
    }
  }
  for (const path of derived.unknown_paths) {
    addReason(reasons, `unknown_change_type:${path}`);
  }
  if (derived.change_types.length === 0) {
    addReason(reasons, "no_deployable_change_types");
  }

  if (input.final_risk === "R3") {
    addReason(reasons, "risk_r3_requires_approval");
  } else if (input.final_risk === "R4") {
    addReason(reasons, "risk_r4_forbidden");
  }

  if (!input.deterministic_pass) {
    addReason(reasons, "deterministic_verification_failed");
  }
  if (!input.kimi_pass) addReason(reasons, "kimi_verification_failed");
  if (!input.governance_pass) {
    addReason(reasons, "governance_verification_failed");
  }
  if (!input.ci_pass) addReason(reasons, "ci_verification_failed");
  if (!SHA256_PATTERN.test(input.candidate_proof_sha256)) {
    addReason(reasons, "candidate_proof_digest_invalid");
  }
  if (!SHA256_PATTERN.test(input.deploy_script_digest_sha256)) {
    addReason(reasons, "deploy_script_digest_invalid");
  }

  if (input.target === "production") {
    if (input.production_frozen) addReason(reasons, "production_frozen");
    if (policy.freeze_windows.some((window) => freezeWindowActive(window, input.now))) {
      addReason(reasons, "production_freeze_window_active");
    }
    evaluateRollbackDrill(input, reasons);
  }

  const requiresApproval =
    input.final_risk !== "R4" &&
    (input.final_risk === "R3" || forbiddenPath);
  return {
    allowed: reasons.length === 0,
    reasons,
    requires_approval: requiresApproval,
    change_types: derived.change_types,
    unknown_paths: derived.unknown_paths,
  };
}
