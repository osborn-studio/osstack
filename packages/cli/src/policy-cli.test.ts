import { mkdtempSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PolicyProfile, profileBudgetToLoopBudget } from "@osstack/core";
import { LoopBudget } from "@osstack/loop";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-policy-cli-"));
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

async function writePolicyFiles(policy: string, repo?: string): Promise<void> {
  await mkdir(join(tmp, ".osstack"), { recursive: true });
  await writeFile(join(tmp, ".osstack", "policy.yaml"), policy, "utf8");
  if (repo !== undefined) await writeFile(join(tmp, ".osstack", "repo.yaml"), repo, "utf8");
}

const VALID_POLICY = `schema_version: 1
mode: propose
allowed_auto_changes:
  - docs
  - tests
requires_approval:
  - source
forbidden:
  - secrets
budgets:
  max_iterations: 5
  max_runtime_minutes: 45
  max_cost_usd: 20
`;

const VALID_REPO = `schema_version: 1
product: osborn-pa
role: core_product
default_branch: main
verify_command: "pnpm test"
`;

describe("policy check CLI", () => {
  it("reports legacy mode (exit 0) when no policy files are present", async () => {
    const code = await main(["policy", "check", "--repo-path", tmp]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/no policy files \(legacy mode\)/);
  });

  it("prints mode/budgets/categories for valid files with --json (exit 0)", async () => {
    await writePolicyFiles(VALID_POLICY, VALID_REPO);
    const code = await main(["policy", "check", "--repo-path", tmp, "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n")) as {
      valid: boolean;
      legacy_mode: boolean;
      policy_profile: { mode: string; budgets: { max_runtime_minutes: number } };
      repo_config: { product: string };
    };
    expect(parsed.valid).toBe(true);
    expect(parsed.legacy_mode).toBe(false);
    expect(parsed.policy_profile.mode).toBe("propose");
    expect(parsed.policy_profile.budgets.max_runtime_minutes).toBe(45);
    expect(parsed.repo_config.product).toBe("osborn-pa");
  });

  it("fails (exit 1) with a precise error when policy.yaml is schema-invalid", async () => {
    await writePolicyFiles("schema_version: 1\nmode: propose\nallowed_auto_changes:\n  - doc\n");
    const code = await main(["policy", "check", "--repo-path", tmp]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/\.osstack\/policy\.yaml/);
    expect(errors.join("\n")).toMatch(/allowed_auto_changes/);
  });

  it("fails (exit 1) and reports the error in --json output", async () => {
    await writePolicyFiles("schema_version: 1\nmode: propose\nbogus: 1\n");
    const code = await main(["policy", "check", "--repo-path", tmp, "--json"]);
    expect(code).toBe(1);
    const parsed = JSON.parse(logs.join("\n")) as { valid: boolean; policy_error?: string };
    expect(parsed.valid).toBe(false);
    expect(parsed.policy_error).toMatch(/\.osstack\/policy\.yaml/);
  });
});

describe("profileBudgetToLoopBudget loop compatibility", () => {
  it("produces a shape that @osstack/loop LoopBudget.parse accepts", () => {
    const profile = PolicyProfile.parse({
      schema_version: 1,
      mode: "propose",
      budgets: { max_iterations: 5, max_runtime_minutes: 45, max_cost_usd: 20 },
    });
    const mapped = profileBudgetToLoopBudget(profile);
    const parsed = LoopBudget.parse(mapped);
    expect(parsed).toMatchObject({
      max_task_iterations: 5,
      max_runtime_ms: 2_700_000,
      max_estimated_cost_usd: 20,
    });
  });
});

describe("observe-mode gate", () => {
  const OBSERVE_POLICY = "schema_version: 1\nmode: observe\n";

  it("refuses `deliver` with exit 2 and executes no task when mode is observe", async () => {
    await writePolicyFiles(OBSERVE_POLICY);
    const code = await main([
      "deliver",
      "Add billing dashboard",
      "--workspace",
      tmp,
      "--execute",
      "node -e \"require('fs').writeFileSync('should-not-exist.txt', 'x')\"",
      "--json",
    ]);
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/policy mode is observe — execution refused/);
    // No task enqueued, no execution side effect, no state file written.
    await expect(stat(join(tmp, "tasks"))).rejects.toThrow();
    await expect(stat(join(tmp, "should-not-exist.txt"))).rejects.toThrow();
    await expect(stat(join(tmp, "LOOP-STATE.json"))).rejects.toThrow();
  });

  it("refuses `loop run` with exit 2 and executes no task when mode is observe", async () => {
    await mkdir(join(tmp, "tasks"), { recursive: true });
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "observe-gate-task",
      capability: "code.test",
      prompt: "Should never execute under observe",
    }));
    await writePolicyFiles(OBSERVE_POLICY);

    const code = await main([
      "loop",
      "run",
      "--workspace",
      tmp,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"require('fs').writeFileSync('should-not-exist.txt', 'x')\"",
      "--json",
    ]);
    expect(code).toBe(2);
    expect(errors.join("\n")).toMatch(/policy mode is observe — execution refused/);
    await expect(stat(join(tmp, "should-not-exist.txt"))).rejects.toThrow();
    await expect(stat(join(tmp, "LOOP-STATE.json"))).rejects.toThrow();
  });

  it("runs `loop run` exactly as before when mode is propose", async () => {
    await mkdir(join(tmp, "tasks"), { recursive: true });
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "propose-gate-task",
      capability: "code.test",
      prompt: "Runs under propose",
    }));
    await writePolicyFiles("schema_version: 1\nmode: propose\n");

    const code = await main([
      "loop",
      "run",
      "--workspace",
      tmp,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"process.exit(0)\"",
      "--json",
    ]);
    expect(code).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      completed_tasks: Array<{ task_id: string; outcome: string }>;
    };
    expect(summary.completed_tasks).toEqual([
      expect.objectContaining({ task_id: "propose-gate-task", outcome: "success" }),
    ]);
  });

  it("fails `loop run` with exit 1 when policy.yaml is invalid (fail-closed)", async () => {
    await writePolicyFiles("schema_version: 1\nmode: propose\nbogus: 1\n");
    const code = await main([
      "loop",
      "run",
      "--workspace",
      tmp,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"process.exit(0)\"",
      "--json",
    ]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/\.osstack\/policy\.yaml/);
  });

  it("does not spuriously create a tasks dir on a refused deliver run", async () => {
    await writePolicyFiles("schema_version: 1\nmode: observe\n");
    await main(["deliver", "x", "--workspace", tmp, "--json"]);
    // Only the .osstack dir we created should exist at the workspace root.
    const entries = await readdir(tmp);
    expect(entries).toEqual([".osstack"]);
  });
});
