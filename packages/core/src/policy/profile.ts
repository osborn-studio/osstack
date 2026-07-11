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

export const RepoConfig = z
  .object({
    schema_version: z.literal(1),
    product: z.string().min(1),
    domain: z.string().min(1).optional(),
    role: RepoConfigRole,
    priority: z.number().min(0).max(100).optional(),
    default_branch: z.string().min(1),
    verify_command: z.string().min(1),
    build_command: z.string().optional(),
    staging_command: z.string().optional(),
    production_environment: z.string().optional(),
  })
  .strict();
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
