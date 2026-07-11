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
});

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
