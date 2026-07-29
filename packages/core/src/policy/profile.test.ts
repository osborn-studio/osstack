import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PolicyProfile,
  RepoConfig,
  loadPolicyProfile,
  loadRepoConfig,
  profileBudgetToLoopBudget,
} from "./profile.js";

// The P-002 repo.yaml example from POLICY_PROFILE_V1, verbatim.
const REPO_YAML_EXAMPLE = `schema_version: 1
product: osborn-pa
domain: osbornpa.com
role: core_product          # core_product | tool | library | reference | archive
priority: 100               # 0-100
default_branch: main
verify_command: "pnpm test"
build_command: "pnpm -r build"
staging_command: ""         # optional
production_environment: ""  # optional, descriptive
`;

const REPO_YAML_V2_EXAMPLE = `schema_version: 2
product: example-web
role: core_product
default_branch: main
verify_command: pnpm test
autonomy:
  max_auto_risk: R2
  require_independent_evaluator: true
  max_builder_iterations: 3
  max_review_rounds: 3
  max_wall_time_minutes: 90
  max_no_progress_rounds: 2
git:
  remote: origin
  branch_prefix: osstack
  merge_strategy: squash
  auto_merge: true
  protected_branches: [main]
verification:
  quick: [pnpm lint, pnpm test -- --changed]
  standard: [pnpm lint, pnpm typecheck, pnpm test, pnpm build]
  release: [pnpm lint, pnpm typecheck, pnpm test, pnpm build]
`;

// The P-003 policy.yaml example from POLICY_PROFILE_V1, verbatim.
const POLICY_YAML_EXAMPLE = `schema_version: 1
mode: propose               # observe | propose | execute
auto_apply: false
allowed_auto_changes:
  - docs
  - tests
  - lint
requires_approval:
  - product_scope
  - source
  - dependencies
  - ci
  - database_migrations
  - production_deploy
forbidden:
  - secrets
  - destructive_git
  - unreviewed_external_actions
budgets:
  max_iterations: 5
  max_runtime_minutes: 45
  max_cost_usd: 20
`;

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-policy-profile-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeOsstackFile(name: string, contents: string): Promise<void> {
  await mkdir(join(tmp, ".osstack"), { recursive: true });
  await writeFile(join(tmp, ".osstack", name), contents, "utf8");
}

describe("RepoConfig schema", () => {
  it("accepts the P-002 repo.yaml example", () => {
    const result = RepoConfig.safeParse(parseYaml(REPO_YAML_EXAMPLE));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.product).toBe("osborn-pa");
      expect(result.data.role).toBe("core_product");
      expect(result.data.priority).toBe(100);
    }
  });

  it("rejects an unknown top-level key (strict)", () => {
    const result = RepoConfig.safeParse({
      schema_version: 1,
      product: "p",
      role: "tool",
      default_branch: "main",
      verify_command: "pnpm test",
      unexpected: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid role", () => {
    const result = RepoConfig.safeParse({
      schema_version: 1,
      product: "p",
      role: "not_a_role",
      default_branch: "main",
      verify_command: "pnpm test",
    });
    expect(result.success).toBe(false);
  });

  it("accepts the exact guarded repository v2 example without breaking v1", () => {
    expect(RepoConfig.safeParse(parseYaml(REPO_YAML_EXAMPLE)).success).toBe(true);
    const result = RepoConfig.safeParse(parseYaml(REPO_YAML_V2_EXAMPLE));
    expect(result.success).toBe(true);
    if (result.success && result.data.schema_version === 2) {
      expect(result.data.autonomy.max_auto_risk).toBe("R2");
      expect(result.data.git).toMatchObject({
        remote: "origin",
        branch_prefix: "osstack",
        protected_branches: ["main"],
      });
      expect(result.data.verification.standard).toEqual([
        "pnpm lint",
        "pnpm typecheck",
        "pnpm test",
        "pnpm build",
      ]);
    }
  });

  it.each([
    ["autonomy", { max_builder_iterations_typo: 3 }],
    ["git", { force_push: true }],
    ["verification", { nightly: ["pnpm test"] }],
  ])("rejects unknown keys inside v2 %s policy", (section, extra) => {
    const input = parseYaml(REPO_YAML_V2_EXAMPLE) as Record<string, unknown>;
    input[section] = { ...(input[section] as object), ...extra };
    expect(RepoConfig.safeParse(input).success).toBe(false);
  });

  it("rejects unknown keys in nested deploy targets and freeze windows", () => {
    const input = v2RepoConfig({
      deploy: {
        staging: {
          ...deployTarget(),
          freeze_windows: [
            {
              timezone: "America/Los_Angeles",
              days: [1],
              start: "10:00",
              end: "11:00",
              unexpected: true,
            },
          ],
        },
      },
    });
    expect(RepoConfig.safeParse(input).success).toBe(false);

    const targetExtra = v2RepoConfig({
      deploy: {
        staging: {
          ...deployTarget(),
          unexpected: true,
        },
      },
    });
    expect(RepoConfig.safeParse(targetExtra).success).toBe(false);
  });

  it("accepts IANA deployment timezones and rejects unknown zones", () => {
    expect(
      RepoConfig.safeParse(
        v2RepoConfig({
          deploy: {
            production: {
              ...deployTarget(),
              freeze_windows: [
                {
                  timezone: "America/Los_Angeles",
                  days: [1],
                  start: "23:00",
                  end: "02:00",
                },
              ],
            },
          },
        }),
      ).success,
    ).toBe(true);

    expect(
      RepoConfig.safeParse(
        v2RepoConfig({
          deploy: {
            production: {
              ...deployTarget(),
              freeze_windows: [
                {
                  timezone: "Mars/Olympus_Mons",
                  days: [1],
                  start: "23:00",
                  end: "02:00",
                },
              ],
            },
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("allows only R1 or R2 as max_auto_risk", () => {
    for (const level of ["R1", "R2"]) {
      expect(
        RepoConfig.safeParse(
          v2RepoConfig({
            autonomy: { ...v2RepoConfig().autonomy, max_auto_risk: level },
          }),
        ).success,
      ).toBe(true);
    }
    for (const level of ["R0", "R3", "R4"]) {
      expect(
        RepoConfig.safeParse(
          v2RepoConfig({
            autonomy: { ...v2RepoConfig().autonomy, max_auto_risk: level },
          }),
        ).success,
      ).toBe(false);
    }
  });

  it.each([
    ["top-level command", { verify_command: "TOKEN=ghp_not-a-real-token pnpm test" }],
    ["authenticated remote", { git: { ...v2RepoConfig().git, remote: "https://u:p@host/repo" } }],
    [
      "verification header",
      {
        verification: {
          ...v2RepoConfig().verification,
          standard: ["Authorization: Bearer not-a-real-token"],
        },
      },
    ],
    [
      "deploy argv",
      {
        deploy: {
          staging: {
            ...deployTarget(),
            command: ["deploy", "--password=not-a-real-password"],
          },
        },
      },
    ],
  ])("rejects credential-shaped strings in %s", (_label, patch) => {
    expect(RepoConfig.safeParse(v2RepoConfig(patch)).success).toBe(false);
  });

  it("rejects an empty branch prefix or one equal to a protected branch", () => {
    expect(
      RepoConfig.safeParse(
        v2RepoConfig({ git: { ...v2RepoConfig().git, branch_prefix: "" } }),
      ).success,
    ).toBe(false);
    expect(
      RepoConfig.safeParse(
        v2RepoConfig({ git: { ...v2RepoConfig().git, branch_prefix: "main" } }),
      ).success,
    ).toBe(false);
  });

  it("rejects an empty standard verification profile", () => {
    expect(
      RepoConfig.safeParse(
        v2RepoConfig({
          verification: { ...v2RepoConfig().verification, standard: [] },
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects overlapping deploy allow/forbid paths and open change-type values", () => {
    expect(
      RepoConfig.safeParse(
        v2RepoConfig({
          deploy: {
            staging: {
              ...deployTarget(),
              allowed_paths: ["src/**"],
              forbidden_paths: ["src/**"],
            },
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      RepoConfig.safeParse(
        v2RepoConfig({
          deploy: {
            staging: {
              ...deployTarget(),
              allowed_change_types: ["frontend-copy"],
            },
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      RepoConfig.safeParse(
        v2RepoConfig({
          deploy: {
            staging: {
              ...deployTarget(),
              allowed_change_types: ["secrets"],
            },
          },
        }),
      ).success,
    ).toBe(false);
  });
});

function v2RepoConfig(patch: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    product: "example-web",
    role: "core_product",
    default_branch: "main",
    verify_command: "pnpm test",
    autonomy: {
      max_auto_risk: "R2",
      require_independent_evaluator: true,
      max_builder_iterations: 3,
      max_review_rounds: 3,
      max_wall_time_minutes: 90,
      max_no_progress_rounds: 2,
    },
    git: {
      remote: "origin",
      branch_prefix: "osstack",
      merge_strategy: "squash",
      auto_merge: true,
      protected_branches: ["main"],
    },
    verification: {
      quick: ["pnpm lint"],
      standard: ["pnpm lint", "pnpm typecheck", "pnpm test", "pnpm build"],
      release: ["pnpm lint", "pnpm typecheck", "pnpm test", "pnpm build"],
    },
    ...patch,
  };
}

function deployTarget() {
  return {
    enabled: true,
    command: ["scripts/deploy.sh"],
    verify_command: ["scripts/verify.sh"],
    health_check: ["scripts/health.sh"],
    rollback: ["scripts/rollback.sh"],
    timeout_ms: 60_000,
    health_timeout_ms: 30_000,
    allowed_change_types: ["source"],
    allowed_paths: ["src/**"],
    forbidden_paths: ["src/secrets/**"],
    allowed_base_branches: ["main"],
    freeze_windows: [],
  };
}

describe("PolicyProfile schema", () => {
  it("accepts the P-003 policy.yaml example", () => {
    const result = PolicyProfile.safeParse(parseYaml(POLICY_YAML_EXAMPLE));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBe("propose");
      expect(result.data.auto_apply).toBe(false);
      expect(result.data.allowed_auto_changes).toEqual(["docs", "tests", "lint"]);
      expect(result.data.forbidden).toEqual([
        "secrets",
        "destructive_git",
        "unreviewed_external_actions",
      ]);
      expect(result.data.budgets).toEqual({
        max_iterations: 5,
        max_runtime_minutes: 45,
        max_cost_usd: 20,
      });
    }
  });

  it("defaults auto_apply to false when omitted", () => {
    const result = PolicyProfile.safeParse({ schema_version: 1, mode: "observe" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.auto_apply).toBe(false);
  });

  it("rejects a typo'd category (closed vocabulary)", () => {
    const result = PolicyProfile.safeParse({
      schema_version: 1,
      mode: "propose",
      allowed_auto_changes: ["doc"], // should be "docs"
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown top-level key (strict)", () => {
    const result = PolicyProfile.safeParse({
      schema_version: 1,
      mode: "propose",
      extra: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key inside budgets (strict at every nesting level)", () => {
    const result = PolicyProfile.safeParse({
      schema_version: 1,
      mode: "propose",
      budgets: { max_iterations: 5, max_seconds: 10 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects budgets.max_cost_usd of 0 (exclusive minimum)", () => {
    const result = PolicyProfile.safeParse({
      schema_version: 1,
      mode: "propose",
      budgets: { max_cost_usd: 0 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a cross-list duplicate and names the category (P-003)", () => {
    const result = PolicyProfile.safeParse({
      schema_version: 1,
      mode: "propose",
      allowed_auto_changes: ["docs", "source"],
      requires_approval: ["source"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join("; ");
      expect(message).toContain("source");
      expect(message).toMatch(/more than one list/);
    }
  });

  it("rejects a within-list duplicate category (uniqueItems)", () => {
    const result = PolicyProfile.safeParse({
      schema_version: 1,
      mode: "propose",
      forbidden: ["secrets", "secrets"],
    });
    expect(result.success).toBe(false);
  });
});

describe("profileBudgetToLoopBudget", () => {
  it("maps budgets per the P-003 table (45min -> 2_700_000ms)", () => {
    const profile = PolicyProfile.parse({
      schema_version: 1,
      mode: "propose",
      budgets: { max_iterations: 5, max_runtime_minutes: 45, max_cost_usd: 20 },
    });
    expect(profileBudgetToLoopBudget(profile)).toEqual({
      max_task_iterations: 5,
      max_runtime_ms: 2_700_000,
      max_estimated_cost_usd: 20,
    });
  });

  it("returns an empty object when no budgets are declared", () => {
    const profile = PolicyProfile.parse({ schema_version: 1, mode: "observe" });
    expect(profileBudgetToLoopBudget(profile)).toEqual({});
  });
});

describe("loadRepoConfig / loadPolicyProfile", () => {
  it("returns undefined when files are absent (legacy mode)", async () => {
    await expect(loadRepoConfig(tmp)).resolves.toBeUndefined();
    await expect(loadPolicyProfile(tmp)).resolves.toBeUndefined();
  });

  it("loads a valid repo.yaml and policy.yaml from .osstack/", async () => {
    await writeOsstackFile("repo.yaml", REPO_YAML_EXAMPLE);
    await writeOsstackFile("policy.yaml", POLICY_YAML_EXAMPLE);
    const repo = await loadRepoConfig(tmp);
    const policy = await loadPolicyProfile(tmp);
    expect(repo?.product).toBe("osborn-pa");
    expect(policy?.mode).toBe("propose");
  });

  it("loads a valid v2 repo.yaml from .osstack/", async () => {
    await writeOsstackFile("repo.yaml", REPO_YAML_V2_EXAMPLE);
    const repo = await loadRepoConfig(tmp);
    expect(repo?.schema_version).toBe(2);
    if (repo?.schema_version === 2) {
      expect(repo.autonomy.max_auto_risk).toBe("R2");
    }
  });

  it("throws with the file path and issue list when policy.yaml is schema-invalid (fail-closed)", async () => {
    await writeOsstackFile("policy.yaml", "schema_version: 1\nmode: propose\nallowed_auto_changes:\n  - doc\n");
    await expect(loadPolicyProfile(tmp)).rejects.toThrow(/\.osstack\/policy\.yaml/);
    await expect(loadPolicyProfile(tmp)).rejects.toThrow(/allowed_auto_changes/);
  });

  it("throws with the file path when policy.yaml is not valid YAML", async () => {
    await writeOsstackFile("policy.yaml", "mode: [unterminated\n");
    await expect(loadPolicyProfile(tmp)).rejects.toThrow(/\.osstack\/policy\.yaml/);
  });

  it("throws (fail-closed) for an empty (0-byte) policy.yaml instead of returning undefined", async () => {
    await writeOsstackFile("policy.yaml", "");
    await expect(loadPolicyProfile(tmp)).rejects.toThrow(/\.osstack\/policy\.yaml/);
  });

  it("throws when repo.yaml has an unknown key (fail-closed)", async () => {
    await writeOsstackFile(
      "repo.yaml",
      "schema_version: 1\nproduct: p\nrole: tool\ndefault_branch: main\nverify_command: pnpm test\nbogus: 1\n",
    );
    await expect(loadRepoConfig(tmp)).rejects.toThrow(/\.osstack\/repo\.yaml/);
  });
});
