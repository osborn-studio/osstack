import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-product-entry-"));
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
  delete process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"];
  delete process.env["OSSTACK_TEST_RELEASE_SECRETS"];
  delete process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"];
  delete process.env["OSSTACK_TEST_RELEASE_FLY_AUTH"];
  delete process.env["OSSTACK_TEST_RELEASE_VERSION_PR"];
  delete process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"];
  await rm(tmp, { recursive: true, force: true });
});

describe("product entry commands", () => {
  it("runs a top-level product doctor across loop readiness and agent availability", async () => {
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "doctor-product-task",
      capability: "code.test",
      prompt: "Exercise top-level doctor",
    }));

    const exitCode = await main(["doctor", "--workspace", tmp, "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      workspace: string;
      loop: { ok: boolean; checks: Array<{ id: string; status: string }> };
      agents: {
        total: number;
        available: number;
        profiles: Array<{ id: string; auth_mode: string; roles: string[] }>;
        by_role: Record<string, string[]>;
      };
      next_steps: string[];
    };
    expect(result.workspace).toBe(tmp);
    expect(result.loop.ok).toBe(true);
    expect(result.loop.checks).toContainEqual(expect.objectContaining({
      id: "task_queue",
      status: "ok",
    }));
    expect(result.agents.total).toBeGreaterThan(0);
    expect(result.agents.profiles).toContainEqual(expect.objectContaining({
      id: "codex-cli",
      auth_mode: "subprocess/login-reuse",
      roles: expect.arrayContaining(["coding", "test-verify"]),
    }));
    expect(result.agents.by_role["coding"]).toContain("codex-cli");
    expect(result.next_steps.join("\n")).toContain("osstack loop run");
    expect(errors.join("\n")).toBe("");
  });

  it("prints runnable examples for common workflows", async () => {
    const exitCode = await main(["examples"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("Fix a bug");
    expect(output).toContain("Implement a feature");
    expect(output).toContain("Review git diff");
    expect(output).toContain("--auto-agent");
    expect(output).toContain("--worktree");
    expect(output).toContain("--proof");
  });

  it("prints a five-minute guide from install to proof", async () => {
    const exitCode = await main(["guide"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("5-minute quickstart");
    expect(output).toContain("osstack doctor");
    expect(output).toContain("osstack loop enqueue");
    expect(output).toContain("osstack loop run");
    expect(output).toContain("--report --scorecard --proof");
  });

  it("writes the guide to a requested output path", async () => {
    const output = join(tmp, "GUIDE.md");

    const exitCode = await main(["guide", "--output", output, "--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ output });
    await expect(readFile(output, "utf-8")).resolves.toContain("5-minute quickstart");
  });

  it("checks release publish and deploy prerequisites", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "NPM_TOKEN,FLY_API_TOKEN";
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_FLY_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "none";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";

    const exitCode = await main(["release", "doctor", "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      target: string;
      readiness: { npm_publish: boolean; knowledge_cloud_deploy: boolean };
      checks: Array<{ id: string; status: string; details?: { missing?: string[] } }>;
      next_steps: string[];
    };
    expect(result).toMatchObject({
      ok: true,
      target: "all",
      readiness: {
        npm_publish: true,
        knowledge_cloud_deploy: true,
      },
    });
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "github_auth", status: "ok" }),
      expect.objectContaining({ id: "repository_secrets", status: "ok" }),
      expect.objectContaining({ id: "version_packages_pr", status: "ok" }),
      expect.objectContaining({ id: "npm_auth", status: "ok" }),
      expect.objectContaining({ id: "knowledge_cloud_workflow", status: "ok" }),
      expect.objectContaining({ id: "fly_auth", status: "ok" }),
    ]));
    expect(result.next_steps.join("\n")).toContain("NPM publish path is ready");
    expect(result.next_steps.join("\n")).toContain("Knowledge Cloud deploy=true is ready");
  });

  it("reports missing Knowledge Cloud deploy secrets without blocking npm readiness", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "NPM_TOKEN";
    process.env["OSSTACK_TEST_RELEASE_FLY_AUTH"] = "warn";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";

    const exitCode = await main(["release", "doctor", "--target", "knowledge-cloud", "--json"]);

    expect(exitCode).toBe(1);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      readiness: { npm_publish: boolean; knowledge_cloud_deploy: boolean };
      checks: Array<{ id: string; status: string; details?: { missing?: string[] } }>;
      next_steps: string[];
    };
    expect(result.ok).toBe(false);
    expect(result.readiness).toMatchObject({
      npm_publish: true,
      knowledge_cloud_deploy: false,
    });
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "repository_secrets",
      status: "error",
      details: expect.objectContaining({ missing: ["FLY_API_TOKEN"] }),
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "fly_auth", status: "warn" }));
    expect(result.next_steps.join("\n")).toContain("FLY_API_TOKEN");
  });

  it("surfaces an unstable Version Packages PR in release doctor output", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "NPM_TOKEN";
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "warn";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "open:5:UNSTABLE:MERGEABLE:0";

    const exitCode = await main(["release", "doctor", "--target", "npm", "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; message: string; details?: Record<string, unknown> }>;
      next_steps: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "version_packages_pr",
      status: "warn",
      details: expect.objectContaining({
        number: 5,
        merge_state: "UNSTABLE",
        mergeable: "MERGEABLE",
        check_count: 0,
      }),
    }));
    expect(result.next_steps.join("\n")).toContain("Review Version Packages PR #5; it is mergeable but has no reported checks");
  });

  it("surfaces missing Knowledge Cloud deploy workflow status", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "FLY_API_TOKEN";
    process.env["OSSTACK_TEST_RELEASE_FLY_AUTH"] = "warn";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "missing";

    const exitCode = await main(["release", "doctor", "--target", "knowledge-cloud", "--json"]);

    expect(exitCode).toBe(1);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; message: string }>;
      next_steps: string[];
    };
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "knowledge_cloud_workflow",
      status: "error",
    }));
    expect(result.next_steps.join("\n")).toContain("Restore the Knowledge Cloud Deploy workflow");
  });

  it("writes a release readiness report for handoff and CI artifacts", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "NPM_TOKEN";
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "warn";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "open:5:UNSTABLE:MERGEABLE:0";
    const output = join(tmp, "release-readiness.md");

    const exitCode = await main(["release", "doctor", "--target", "npm", "--output", output, "--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      ok: true,
      target: "npm",
      output,
    });
    const markdown = await readFile(output, "utf-8");
    expect(markdown).toContain("# Osstack Release Readiness");
    expect(markdown).toContain("Target: `npm`");
    expect(markdown).toContain("| version_packages_pr | warn |");
    expect(markdown).toContain("Review Version Packages PR #5");
    expect(markdown).toContain("Readiness");
    expect(markdown).toContain("npm_publish");
  });

  it("prints a release action plan from current readiness", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "NPM_TOKEN";
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "warn";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "open:5:UNSTABLE";

    const exitCode = await main(["release", "plan", "--target", "npm", "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      target: string;
      ready: boolean;
      blockers: string[];
      validation_commands: string[];
      publish_commands: string[];
    };
    expect(result.target).toBe("npm");
    expect(result.ready).toBe(true);
    expect(result.blockers.join("\n")).toContain("Version Packages PR #5");
    expect(result.validation_commands).toContain("osstack release doctor --target npm --output release-readiness.md --json");
    expect(result.validation_commands).toContain("gh pr view 5 --json mergeable,mergeStateStatus,statusCheckRollup,url");
    expect(result.validation_commands).toContain("gh run list --branch changeset-release/main --limit 5");
    expect(result.publish_commands).toContain("gh pr merge 5 --squash --delete-branch");
    expect(result.publish_commands).toContain("npm install -g @osstack/cli");
  });

  it("writes a Knowledge Cloud release action plan", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "";
    process.env["OSSTACK_TEST_RELEASE_FLY_AUTH"] = "warn";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    const output = join(tmp, "knowledge-release-plan.md");

    const exitCode = await main(["release", "plan", "--target", "knowledge-cloud", "--output", output, "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ready: boolean;
      blockers: string[];
      validation_commands: string[];
      deploy_commands: string[];
      output: string;
    };
    expect(result.ready).toBe(false);
    expect(result.output).toBe(output);
    expect(result.blockers.join("\n")).toContain("FLY_API_TOKEN");
    expect(result.validation_commands).toContain("gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=false");
    expect(result.deploy_commands).toContain("gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=true");
    const markdown = await readFile(output, "utf-8");
    expect(markdown).toContain("# Osstack Release Action Plan");
    expect(markdown).toContain("Target: `knowledge-cloud`");
    expect(markdown).toContain("gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=true");
  });

  it("rejects unknown release doctor targets", async () => {
    const exitCode = await main(["release", "doctor", "--target", "staging", "--json"]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("release doctor --target must be all, npm, or knowledge-cloud");
  });
});
