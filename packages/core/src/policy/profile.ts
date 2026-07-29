// Policy Profile loader (POLICY_PROFILE_V1). The human-owned contract that
// bounds what osstack may do in a repository. It is git-tracked and enforced by
// the kernel gates — never by prompt text alone.
//
// Two files live under `.osstack/`:
//   repo.yaml   — identity and command contract (RepoConfig)
//   policy.yaml — authority and budgets (PolicyProfile)
//
// Fail-closed discipline (P-001): both schemas are `.strict()` at every nesting
// level so a typo'd key errors loudly instead of silently falling through to a
// default — the same discipline as DiscoveryPolicy in @osstack/loop. An ABSENT
// file means legacy mode (`undefined`); a PRESENT but unreadable / invalid-YAML
// / schema-invalid file throws (never degrades to a default).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ── Category vocabulary (P-005, v1 closed) ──────────────────────────────────
// CLOSED in v1: schemas MUST reject categories outside this list. Extending the
// vocabulary is a minor version bump of the spec plus a schema update — never an
// ad-hoc string.
export const POLICY_CHANGE_CATEGORIES = [
  "docs",
  "tests",
  "lint",
  "source",
  "dependencies",
  "ci",
  "database_migrations",
  "production_deploy",
  "production_config",
  "product_scope",
  "secrets",
  "destructive_git",
  "unreviewed_external_actions",
] as const;

export const PolicyChangeCategory = z.enum(POLICY_CHANGE_CATEGORIES);
export type PolicyChangeCategory = z.infer<typeof PolicyChangeCategory>;

// ── .osstack/repo.yaml — RepoConfig (P-002) ─────────────────────────────────
export const RepoConfigRole = z.enum([
  "core_product",
  "tool",
  "library",
  "reference",
  "archive",
]);
export type RepoConfigRole = z.infer<typeof RepoConfigRole>;

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\b(?:authorization)\s*:\s*bearer\s+\S+/i,
  /(?:^|[\s"'`])(?:[a-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)[a-z0-9_-]*)\s*(?:=|:)\s*\S+/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_-]{20,}\b/,
] as const;

function hasCredentialShape(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

const ConfigString = z.string().superRefine((value, context) => {
  if (hasCredentialShape(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "repository config must not contain credential-shaped values",
    });
  }
});

const NonEmptyConfigString = ConfigString.refine(
  (value) => value.length > 0 && value.trim() === value,
  "must be a non-empty string without surrounding whitespace",
);

function uniqueStringList(options: { min?: number } = {}) {
  const schema =
    options.min === undefined
      ? z.array(NonEmptyConfigString)
      : z.array(NonEmptyConfigString).min(options.min);
  return schema.superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "list must not contain duplicate values",
      });
    }
  });
}

const RepoConfigCommonV1 = {
  product: z.string().min(1),
  domain: z.string().min(1).optional(),
  role: RepoConfigRole,
  priority: z.number().min(0).max(100).optional(),
  default_branch: z.string().min(1),
  verify_command: z.string().min(1),
  build_command: z.string().optional(),
  staging_command: z.string().optional(),
  production_environment: z.string().optional(),
} as const;

const RepoConfigCommonV2 = {
  product: NonEmptyConfigString,
  domain: NonEmptyConfigString.optional(),
  role: RepoConfigRole,
  priority: z.number().min(0).max(100).optional(),
  default_branch: NonEmptyConfigString,
  verify_command: NonEmptyConfigString,
  build_command: ConfigString.optional(),
  staging_command: ConfigString.optional(),
  production_environment: ConfigString.optional(),
} as const;

export const RepoConfigV1 = z
  .object({
    schema_version: z.literal(1),
    ...RepoConfigCommonV1,
  })
  .strict();
export type RepoConfigV1 = z.infer<typeof RepoConfigV1>;

export const CommandArgv = z.array(NonEmptyConfigString).min(1).max(64);
export type CommandArgv = z.infer<typeof CommandArgv>;

export const AutonomyRepoPolicy = z
  .object({
    max_auto_risk: z.enum(["R1", "R2"]),
    require_independent_evaluator: z.boolean(),
    max_builder_iterations: z.number().int().min(1).max(10),
    max_review_rounds: z.number().int().min(1).max(10),
    max_wall_time_minutes: z.number().int().min(1).max(1_440),
    max_no_progress_rounds: z.number().int().min(1).max(5),
  })
  .strict();
export type AutonomyRepoPolicy = z.infer<typeof AutonomyRepoPolicy>;

export const GitRepoPolicy = z
  .object({
    remote: NonEmptyConfigString,
    branch_prefix: NonEmptyConfigString,
    merge_strategy: z.literal("squash"),
    auto_merge: z.boolean(),
    protected_branches: uniqueStringList({ min: 1 }),
  })
  .strict()
  .superRefine((git, context) => {
    if (git.protected_branches.includes(git.branch_prefix)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["branch_prefix"],
        message: "branch_prefix cannot equal a protected branch",
      });
    }
  });
export type GitRepoPolicy = z.infer<typeof GitRepoPolicy>;

export const VerificationProfiles = z
  .object({
    quick: uniqueStringList({ min: 1 }),
    standard: uniqueStringList({ min: 1 }),
    release: uniqueStringList({ min: 1 }),
  })
  .strict();
export type VerificationProfiles = z.infer<typeof VerificationProfiles>;

export const DEPLOY_CHANGE_TYPES = [
  "docs",
  "tests",
  "lint",
  "source",
  "dependencies",
  "ci",
  "database_migrations",
  "production_config",
  "product_scope",
] as const;

export const DeployChangeType = z.enum(DEPLOY_CHANGE_TYPES);
export type DeployChangeType = z.infer<typeof DeployChangeType>;

const ClockTime = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "time must use 24-hour HH:MM format");

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const IanaTimeZone = NonEmptyConfigString.refine(
  isIanaTimeZone,
  "timezone must be a valid IANA time zone",
);

export const FreezeWindow = z
  .object({
    timezone: IanaTimeZone,
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .superRefine((days, context) => {
        if (new Set(days).size !== days.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "freeze-window days must be unique",
          });
        }
      }),
    start: ClockTime,
    end: ClockTime,
  })
  .strict();
export type FreezeWindow = z.infer<typeof FreezeWindow>;

export const DeployTargetPolicy = z
  .object({
    enabled: z.boolean(),
    command: CommandArgv,
    verify_command: CommandArgv,
    health_check: CommandArgv,
    rollback: CommandArgv,
    timeout_ms: z.number().int().min(1_000).max(1_800_000),
    health_timeout_ms: z.number().int().min(1_000).max(600_000),
    allowed_change_types: z
      .array(DeployChangeType)
      .min(1)
      .superRefine((types, context) => {
        if (new Set(types).size !== types.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "allowed_change_types must not contain duplicates",
          });
        }
      }),
    allowed_paths: uniqueStringList({ min: 1 }),
    forbidden_paths: uniqueStringList().default([]),
    allowed_base_branches: uniqueStringList({ min: 1 }),
    freeze_windows: z.array(FreezeWindow).default([]),
  })
  .strict()
  .superRefine((target, context) => {
    const forbidden = new Set(target.forbidden_paths);
    for (const path of target.allowed_paths) {
      if (!forbidden.has(path)) continue;
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowed_paths"],
        message: `path "${path}" cannot be both allowed and forbidden`,
      });
    }
  });
export type DeployTargetPolicy = z.infer<typeof DeployTargetPolicy>;

export const DeployRepoPolicy = z
  .object({
    staging: DeployTargetPolicy.optional(),
    production: DeployTargetPolicy.optional(),
  })
  .strict();
export type DeployRepoPolicy = z.infer<typeof DeployRepoPolicy>;

export const RepoConfigV2 = z
  .object({
    schema_version: z.literal(2),
    ...RepoConfigCommonV2,
    autonomy: AutonomyRepoPolicy,
    git: GitRepoPolicy,
    verification: VerificationProfiles,
    deploy: DeployRepoPolicy.optional(),
  })
  .strict();
export type RepoConfigV2 = z.infer<typeof RepoConfigV2>;

export const RepoConfig = z.discriminatedUnion("schema_version", [
  RepoConfigV1,
  RepoConfigV2,
]);
export type RepoConfig = z.infer<typeof RepoConfig>;

// ── .osstack/policy.yaml — PolicyProfile (P-003) ────────────────────────────
export const PolicyMode = z.enum(["observe", "propose", "execute"]);
export type PolicyMode = z.infer<typeof PolicyMode>;

export const PolicyBudgets = z
  .object({
    max_iterations: z.number().int().min(1).optional(),
    max_runtime_minutes: z.number().int().min(1).optional(),
    // exclusiveMinimum 0 in the JSON schema.
    max_cost_usd: z.number().positive().optional(),
  })
  .strict();
export type PolicyBudgets = z.infer<typeof PolicyBudgets>;

const categoryList = z.array(PolicyChangeCategory);

export const PolicyProfile = z
  .object({
    schema_version: z.literal(1),
    mode: PolicyMode,
    auto_apply: z.boolean().default(false),
    allowed_auto_changes: categoryList.optional(),
    requires_approval: categoryList.optional(),
    forbidden: categoryList.optional(),
    budgets: PolicyBudgets.optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    // P-003: a category MUST NOT appear in more than one of the three lists,
    // and (matching the schema's uniqueItems) MUST NOT repeat within a list.
    // The resolution order would keep runtime safe, but a fail-closed spec does
    // not rely on precedence to mask a contradiction.
    const appearances = new Map<string, string[]>();
    const lists: Array<[string, readonly string[] | undefined]> = [
      ["allowed_auto_changes", profile.allowed_auto_changes],
      ["requires_approval", profile.requires_approval],
      ["forbidden", profile.forbidden],
    ];
    for (const [listName, values] of lists) {
      for (const category of values ?? []) {
        const where = appearances.get(category) ?? [];
        where.push(listName);
        appearances.set(category, where);
      }
    }
    for (const [category, where] of appearances) {
      if (where.length <= 1) continue;
      const distinctLists = [...new Set(where)];
      const message =
        distinctLists.length > 1
          ? `category "${category}" appears in more than one list (${distinctLists.join(", ")}); each category must appear in at most one of allowed_auto_changes, requires_approval, forbidden`
          : `category "${category}" is listed more than once in ${distinctLists[0]}`;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [distinctLists[0]!],
        message,
      });
    }
  });
export type PolicyProfile = z.infer<typeof PolicyProfile>;

// ── Budget mapping (P-003 table) ────────────────────────────────────────────
/**
 * LoopBudget-shaped subset produced by {@link profileBudgetToLoopBudget}. Kept
 * as a LOCAL interface (not imported from @osstack/loop) so core does not depend
 * on loop; `@osstack/loop`'s `LoopBudget.parse` accepts this shape structurally.
 */
export interface LoopBudgetFromProfile {
  max_task_iterations?: number;
  max_runtime_ms?: number;
  max_estimated_cost_usd?: number;
}

/**
 * Map policy.yaml budgets onto the loop budget primitives, per the P-003 table:
 *   max_iterations       -> max_task_iterations
 *   max_runtime_minutes  -> max_runtime_ms (×60000)
 *   max_cost_usd         -> max_estimated_cost_usd
 *
 * Honesty note (P-003): `max_cost_usd` maps to `max_estimated_cost_usd`, which
 * enforces only against *adapter-reported* usage. Adapters that report nothing
 * (e.g. local commands) contribute 0, so the cost cap is NOT a guarantee for
 * runs without usage reporting — pair it with `max_runtime_minutes`, which
 * always enforces via wall clock.
 */
export function profileBudgetToLoopBudget(profile: PolicyProfile): LoopBudgetFromProfile {
  const budgets = profile.budgets;
  const out: LoopBudgetFromProfile = {};
  if (budgets?.max_iterations !== undefined) out.max_task_iterations = budgets.max_iterations;
  if (budgets?.max_runtime_minutes !== undefined) {
    out.max_runtime_ms = budgets.max_runtime_minutes * 60_000;
  }
  if (budgets?.max_cost_usd !== undefined) out.max_estimated_cost_usd = budgets.max_cost_usd;
  return out;
}

// ── Loaders (P-001 fail-closed) ─────────────────────────────────────────────
const POLICY_DIR = ".osstack";
const REPO_CONFIG_FILE = "repo.yaml";
const POLICY_PROFILE_FILE = "policy.yaml";

/**
 * Load `.osstack/repo.yaml` for a repo. Returns `undefined` when the file is
 * absent (legacy repos), throws with the file path + issue list when the file
 * is present but unreadable, invalid YAML, or schema-invalid (fail-closed).
 */
export async function loadRepoConfig(repoPath: string): Promise<RepoConfig | undefined> {
  return loadProfileFile(join(repoPath, POLICY_DIR, REPO_CONFIG_FILE), RepoConfig, "repo config");
}

/**
 * Load `.osstack/policy.yaml` for a repo. Returns `undefined` when the file is
 * absent (legacy repos), throws with the file path + issue list when the file
 * is present but unreadable, invalid YAML, or schema-invalid (fail-closed).
 */
export async function loadPolicyProfile(repoPath: string): Promise<PolicyProfile | undefined> {
  return loadProfileFile(
    join(repoPath, POLICY_DIR, POLICY_PROFILE_FILE),
    PolicyProfile,
    "policy profile",
  );
}

async function loadProfileFile<Schema extends z.ZodTypeAny>(
  filePath: string,
  schema: Schema,
  label: string,
): Promise<z.infer<Schema> | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    // Absent file (or absent .osstack dir) => legacy mode, not an error.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `failed to read ${label} at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `invalid YAML in ${label} at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid ${label} at ${filePath}: ${issues}`);
  }
  return result.data;
}
