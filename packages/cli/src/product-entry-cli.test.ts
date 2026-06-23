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
const ALL_RELEASE_SECRETS = `NPM_TOKEN,EDGEONE_API_TOKEN,EDGEONE_DEPLOY_HOOK_URL,${SINGLE_BINARY_RELEASE_SECRETS}`;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-product-entry-"));
  logs = [];
  errors = [];
  process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"] = "ok";
  process.env["OSSTACK_TEST_RELEASE_SINGLE_BINARY_WORKFLOW"] = "ok";
  process.env["OSSTACK_TEST_RELEASE_NPM_SCOPE_ACCESS"] = "ok";
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
  delete process.env["OSSTACK_TEST_RELEASE_NPM_SCOPE_ACCESS"];
  delete process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"];
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
    expect(output).toContain("5-minute proof path");
    expect(output).toContain("--auto-agent");
    expect(output).toContain("--worktree");
    expect(output).toContain("--proof");
    expect(output).toContain("osstack cockpit --workspace .");
  });

  it("prints a five-minute guide from install to proof", async () => {
    const exitCode = await main(["guide"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("5-minute quickstart");
    expect(output).toContain("npm install -g @osstack/cli");
    expect(output).toContain("osstack doctor");
    expect(output).toContain("osstack loop enqueue");
    expect(output).toContain("osstack loop run");
    expect(output).toContain("--report --scorecard --proof");
    expect(output).toContain("osstack deliver \"Add one small verified change\" --verify \"pnpm test\" --auto-agent --worktree --report --scorecard --proof");
    expect(output).toContain("osstack cockpit --workspace .");
    expect(output).toContain("latest_report=");
    expect(output).toContain("latest_proof=");
  });

  it("writes the guide to a requested output path", async () => {
    const output = join(tmp, "GUIDE.md");

    const exitCode = await main(["guide", "--output", output, "--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ output });
    await expect(readFile(output, "utf-8")).resolves.toContain("5-minute quickstart");
    await expect(readFile(output, "utf-8")).resolves.toContain("osstack cockpit --workspace .");
  });

  it("checks release publish and deploy prerequisites", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = ALL_RELEASE_SECRETS;
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
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
      expect.objectContaining({ id: "npm_scope_access", status: "ok" }),
      expect.objectContaining({ id: "knowledge_cloud_deploy_assets", status: "ok" }),
      expect.objectContaining({ id: "knowledge_cloud_workflow", status: "ok" }),
      expect.objectContaining({ id: "edgeone_deploy_credential", status: "ok" }),
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
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
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
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
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
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
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
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
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

  it("tells operators to repair compliance evidence when proof compliance claims are invalid", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = ALL_RELEASE_SECRETS;
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "none";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    const proofDir = join(tmp, "release", "osstack-proof-release-bad-compliance");
    await writeReleaseProofEvidence(proofDir);
    const manifestPath = join(proofDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      compliance_reports?: Array<{ pack_id: string; path: string; certification_claim: string }>;
    };
    manifest.compliance_reports = [{
      pack_id: "engineering-readiness",
      path: "compliance-engineering-readiness.md",
      certification_claim: "soc2",
    }];
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

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
          issues: expect.arrayContaining([expect.objectContaining({ code: "compliance_report_invalid_certification_claim" })]),
        }),
      }),
    }));
    expect(result.next_steps.join("\n")).toContain("Remove external certification claims and repair compliance report references before publishing or deploying.");
  });

  it("reports missing Knowledge Cloud deploy secrets without blocking npm readiness", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "NPM_TOKEN";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_CREDENTIAL"] = "warn";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";

    const exitCode = await main(["release", "doctor", "--target", "knowledge-cloud", "--json"]);

    expect(exitCode).toBe(1);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      readiness: { npm_publish: boolean; knowledge_cloud_deploy: boolean };
      checks: Array<{ id: string; status: string; message: string; details?: { missing?: string[]; missing_alternative_groups?: string[][] } }>;
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
      message: "Missing required repository secrets: one of (EDGEONE_API_TOKEN, EDGEONE_DEPLOY_HOOK_URL).",
      details: expect.objectContaining({
        missing: ["EDGEONE_API_TOKEN", "EDGEONE_DEPLOY_HOOK_URL"],
        missing_alternative_groups: [["EDGEONE_API_TOKEN", "EDGEONE_DEPLOY_HOOK_URL"]],
      }),
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "edgeone_deploy_credential", status: "warn" }));
    expect(result.next_steps.join("\n")).toContain("EDGEONE_API_TOKEN");
  });

  it("accepts EdgeOne API token as the primary Knowledge Cloud deploy credential", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "EDGEONE_API_TOKEN";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";

    const exitCode = await main(["release", "doctor", "--target", "knowledge-cloud", "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      readiness: { knowledge_cloud_deploy: boolean };
      checks: Array<{ id: string; status: string; details?: Record<string, unknown> }>;
      next_steps: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.readiness.knowledge_cloud_deploy).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "repository_secrets",
      status: "ok",
      details: expect.objectContaining({ missing: [] }),
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "edgeone_deploy_credential",
      status: "ok",
      details: expect.objectContaining({ mode: "cli" }),
    }));
    expect(result.next_steps.join("\n")).not.toContain("EDGEONE_DEPLOY_HOOK_URL");
  });

  it("accepts EdgeOne deploy hook as a fallback Knowledge Cloud deploy credential", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "EDGEONE_DEPLOY_HOOK_URL";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";

    const exitCode = await main(["release", "doctor", "--target", "knowledge-cloud", "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      readiness: { knowledge_cloud_deploy: boolean };
      checks: Array<{ id: string; status: string; details?: Record<string, unknown> }>;
      next_steps: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.readiness.knowledge_cloud_deploy).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "repository_secrets",
      status: "ok",
      details: expect.objectContaining({ missing: [] }),
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      id: "edgeone_deploy_credential",
      status: "ok",
      details: expect.objectContaining({ mode: "hook" }),
    }));
    expect(result.next_steps.join("\n")).not.toContain("EDGEONE_API_TOKEN");
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

  it("blocks npm release readiness when the npm scope cannot be published", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "NPM_TOKEN";
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_NPM_SCOPE_ACCESS"] = "error:scope";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "none";

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
      id: "npm_scope_access",
      status: "error",
      message: expect.stringContaining("@osstack"),
      details: expect.objectContaining({
        scope: "@osstack",
        reason: "scope_not_found_or_unauthorized",
      }),
    }));
    expect(result.next_steps.join("\n")).toContain("Create or authorize the npm @osstack scope");
  });

  it("blocks npm release readiness when the npm scope exists but publish access is forbidden", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "NPM_TOKEN";
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_NPM_SCOPE_ACCESS"] = "error:forbidden";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "none";

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
      id: "npm_scope_access",
      status: "error",
      message: expect.stringContaining("publish rights"),
      details: expect.objectContaining({
        scope: "@osstack",
        reason: "scope_forbidden",
      }),
    }));
    expect(result.next_steps.join("\n")).toContain("Confirm the npm account behind NPM_TOKEN can publish to @osstack");
  });

  it("blocks release readiness when GitHub Actions cannot start runners", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"] = "billing";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = ALL_RELEASE_SECRETS;
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
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

  it("blocks release readiness when GitHub Actions fails before assigning a runner", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"] = "allocation";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = ALL_RELEASE_SECRETS;
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "none";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";

    const exitCode = await main(["release", "plan", "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ready: boolean;
      safe_to_execute: boolean;
      blockers: string[];
      operator_commands: string[];
    };
    expect(result.ready).toBe(false);
    expect(result.safe_to_execute).toBe(false);
    expect(result.blockers).toContain("Fix GitHub Actions runner allocation before publishing or deploying.");
    expect(result.operator_commands).toContain("Open GitHub Actions settings/billing and confirm ubuntu-latest jobs can be assigned a runner.");
  });

  it("includes auto-detected proof validation blockers in release plans", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = ALL_RELEASE_SECRETS;
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
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
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
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
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "EDGEONE_DEPLOY_HOOK_URL";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "warn";
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

  it("renders release readiness blockers for GitHub runner allocation failures", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"] = "allocation";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = ALL_RELEASE_SECRETS;
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "none";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    const output = join(tmp, "release-readiness-runner.md");

    const exitCode = await main(["release", "doctor", "--output", output, "--json"]);

    expect(exitCode).toBe(1);
    const markdown = await readFile(output, "utf-8");
    expect(markdown).toContain("## Blockers");
    expect(markdown).toContain("- Fix GitHub Actions runner allocation before publishing or deploying.");
    expect(markdown).toContain("\"runner_allocation\": true");
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
      post_release_validation_commands: string[];
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
    expect(result.validation_commands).toContain("pnpm smoke:npm-preflight");
    expect(result.validation_commands).toContain("pnpm smoke:npm-install");
    expect(result.validation_commands).toContain("gh pr view 5 --json mergeable,mergeStateStatus,statusCheckRollup,url");
    expect(result.validation_commands).toContain("gh run list --branch changeset-release/main --limit 5");
    expect(result.publish_commands).toContain("gh pr merge 5 --squash --delete-branch");
    expect(result.publish_commands).toContain("npm install -g @osstack/cli");
    expect(result.post_release_validation_commands).toContain("npm view @osstack/cli version --json");
    expect(result.post_release_validation_commands).toContain("npm install -g @osstack/cli");
    expect(result.post_release_validation_commands).toContain("osstack release doctor --target npm --json");
    expect(result.post_release_validation_commands).toContain("osstack doctor --workspace . --json");
  });

  it("writes a full release action plan with runbook smoke coverage", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = ALL_RELEASE_SECRETS;
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "none";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SINGLE_BINARY_WORKFLOW"] = "ok";
    const output = join(tmp, "full-release-plan.md");

    const exitCode = await main(["release", "plan", "--target", "all", "--output", output, "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ready: boolean;
      safe_to_execute: boolean;
      validation_commands: string[];
      publish_commands: string[];
      deploy_commands: string[];
      post_release_validation_commands: string[];
    };
    expect(result.ready).toBe(true);
    expect(result.safe_to_execute).toBe(true);
    expect(result.validation_commands).toContain("pnpm smoke:release-plan");
    expect(result.validation_commands).toContain("pnpm smoke:npm-preflight");
    expect(result.validation_commands).toContain("pnpm smoke:npm-install");
    expect(result.validation_commands).toContain("pnpm smoke:knowledge-cloud:deploy");
    expect(result.validation_commands).toContain("pnpm smoke:single-binary-release-pack");
    expect(result.publish_commands).toContain("npm install -g @osstack/cli");
    expect(result.deploy_commands).toContain("gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=true");
    expect(result.post_release_validation_commands).toContain("npm view @osstack/cli version --json");
    expect(result.post_release_validation_commands).toContain("osstack release doctor --target npm --json");
    expect(result.post_release_validation_commands).toContain(
      "osstack release doctor --target knowledge-cloud --cloud-url https://knowledge.osstack.ai --json",
    );
    expect(result.post_release_validation_commands).toContain("osstack release doctor --target single-binary --json");
    expect(result.post_release_validation_commands).toContain("shasum -a 256 -c sha256sums.txt");
    const markdown = await readFile(output, "utf-8");
    expect(markdown).toContain("## Validation Commands");
    expect(markdown).toContain("pnpm smoke:release-plan");
    expect(markdown).toContain("## Post-Release Validation Commands");
    expect(markdown).toContain("osstack release doctor --target knowledge-cloud --cloud-url https://knowledge.osstack.ai --json");
  });

  it("writes a Knowledge Cloud release action plan", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "warn";
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
        post_release_validation_commands: string[];
        output: string;
      };
      expect(result.ready).toBe(false);
      expect(result.safe_to_execute).toBe(false);
      expect(result.output).toBe(output);
      expect(result.blockers.join("\n")).toContain("EDGEONE_API_TOKEN");
      expect(result.validation_commands).toContain(
        `osstack release doctor --target knowledge-cloud --cloud-url ${cloud.url} --output release-readiness.md --json`,
      );
      expect(result.validation_commands).toContain("osstack proof validate <run_id> --proof-dir release/osstack-proof-<run_id> --json");
      expect(result.validation_commands).toContain("pnpm smoke:knowledge-cloud:deploy");
      expect(result.validation_commands).toContain("gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=false");
      expect(result.deploy_commands).toContain(`gh workflow run "Knowledge Cloud Deploy" --ref main -f deploy=true -f cloud_url=${cloud.url}`);
      expect(result.deploy_commands).toContain(`osstack knowledge login --cloud-url ${cloud.url}`);
      expect(result.deploy_commands).toContain(`osstack knowledge sync --cloud-url ${cloud.url} --json`);
      expect(result.deploy_commands).toContain(`osstack knowledge search "proof pack checksum" --cloud-url ${cloud.url} --json`);
      expect(result.post_release_validation_commands).toContain(
        `osstack release doctor --target knowledge-cloud --cloud-url ${cloud.url} --json`,
      );
      expect(result.post_release_validation_commands).toContain(
        `osstack knowledge search "proof pack checksum" --cloud-url ${cloud.url} --json`,
      );
      const markdown = await readFile(output, "utf-8");
      expect(markdown).toContain("# Osstack Release Action Plan");
      expect(markdown).toContain("Target: `knowledge-cloud`");
      expect(markdown).toContain("Safe to execute publish/deploy commands: `no`");
      expect(markdown).toContain("Do not run publish or deploy commands until blockers are resolved.");
      expect(markdown).toContain(`gh workflow run "Knowledge Cloud Deploy" --ref main -f deploy=true -f cloud_url=${cloud.url}`);
      expect(markdown).toContain("## Post-Release Validation Commands");
      expect(markdown).toContain(`osstack release doctor --target knowledge-cloud --cloud-url ${cloud.url} --json`);
    } finally {
      await cloud.close();
    }
  });

  it("prints an operator-focused release status summary", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "NPM_TOKEN";
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_NPM_SCOPE_ACCESS"] = "error:forbidden";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "warn";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "none";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    const output = join(tmp, "release-status.md");

    const exitCode = await main(["release", "status", "--target", "all", "--output", output, "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      target: string;
      ready: boolean;
      completion: {
        code_verified: boolean;
        npm_publish: boolean;
        knowledge_cloud_deploy: boolean;
        single_binary_release: boolean;
      };
      external_blockers: string[];
      next_actions: {
        operator: string[];
        validation: string[];
        github_readonly: string[];
        remote_workflow: string[];
        publish: string[];
        deploy: string[];
        post_release_validation: string[];
      };
      output: string;
    };
    expect(result.target).toBe("all");
    expect(result.ready).toBe(false);
    expect(result.completion.code_verified).toBe(true);
    expect(result.completion.npm_publish).toBe(false);
    expect(result.completion.knowledge_cloud_deploy).toBe(false);
    expect(result.external_blockers.join("\n")).toContain("Confirm the npm account behind NPM_TOKEN can publish to @osstack");
    expect(result.external_blockers.join("\n")).toContain("EDGEONE_API_TOKEN");
    expect(result.next_actions.operator).toContain("Invite the npm account used for NPM_TOKEN as an owner or publisher for @osstack.");
    expect(result.next_actions.operator).toContain("gh secret set EDGEONE_API_TOKEN --repo gilosbornhello/osstack --body \"$EDGEONE_API_TOKEN\"");
    expect(result.next_actions.validation).toContain("pnpm smoke:release-plan");
    expect(result.next_actions.github_readonly).toContain("gh run list --branch changeset-release/main --limit 5");
    expect(result.next_actions.remote_workflow).toContain("gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=false");
    expect(result.next_actions.deploy).toContain("gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=true");
    expect(result.output).toBe(output);
    const markdown = await readFile(output, "utf-8");
    expect(markdown).toContain("# Osstack Release Status");
    expect(markdown).toContain("## External Blockers");
    expect(markdown).toContain("NPM_TOKEN");
    expect(markdown).toContain("EDGEONE_API_TOKEN");
    expect(markdown).toContain("## Next Actions");
    expect(markdown).toContain("### GitHub Read-Only");
    expect(markdown).toContain("### Remote Workflow");
    expect(markdown).toContain("These commands can consume GitHub Actions minutes.");
  });

  it("prints an EdgeOne Knowledge Cloud setup handoff from the deploy manifest", async () => {
    const output = join(tmp, "edgeone-setup.md");

    const exitCode = await main([
      "release",
      "edgeone",
      "--workspace",
      process.cwd(),
      "--cloud-url",
      "https://knowledge.example.com",
      "--output",
      output,
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      provider: string;
      service: string;
      default_domain: string;
      runtime: {
        node: string;
        port: number;
        entry: string;
      };
      deploy_secret: string;
      fallback_deploy_secret?: string;
      project_name: string;
      environment: Record<string, string>;
      console_checklist: string[];
      github_commands: string[];
      workflow_commands: string[];
      validation_commands: string[];
      output: string;
    };
    expect(result.provider).toBe("tencent-edgeone");
    expect(result.service).toBe("osstack-knowledge-cloud");
    expect(result.default_domain).toBe("knowledge.osstack.ai");
    expect(result.runtime).toMatchObject({
      node: "22",
      port: 8787,
      entry: "packages/knowledge-cloud/dist/bin.js",
    });
    expect(result.deploy_secret).toBe("EDGEONE_API_TOKEN");
    expect(result.fallback_deploy_secret).toBe("EDGEONE_DEPLOY_HOOK_URL");
    expect(result.project_name).toBe("osstack-knowledge-cloud");
    expect(result.environment).toMatchObject({
      OSSTACK_KNOWLEDGE_CLOUD_HOST: "0.0.0.0",
      OSSTACK_KNOWLEDGE_CLOUD_PORT: "8787",
      OSSTACK_KNOWLEDGE_AUDIT_LOG: "/data/audit/knowledge-cloud-audit.jsonl",
      OSSTACK_KNOWLEDGE_FEEDBACK_LOG: "/data/feedback/feedback.jsonl",
      OSSTACK_KNOWLEDGE_PUBLISHED_PACK_DIR: "/data/published-packs",
    });
    expect(result.console_checklist.join("\n")).toContain("Create an EdgeOne Pages project connected to gilosbornhello/osstack.");
    expect(result.console_checklist.join("\n")).toContain("Create an EdgeOne API token for Makers project osstack-knowledge-cloud");
    expect(result.github_commands).toContain("gh secret set EDGEONE_API_TOKEN --repo gilosbornhello/osstack --body \"$EDGEONE_API_TOKEN\"");
    expect(result.github_commands).toContain("# Optional fallback: gh secret set EDGEONE_DEPLOY_HOOK_URL --repo gilosbornhello/osstack --body \"$EDGEONE_DEPLOY_HOOK_URL\"");
    expect(result.github_commands.join("\n")).not.toContain("gh workflow run");
    expect(result.workflow_commands).toContain(
      "gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=false",
    );
    expect(result.workflow_commands).toContain(
      "gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=true -f cloud_url=https://knowledge.example.com",
    );
    expect(result.validation_commands).toContain("osstack release doctor --target knowledge-cloud --cloud-url https://knowledge.example.com --json");
    expect(result.validation_commands).toContain("osstack knowledge sync --cloud-url https://knowledge.example.com --json");
    expect(result.validation_commands).toContain("osstack knowledge search \"proof pack checksum\" --cloud-url https://knowledge.example.com --json");
    expect(result.output).toBe(output);
    const markdown = await readFile(output, "utf-8");
    expect(markdown).toContain("# EdgeOne Knowledge Cloud Setup");
    expect(markdown).toContain("EDGEONE_API_TOKEN");
    expect(markdown).toContain("Fallback deploy secret: `EDGEONE_DEPLOY_HOOK_URL`");
    expect(markdown).toContain("https://knowledge.example.com");
    expect(markdown).toContain("## Console Checklist");
    expect(markdown).toContain("## Validation Commands");
  });

  it("prints an npm publish setup handoff from package metadata", async () => {
    const output = join(tmp, "npm-publish-setup.md");

    const exitCode = await main([
      "release",
      "npm",
      "--workspace",
      process.cwd(),
      "--output",
      output,
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      scope: string;
      package_name: string;
      repository: string;
      required_secret: string;
      console_checklist: string[];
      github_commands: string[];
      workflow_commands: string[];
      validation_commands: string[];
      post_release_validation_commands: string[];
      output: string;
    };
    expect(result.scope).toBe("@osstack");
    expect(result.package_name).toBe("@osstack/cli");
    expect(result.repository).toBe("gilosbornhello/osstack");
    expect(result.required_secret).toBe("NPM_TOKEN");
    expect(result.console_checklist.join("\n")).toContain("Create or claim the @osstack organization/scope on npmjs.com.");
    expect(result.console_checklist.join("\n")).toContain("Do not paste NPM_TOKEN into chat, logs, issues, or pull requests.");
    expect(result.github_commands).toContain("gh secret set NPM_TOKEN --repo gilosbornhello/osstack --body \"$NPM_TOKEN\"");
    expect(result.workflow_commands).toContain("gh run list --workflow Release --branch main --limit 5");
    expect(result.validation_commands).toContain("pnpm smoke:npm-preflight");
    expect(result.validation_commands).toContain("pnpm preflight:npm-publish");
    expect(result.validation_commands).toContain("osstack release doctor --target npm --json");
    expect(result.post_release_validation_commands).toContain("npm view @osstack/cli version --json");
    expect(result.post_release_validation_commands).toContain("npm install -g @osstack/cli");
    expect(result.post_release_validation_commands).toContain("osstack --version");
    expect(result.output).toBe(output);
    const markdown = await readFile(output, "utf-8");
    expect(markdown).toContain("# NPM Publish Setup");
    expect(markdown).toContain("@osstack/cli");
    expect(markdown).toContain("NPM_TOKEN");
    expect(markdown).toContain("## Post-Release Validation Commands");
  });

  it("writes a consolidated release handoff bundle for external launch blockers", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "NPM_TOKEN";
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_NPM_SCOPE_ACCESS"] = "error:forbidden";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "warn";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "none";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    const outputDir = join(tmp, "release-handoff");

    const exitCode = await main([
      "release",
      "handoff",
      "--workspace",
      process.cwd(),
      "--cloud-url",
      "https://knowledge.example.com",
      "--output-dir",
      outputDir,
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      target: string;
      output_dir: string;
      cloud_url: string;
      required_secrets: string[];
      files: {
        manifest: string;
        release_status: string;
        release_plan: string;
        npm_setup: string;
        edgeone_setup: string;
        next_actions: string;
      };
      external_blockers: string[];
    };
    expect(result.target).toBe("primary");
    expect(result.output_dir).toBe(outputDir);
    expect(result.cloud_url).toBe("https://knowledge.example.com");
    expect(result.required_secrets).toEqual(["NPM_TOKEN", "EDGEONE_API_TOKEN"]);
    expect(result.external_blockers.join("\n")).toContain("NPM_TOKEN");
    expect(result.external_blockers.join("\n")).toContain("EDGEONE_API_TOKEN");
    expect(result.external_blockers.join("\n")).not.toContain("Apple notarization");
    expect(result.files.release_status).toBe(join(outputDir, "release-status.md"));
    expect(result.files.release_plan).toBe(join(outputDir, "release-plan.md"));
    expect(result.files.npm_setup).toBe(join(outputDir, "npm-publish-setup.md"));
    expect(result.files.edgeone_setup).toBe(join(outputDir, "edgeone-setup.md"));
    expect(result.files.next_actions).toBe(join(outputDir, "next-actions.sh"));
    expect(result.files.manifest).toBe(join(outputDir, "manifest.json"));

    const manifest = JSON.parse(await readFile(result.files.manifest, "utf-8")) as {
      kind: string;
      files: Record<string, string>;
      required_secrets: string[];
    };
    expect(manifest.kind).toBe("osstack-release-handoff");
    expect(manifest.required_secrets).toEqual(result.required_secrets);
    expect(manifest.files["npm_setup"]).toBe("npm-publish-setup.md");
    expect(manifest.files["next_actions"]).toBe("next-actions.sh");
    expect(await readFile(result.files.release_status, "utf-8")).toContain("# Osstack Release Status");
    expect(await readFile(result.files.release_plan, "utf-8")).toContain("# Osstack Release Action Plan");
    expect(await readFile(result.files.npm_setup, "utf-8")).toContain("# NPM Publish Setup");
    expect(await readFile(result.files.edgeone_setup, "utf-8")).toContain("# EdgeOne Knowledge Cloud Setup");
    const nextActions = await readFile(result.files.next_actions, "utf-8");
    expect(nextActions).toContain("#!/usr/bin/env bash");
    expect(nextActions).toContain("set -euo pipefail");
    expect(nextActions).toContain("This script prints the operator checklist only.");
    expect(nextActions).toContain("Remote workflow commands consume GitHub Actions minutes.");
    expect(nextActions).toContain("gh run cancel <run-id> --repo gilosbornhello/osstack");
    expect(nextActions).toContain("## Local Validation Commands");
    expect(nextActions).toContain("## GitHub Read-Only Commands");
    expect(nextActions).toContain("## Remote Workflow Commands");
    expect(nextActions).toContain("gh secret set NPM_TOKEN --repo gilosbornhello/osstack --body \"$NPM_TOKEN\"");
    expect(nextActions).toContain("gh secret set EDGEONE_API_TOKEN --repo gilosbornhello/osstack --body \"$EDGEONE_API_TOKEN\"");
    expect(nextActions).toContain("pnpm smoke:npm-preflight");
    expect(nextActions).toContain("gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=true -f cloud_url=https://knowledge.example.com");
  });

  it("generates a primary release plan for npm plus EdgeOne without single-binary notarization", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_GITHUB_ACTIONS"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "NPM_TOKEN,EDGEONE_DEPLOY_HOOK_URL";
    process.env["OSSTACK_TEST_RELEASE_NPM_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_NPM_SCOPE_ACCESS"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_VERSION_PR"] = "none";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";

    const exitCode = await main([
      "release",
      "plan",
      "--target",
      "primary",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      target: string;
      ready: boolean;
      validation_commands: string[];
      publish_commands: string[];
      deploy_commands: string[];
      post_release_validation_commands: string[];
    };
    expect(result.target).toBe("primary");
    expect(result.ready).toBe(true);
    expect(result.validation_commands).toContain("pnpm smoke:npm-preflight");
    expect(result.validation_commands).toContain("pnpm smoke:knowledge-cloud:deploy");
    expect(result.validation_commands.join("\n")).not.toContain("single-binary");
    expect(result.publish_commands).toContain("npm install -g @osstack/cli");
    expect(result.deploy_commands).toContain("gh workflow run \"Knowledge Cloud Deploy\" --ref main -f deploy=true");
    expect(result.post_release_validation_commands).toContain("npm view @osstack/cli version --json");
    expect(result.post_release_validation_commands).toContain("osstack release doctor --target knowledge-cloud --cloud-url https://knowledge.osstack.ai --json");
    expect(result.post_release_validation_commands.join("\n")).not.toContain("gh release download");
  });

  it("checks a deployed Knowledge Cloud health URL before deploy handoff", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "EDGEONE_DEPLOY_HOOK_URL";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
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
        id: "knowledge_cloud_sync",
        status: "ok",
        details: expect.objectContaining({
          cloud_url: cloud.url,
          pack_count: 1,
          first_pack_id: "proof-checksum-pack",
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
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "EDGEONE_DEPLOY_HOOK_URL";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
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
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "EDGEONE_DEPLOY_HOOK_URL";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
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

  it("blocks Knowledge Cloud deploy handoff when deployed sync returns no packs", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "EDGEONE_DEPLOY_HOOK_URL";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    const cloud = await startKnowledgeCloudHandoffServer({
      healthStatus: 200,
      healthBody: { ok: true, service: "osstack-knowledge-cloud", packs: 6 },
      searchStatus: 200,
      searchBody: {
        packs: [{ id: "proof-checksum-pack", version: "0.1.0" }],
        results: [{ chunk_id: "proof-checksum-pack/checksum", pack_id: "proof-checksum-pack", score: 1 }],
      },
      syncStatus: 200,
      syncBody: { packs: [] },
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
        id: "knowledge_cloud_sync",
        status: "error",
        details: expect.objectContaining({ pack_count: 0 }),
      }));
      expect(result.next_steps.join("\n")).toContain("Fix deployed Knowledge Cloud sync before handoff.");
    } finally {
      await cloud.close();
    }
  });

  it("includes deployed Knowledge Cloud sync failures as release plan blockers", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "EDGEONE_DEPLOY_HOOK_URL";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_KNOWLEDGE_WORKFLOW"] = "ok";
    const cloud = await startKnowledgeCloudHandoffServer({
      healthStatus: 200,
      healthBody: { ok: true, service: "osstack-knowledge-cloud", packs: 6 },
      searchStatus: 200,
      searchBody: {
        packs: [{ id: "proof-checksum-pack", version: "0.1.0" }],
        results: [{ chunk_id: "proof-checksum-pack/checksum", pack_id: "proof-checksum-pack", score: 1 }],
      },
      syncStatus: 200,
      syncBody: { packs: [] },
    });

    try {
      const exitCode = await main([
        "release",
        "plan",
        "--target",
        "knowledge-cloud",
        "--cloud-url",
        cloud.url,
        "--json",
      ]);

      expect(exitCode).toBe(0);
      const result = JSON.parse(logs.join("\n")) as {
        ready: boolean;
        safe_to_execute: boolean;
        blockers: string[];
      };
      expect(result.ready).toBe(false);
      expect(result.safe_to_execute).toBe(false);
      expect(result.blockers).toContain("Fix deployed Knowledge Cloud sync before handoff.");
    } finally {
      await cloud.close();
    }
  });

  it("blocks Knowledge Cloud deploy handoff when deployed audit leaks tenant events", async () => {
    process.env["OSSTACK_TEST_RELEASE_GITHUB_AUTH"] = "ok";
    process.env["OSSTACK_TEST_RELEASE_SECRETS"] = "EDGEONE_DEPLOY_HOOK_URL";
    process.env["OSSTACK_TEST_RELEASE_EDGEONE_DEPLOY_HOOK"] = "ok";
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
      post_release_validation_commands: string[];
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
    expect(result.post_release_validation_commands).toContain("gh release view v<version> --repo gilosbornhello/osstack");
    expect(result.post_release_validation_commands).toContain(
      "gh release download v<version> --repo gilosbornhello/osstack --pattern 'osstack-*.tar.gz' --pattern 'osstack-*.archive.json' --pattern 'osstack-*.sbom.spdx.json' --pattern 'sha256sums.txt'",
    );
    expect(result.post_release_validation_commands).toContain("osstack release doctor --target single-binary --json");
    expect(result.post_release_validation_commands).toContain("test -s osstack-*.archive.json && test -s osstack-*.sbom.spdx.json");
    expect(result.post_release_validation_commands).toContain("tar -xzf osstack-*.tar.gz");
    expect(result.post_release_validation_commands).toContain("shasum -a 256 -c sha256sums.txt");
    const markdown = await readFile(output, "utf-8");
    expect(markdown).toContain("Target: `single-binary`");
    expect(markdown).toContain("gh workflow run \"Single Binary Release\" --ref main -f tag=v<version> -f dry_run=false");
    expect(markdown).toContain("gh release view v<version> --repo gilosbornhello/osstack");
  });

  it("rejects unknown release doctor targets", async () => {
    const exitCode = await main(["release", "doctor", "--target", "staging", "--json"]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("release doctor --target must be all, primary, npm, knowledge-cloud, or single-binary");
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
  await writeFile(join(proofDir, "manifest.json"), JSON.stringify({
    schema_version: 1,
    kind: "osstack.proof_pack",
    osstack_version: "0.1.0",
    run_id: "release-ready",
    loop_id: "release-ready",
    agent_id: "codex-cli",
    agent_ids: ["codex-cli"],
    generated_from: "LOOP-STATE.json",
    created_at: "2026-06-22T00:00:00.000Z",
    generated_at: "2026-06-22T00:00:00.000Z",
    artifacts,
  }, null, 2));
}

async function startKnowledgeCloudHandoffServer(options: {
  healthStatus: number;
  healthBody: unknown;
  searchStatus: number;
  searchBody: unknown;
  syncStatus?: number;
  syncBody?: unknown;
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
    if (req.url === "/v1/sync" && req.method === "POST") {
      res.writeHead(options.syncStatus ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(options.syncBody ?? { packs: [{ id: "proof-checksum-pack", version: "0.1.0" }] }));
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
