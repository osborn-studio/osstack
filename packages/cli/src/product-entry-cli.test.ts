import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];

const SINGLE_BINARY_RELEASE_SECRETS = [
  "APPLE_ID",
  "APPLE_TEAM_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "DEVELOPER_ID_APPLICATION",
  "MACOS_CERTIFICATE_P12",
  "MACOS_CERTIFICATE_PASSWORD",
].join(",");
const ALL_RELEASE_SECRETS = `NPM_TOKEN,FLY_API_TOKEN,${SINGLE_BINARY_RELEASE_SECRETS}`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-product-entry-"));
  logs = [];
  errors = [];
  process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"] = "ok";
  process.env["OSSTACK_TEST_RELEASE_SINGLE_BINARY_WORKFLOW"] = "ok";
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
  delete process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"];
  delete process.env["OSSTACK_TEST_RELEASE_SECRETS"];
  delete process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"];
  delete process.env["OSSTACK_TEST_RELEASE_FLY_AUTH"];
  delete process.env["OSSTACK_TEST_RELEASE_VERSION_PR"];
  delete process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"];
  delete process.env["OSSTACK_TEST_RELEASE_SINGLE_BINARY_WORKFLOW"];
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
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = ALL_RELEASE_SECRETS;
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
      checks: Array<{ id: string; status: string; details?: { missing?: string[]; published_pack_dir?: string } }>;
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
      expect.objectContaining({ id: "github_actions", status: "ok" }),
      expect.objectContaining({ id: "repository_secrets", status: "ok" }),
      expect.objectContaining({ id: "npm_publish_assets", status: "ok" }),
      expect.objectContaining({ id: "version_packages_pr", status: "ok" }),
      expect.objectContaining({ id: "npm_auth", status: "ok" }),
      expect.objectContaining({ id: "knowledge_cloud_deploy_assets", status: "ok" }),
      expect.objectContaining({ id: "knowledge_cloud_workflow", status: "ok" }),
      expect.objectContaining({ id: "fly_auth", status: "ok" }),
      expect.objectContaining({ id: "single_binary_release_assets", status: "ok" }),
      expect.objectContaining({ id: "single_binary_workflow", status: "ok" }),
    ]));
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "knowledge_cloud_deploy_assets",
      details: expect.objectContaining({
        published_pack_dir: "/data/published-packs",
      }),
    }));
    expect(result.next_steps.join("\n")).toContain("NPM publish path is ready");
    expect(result.next_steps.join("\n")).toContain("Knowledge Cloud deploy=true is ready");
  });

  it("can include proof-core validation in release doctor readiness", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = ALL_RELEASE_SECRETS;
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_FLY_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "none";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    const proofDir = join(tmp, "release", "osstack-proof-release-ready");
    await writeReleaseProofEvidence(proofDir);

    const exitCode = await main(["release", "doctor", "--proof-dir", proofDir, "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; details?: Record<string, unknown> }>;
    };
    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "proof_validation",
      status: "ok",
      details: expect.objectContaining({ proof_dir: proofDir, scope: "proof-core", missing: [] }),
    }));
  });

  it("auto-detects the latest proof directory for release doctor readiness", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = ALL_RELEASE_SECRETS;
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_FLY_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "none";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    const staleProofDir = join(tmp, "release", "osstack-proof-stale");
    const latestProofDir = join(tmp, "release", "osstack-proof-latest");
    await writeReleaseProofEvidence(staleProofDir, { omitGovernance: true });
    await writeReleaseProofEvidence(latestProofDir);

    const exitCode = await main(["release", "doctor", "--workspace", tmp, "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; details?: Record<string, unknown> }>;
    };
    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "proof_validation",
      status: "ok",
      details: expect.objectContaining({ proof_dir: latestProofDir, discovered: true }),
    }));
  });

  it("blocks release doctor when supplied proof-core evidence is malformed", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = ALL_RELEASE_SECRETS;
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_FLY_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "none";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    const proofDir = join(tmp, "release", "osstack-proof-release-bad");
    await writeReleaseProofEvidence(proofDir, { omitGovernance: true });

    const exitCode = await main(["release", "doctor", "--proof-dir", proofDir, "--json"]);

    expect(exitCode).toBe(1);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; details?: { missing?: Array<{ control_id: string }> } }>;
      next_steps: string[];
    };
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "proof_validation",
      status: "error",
      details: expect.objectContaining({
        missing: expect.arrayContaining([expect.objectContaining({ control_id: "secure-coding-control" })]),
      }),
    }));
    expect(result.next_steps.join("\n")).toContain("Fix missing or malformed proof evidence before publishing or deploying.");
  });

  it("tells operators to regenerate proof artifacts when file integrity fails", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = ALL_RELEASE_SECRETS;
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_FLY_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "none";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    const proofDir = join(tmp, "release", "osstack-proof-release-tampered");
    await writeReleaseProofEvidence(proofDir);
    await writeFile(join(proofDir, "report.md"), "# Tampered release proof\n");

    const exitCode = await main(["release", "doctor", "--proof-dir", proofDir, "--json"]);

    expect(exitCode).toBe(1);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string; details?: { file_integrity?: { issues?: Array<{ code: string }> } } }>;
      next_steps: string[];
    };
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "proof_validation",
      status: "error",
      details: expect.objectContaining({
        file_integrity: expect.objectContaining({
          issues: expect.arrayContaining([expect.objectContaining({ code: "sha256_mismatch" })]),
        }),
      }),
    }));
    expect(result.next_steps.join("\n")).toContain("Regenerate or repair proof pack artifacts before publishing or deploying.");
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
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "open:5:UNSTABLE:MERGEABLE:0:CI:action_required";

    const exitCode = await main(["release", "doctor", "--target", "npm", "--json"]);

    expect(exitCode).toBe(1);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      readiness: { npm_publish: boolean };
      checks: Array<{ id: string; status: string; message: string; details?: Record<string, unknown> }>;
      next_steps: string[];
    };
    expect(result.ok).toBe(false);
    expect(result.readiness.npm_publish).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "version_packages_pr",
      status: "warn",
      details: expect.objectContaining({
        number: 5,
        merge_state: "UNSTABLE",
        mergeable: "MERGEABLE",
        check_count: 0,
        latest_ci_conclusion: "action_required",
      }),
    }));
    expect(result.next_steps.join("\n")).toContain("Review Version Packages PR #5; approve or rerun its latest CI workflow");
  });

  it("blocks release readiness when GitHub Actions cannot start runners", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"] = "billing";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = ALL_RELEASE_SECRETS;
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_FLY_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "none";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";

    const exitCode = await main(["release", "plan", "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ready: boolean;
      safe_to_execute: boolean;
      blockers: string[];
      operator_commands: string[];
      validation_commands: string[];
    };
    expect(result.ready).toBe(false);
    expect(result.safe_to_execute).toBe(false);
    expect(result.blockers).toContain("Fix GitHub Actions billing or spending limit before publishing or deploying.");
    expect(result.operator_commands).toContain("Open GitHub Billing & plans and fix failed payments or increase the Actions spending limit.");
    expect(result.validation_commands).toContain("pnpm smoke:single-binary-release-pack");
    expect(result.validation_commands).toContain("pnpm smoke:single-binary-release-publish");
  });

  it("includes auto-detected proof validation blockers in release plans", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = ALL_RELEASE_SECRETS;
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_FLY_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "none";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    await writeReleaseProofEvidence(join(tmp, "release", "osstack-proof-latest"), { omitGovernance: true });

    const exitCode = await main(["release", "plan", "--workspace", tmp, "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ready: boolean;
      safe_to_execute: boolean;
      blockers: string[];
      validation_commands: string[];
    };
    expect(result.ready).toBe(false);
    expect(result.safe_to_execute).toBe(false);
    expect(result.blockers).toContain("Fix missing or malformed proof evidence before publishing or deploying.");
    expect(result.validation_commands).toContain("osstack proof validate <run_id> --proof-dir release/osstack-proof-<run_id> --json");
  });

  it("lets release plans validate an explicitly supplied proof directory", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = ALL_RELEASE_SECRETS;
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_FLY_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "none";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    await writeReleaseProofEvidence(join(tmp, "release", "osstack-proof-latest"), { omitGovernance: true });
    const explicitProofDir = join(tmp, "custom-proof", "osstack-proof-release-ready");
    await writeReleaseProofEvidence(explicitProofDir);

    const exitCode = await main([
      "release",
      "plan",
      "--workspace",
      tmp,
      "--proof-dir",
      explicitProofDir,
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ready: boolean;
      safe_to_execute: boolean;
      blockers: string[];
      validation_commands: string[];
    };
    expect(result.ready).toBe(true);
    expect(result.safe_to_execute).toBe(true);
    expect(result.blockers).not.toContain("Fix missing or malformed proof evidence before publishing or deploying.");
    expect(result.validation_commands).toContain(
      `osstack release doctor --target all --proof-dir ${explicitProofDir} --output release-readiness.md --json`,
    );
    expect(result.validation_commands).toContain(
      `osstack proof validate <run_id> --proof-dir ${explicitProofDir} --json`,
    );
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
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "open:5:UNSTABLE:MERGEABLE:0:CI:action_required";
    const output = join(tmp, "release-readiness.md");

    const exitCode = await main(["release", "doctor", "--target", "npm", "--output", output, "--json"]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      ok: false,
      target: "npm",
      output,
    });
    const markdown = await readFile(output, "utf-8");
    expect(markdown).toContain("# Osstack Release Readiness");
    expect(markdown).toContain("Target: `npm`");
    expect(markdown).toContain("| version_packages_pr | warn |");
    expect(markdown).toContain("Review Version Packages PR #5");
    expect(markdown).toContain("Readiness");
    expect(markdown).toContain("| npm_publish | not_ready |");
  });

  it("prints a release action plan from current readiness", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "";
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "warn";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "open:5:UNSTABLE:MERGEABLE:0:CI:action_required";

    const exitCode = await main(["release", "plan", "--target", "npm", "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      target: string;
      ready: boolean;
      safe_to_execute: boolean;
      blockers: string[];
      operator_commands: string[];
      validation_commands: string[];
      publish_commands: string[];
    };
    expect(result.target).toBe("npm");
    expect(result.ready).toBe(false);
    expect(result.safe_to_execute).toBe(false);
    expect(result.blockers.join("\n")).toContain("NPM_TOKEN");
    expect(result.blockers.join("\n")).toContain("Version Packages PR #5");
    expect(result.operator_commands).toContain("gh secret set NPM_TOKEN --repo gilosbornhello/osstack --body \"$NPM_TOKEN\"");
    expect(result.operator_commands).toContain("Open the latest Version Packages PR CI run and approve or rerun it if GitHub requires manual action.");
    expect(result.validation_commands).toContain("osstack release doctor --target npm --output release-readiness.md --json");
    expect(result.validation_commands).toContain("osstack proof validate <run_id> --proof-dir release/osstack-proof-<run_id> --json");
    expect(result.validation_commands).toContain("pnpm smoke:npm-install");
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
    const cloud = await startKnowledgeCloudHandoffServer({
      healthStatus: 200,
      healthBody: { ok: true, service: "osstack-knowledge-cloud", packs: 6 },
      searchStatus: 200,
      searchBody: {
        packs: [{ id: "proof-checksum-pack", version: "0.1.0" }],
        results: [{ chunk_id: "proof-checksum-pack/checksum", pack_id: "proof-checksum-pack", score: 1 }],
      },
    });

    try {
      const exitCode = await main([
        "release",
        "plan",
        "--target",
        "knowledge-cloud",
        "--cloud-url",
        cloud.url,
        "--output",
        output,
        "--json",
      ]);

      expect(exitCode).toBe(0);
      const result = JSON.parse(logs.join("\n")) as {
        ready: boolean;
        safe_to_execute: boolean;
        blockers: string[];
        validation_commands: string[];
        deploy_commands: string[];
        output: string;
      };
      expect(result.ready).toBe(false);
      expect(result.safe_to_execute).toBe(false);
      expect(result.output).toBe(output);
      expect(result.blockers.join("\n")).toContain("FLY_API_TOKEN");
      expect(result.validation_commands).toContain(
        `osstack release doctor --target knowledge-cloud --cloud-url ${cloud.url} --output release-readiness.md --json`,
      );
      expect(result.validation_commands).toContain("osstack proof validate <run_id> --proof-dir release/osstack-proof-<run_id> --json");
      expect(result.validation_commands).toContain("pnpm smoke:knowledge-cloud:deploy");
      expect(result.validation_commands).toContain("gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=false");
      expect(result.deploy_commands).toContain("gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=true");
      const markdown = await readFile(output, "utf-8");
      expect(markdown).toContain("# Osstack Release Action Plan");
      expect(markdown).toContain("Target: `knowledge-cloud`");
      expect(markdown).toContain("Safe to execute publish/deploy commands: `no`");
      expect(markdown).toContain("Do not run publish or deploy commands until blockers are resolved.");
      expect(markdown).toContain("gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=true");
    } finally {
      await cloud.close();
    }
  });

  it("checks a deployed Knowledge Cloud health URL before deploy handoff", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "FLY_API_TOKEN";
    process.env["OSSTACK_TEST_RELEASE_FLY_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    const cloud = await startKnowledgeCloudHandoffServer({
      healthStatus: 200,
      healthBody: { ok: true, service: "osstack-knowledge-cloud", packs: 6 },
      searchStatus: 200,
      searchBody: {
        packs: [{ id: "proof-checksum-pack", version: "0.1.0" }],
        results: [{ chunk_id: "proof-checksum-pack/checksum", pack_id: "proof-checksum-pack", score: 1 }],
      },
    });

    try {
      const exitCode = await main([
        "release",
        "doctor",
        "--target",
        "knowledge-cloud",
        "--cloud-url",
        cloud.url,
        "--json",
      ]);

      expect(exitCode).toBe(0);
      const result = JSON.parse(logs.join("\n")) as {
        ok: boolean;
        readiness: { knowledge_cloud_deploy: boolean };
        checks: Array<{ id: string; status: string; details?: Record<string, unknown> }>;
      };
      expect(result.ok).toBe(true);
      expect(result.readiness.knowledge_cloud_deploy).toBe(true);
      expect(result.checks).toContainEqual(expect.objectContaining({
        id: "knowledge_cloud_health",
        status: "ok",
        details: expect.objectContaining({ cloud_url: cloud.url, packs: 6 }),
      }));
      expect(result.checks).toContainEqual(expect.objectContaining({
        id: "knowledge_cloud_search",
        status: "ok",
        details: expect.objectContaining({
          cloud_url: cloud.url,
          query: "proof pack checksum",
          result_count: 1,
        }),
      }));
      expect(result.checks).toContainEqual(expect.objectContaining({
        id: "knowledge_cloud_audit",
        status: "ok",
        details: expect.objectContaining({
          cloud_url: cloud.url,
          audit_event_count: 0,
          tenant_event_leak: false,
        }),
      }));
    } finally {
      await cloud.close();
    }
  });

  it("blocks Knowledge Cloud deploy handoff when the deployed health URL is unhealthy", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "FLY_API_TOKEN";
    process.env["OSSTACK_TEST_RELEASE_FLY_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    const cloud = await startKnowledgeCloudHandoffServer({
      healthStatus: 503,
      healthBody: { ok: false, service: "osstack-knowledge-cloud" },
      searchStatus: 200,
      searchBody: {
        packs: [{ id: "proof-checksum-pack", version: "0.1.0" }],
        results: [{ chunk_id: "proof-checksum-pack/checksum", pack_id: "proof-checksum-pack", score: 1 }],
      },
    });

    try {
      const exitCode = await main([
        "release",
        "doctor",
        "--target",
        "knowledge-cloud",
        "--cloud-url",
        cloud.url,
        "--json",
      ]);

      expect(exitCode).toBe(1);
      const result = JSON.parse(logs.join("\n")) as {
        ok: boolean;
        readiness: { knowledge_cloud_deploy: boolean };
        checks: Array<{ id: string; status: string; details?: Record<string, unknown> }>;
        next_steps: string[];
      };
      expect(result.ok).toBe(false);
      expect(result.readiness.knowledge_cloud_deploy).toBe(false);
      expect(result.checks).toContainEqual(expect.objectContaining({
        id: "knowledge_cloud_health",
        status: "error",
      }));
      expect(result.next_steps.join("\n")).toContain("Fix the deployed Knowledge Cloud /healthz endpoint before handoff.");
    } finally {
      await cloud.close();
    }
  });

  it("blocks Knowledge Cloud deploy handoff when deployed search returns no results", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "FLY_API_TOKEN";
    process.env["OSSTACK_TEST_RELEASE_FLY_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    const cloud = await startKnowledgeCloudHandoffServer({
      healthStatus: 200,
      healthBody: { ok: true, service: "osstack-knowledge-cloud", packs: 6 },
      searchStatus: 200,
      searchBody: { packs: [{ id: "proof-checksum-pack", version: "0.1.0" }], results: [] },
    });

    try {
      const exitCode = await main([
        "release",
        "doctor",
        "--target",
        "knowledge-cloud",
        "--cloud-url",
        cloud.url,
        "--json",
      ]);

      expect(exitCode).toBe(1);
      const result = JSON.parse(logs.join("\n")) as {
        ok: boolean;
        readiness: { knowledge_cloud_deploy: boolean };
        checks: Array<{ id: string; status: string; details?: Record<string, unknown> }>;
        next_steps: string[];
      };
      expect(result.ok).toBe(false);
      expect(result.readiness.knowledge_cloud_deploy).toBe(false);
      expect(result.checks).toContainEqual(expect.objectContaining({
        id: "knowledge_cloud_search",
        status: "error",
        details: expect.objectContaining({ result_count: 0 }),
      }));
      expect(result.next_steps.join("\n")).toContain("Fix deployed Knowledge Cloud search before handoff.");
    } finally {
      await cloud.close();
    }
  });

  it("blocks Knowledge Cloud deploy handoff when deployed audit leaks tenant events", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "FLY_API_TOKEN";
    process.env["OSSTACK_TEST_RELEASE_FLY_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    const cloud = await startKnowledgeCloudHandoffServer({
      healthStatus: 200,
      healthBody: { ok: true, service: "osstack-knowledge-cloud", packs: 6 },
      searchStatus: 200,
      searchBody: {
        packs: [{ id: "proof-checksum-pack", version: "0.1.0" }],
        results: [{ chunk_id: "proof-checksum-pack/checksum", pack_id: "proof-checksum-pack", score: 1 }],
      },
      auditBody: {
        filters: { action: "search", status: "ok", limit: 1 },
        events: [{ event_id: "audit-leak", action: "search", status: "ok", tenant_id: "team_alpha" }],
      },
    });

    try {
      const exitCode = await main([
        "release",
        "doctor",
        "--target",
        "knowledge-cloud",
        "--cloud-url",
        cloud.url,
        "--json",
      ]);

      expect(exitCode).toBe(1);
      const result = JSON.parse(logs.join("\n")) as {
        ok: boolean;
        readiness: { knowledge_cloud_deploy: boolean };
        checks: Array<{ id: string; status: string; details?: Record<string, unknown> }>;
        next_steps: string[];
      };
      expect(result.ok).toBe(false);
      expect(result.readiness.knowledge_cloud_deploy).toBe(false);
      expect(result.checks).toContainEqual(expect.objectContaining({
        id: "knowledge_cloud_audit",
        status: "error",
        details: expect.objectContaining({ tenant_event_leak: true }),
      }));
      expect(result.next_steps.join("\n")).toContain("Fix deployed Knowledge Cloud audit endpoint before handoff.");
    } finally {
      await cloud.close();
    }
  });

  it("checks single-binary release assets as an independent release target", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = SINGLE_BINARY_RELEASE_SECRETS;

    const exitCode = await main(["release", "doctor", "--target", "single-binary", "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      target: string;
      readiness: { single_binary_release: boolean };
      checks: Array<{ id: string; status: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.target).toBe("single-binary");
    expect(result.readiness.single_binary_release).toBe(true);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "github_auth", status: "ok" }),
      expect.objectContaining({ id: "github_actions", status: "ok" }),
      expect.objectContaining({ id: "single_binary_release_assets", status: "ok" }),
      expect.objectContaining({ id: "single_binary_workflow", status: "ok" }),
    ]));
  });

  it("requires notarization readiness for single-binary release assets", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = SINGLE_BINARY_RELEASE_SECRETS;

    const exitCode = await main(["release", "doctor", "--target", "single-binary", "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      checks: Array<{ id: string; status: string; details?: { checked?: string[]; violations?: string[] } }>;
    };
    const assetCheck = result.checks.find((check) => check.id === "single_binary_release_assets");
    expect(assetCheck).toEqual(expect.objectContaining({ status: "ok" }));
    expect(assetCheck?.details?.checked).toContain("scripts/notarize-single-binary.mjs");
    expect(assetCheck?.details?.violations ?? []).toEqual([]);
  });

  it("blocks public single-binary release when Apple signing secrets are missing", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "";

    const exitCode = await main(["release", "plan", "--target", "single-binary", "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ready: boolean;
      safe_to_execute: boolean;
      blockers: string[];
      operator_commands: string[];
    };
    expect(result.ready).toBe(false);
    expect(result.safe_to_execute).toBe(false);
    expect(result.blockers).toContain(
      "Add Apple notarization and Developer ID repository secrets before running Single Binary Release dry_run=false.",
    );
    expect(result.operator_commands).toContain("gh secret set APPLE_ID --repo gilosbornhello/osstack --body \"$APPLE_ID\"");
    expect(result.operator_commands).toContain(
      "gh secret set MACOS_CERTIFICATE_P12 --repo gilosbornhello/osstack --body \"$MACOS_CERTIFICATE_P12\"",
    );
  });

  it("writes a single-binary release action plan", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = SINGLE_BINARY_RELEASE_SECRETS;
    const output = join(tmp, "single-binary-release-plan.md");

    const exitCode = await main(["release", "plan", "--target", "single-binary", "--output", output, "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ready: boolean;
      safe_to_execute: boolean;
      validation_commands: string[];
      publish_commands: string[];
      deploy_commands: string[];
      output: string;
    };
    expect(result.ready).toBe(true);
    expect(result.safe_to_execute).toBe(true);
    expect(result.output).toBe(output);
    expect(result.validation_commands).toContain("pnpm smoke:single-binary-release-pack");
    expect(result.validation_commands).toContain("pnpm smoke:single-binary-release-publish");
    expect(result.validation_commands).toContain("gh workflow run \"Single Binary Release\" --ref main -f tag=v<version> -f dry_run=true");
    expect(result.publish_commands).toContain("gh workflow run \"Single Binary Release\" --ref main -f tag=v<version> -f dry_run=false");
    expect(result.deploy_commands).toEqual([]);
    const markdown = await readFile(output, "utf-8");
    expect(markdown).toContain("Target: `single-binary`");
    expect(markdown).toContain("gh workflow run \"Single Binary Release\" --ref main -f tag=v<version> -f dry_run=false");
  });

  it("rejects unknown release doctor targets", async () => {
    const exitCode = await main(["release", "doctor", "--target", "staging", "--json"]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("release doctor --target must be all, npm, knowledge-cloud, or single-binary");
  });
});

async function writeReleaseProofEvidence(proofDir: string, options: { omitGovernance?: boolean } = {}): Promise<void> {
  await mkdir(proofDir, { recursive: true });
  const artifacts: Array<{ path: string; sha256: string; bytes: number }> = [];
  const writeArtifact = async (path: string, content: string): Promise<void> => {
    await writeFile(join(proofDir, path), content);
    artifacts.push({
      path,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
    });
  };

  await writeArtifact("report.md", "# Release Proof\n");
  await writeArtifact("verify-results.json", JSON.stringify({
    status: "pass",
    results: [{
      task_id: "release-task",
      pass: true,
      score: 1,
      reviewer_agent_id: "local-verifier",
      summary: "release verification passed",
      event_seq: 2,
    }],
  }, null, 2));
  await writeArtifact("policy-decision.json", JSON.stringify({
    status: "recorded",
    decisions: [{
      task_id: "release-task",
      agent_id: "codex-cli",
      auth_mode: "subprocess/login-reuse",
      roles: ["coding", "test-verify", "release/proof"],
      reason: "matched release capability",
      event_seq: 1,
    }],
  }, null, 2));
  await writeArtifact("agent-runtime.json", JSON.stringify({
    status: "recorded",
    agents: [{
      agent_id: "codex-cli",
      auth_mode: "subprocess/login-reuse",
      roles: ["coding", "test-verify", "release/proof"],
      plan_event_seqs: [1],
    }],
  }, null, 2));
  if (options.omitGovernance !== true) {
    await writeArtifact("governance-results.json", JSON.stringify({ status: "pass", findings: [] }, null, 2));
  }
  await writeArtifact("worktree-status.json", JSON.stringify({
    status: "recorded",
    entries: [{
      task_id: "release-task",
      status: "merged",
      branch: "codex/release-task",
      commit: "abc123",
      path: join(proofDir, "..", "worktree"),
      event_seq: 3,
    }],
  }, null, 2));
  await writeArtifact("sha256sums.txt", artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n") + "\n");
  await writeFile(join(proofDir, "manifest.json"), JSON.stringify({ artifacts }, null, 2));
}

async function startKnowledgeCloudHandoffServer(options: {
  healthStatus: number;
  healthBody: unknown;
  searchStatus: number;
  searchBody: unknown;
  auditStatus?: number;
  auditBody?: unknown;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(options.healthStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(options.healthBody));
      return;
    }
    if (req.url === "/v1/search" && req.method === "POST") {
      res.writeHead(options.searchStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(options.searchBody));
      return;
    }
    if (req.url === "/v1/audit" && req.method === "POST") {
      res.writeHead(options.auditStatus ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(options.auditBody ?? { filters: {}, events: [] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test health server did not bind TCP");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}
