import { access, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import type { DeployTargetPolicy } from "@osstack/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeDeployScriptAuthority,
  ProjectDeployResultSchema,
  runProjectDeploy,
} from "./deploy-runner.js";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "osstack-deploy-runner-"));
  await mkdir(join(workspace, "scripts"), { recursive: true });
  await writeScript(
    "deploy.mjs",
    `import { appendFileSync, existsSync } from "node:fs";
appendFileSync("events.log", "deploy\\n");
if (existsSync("deploy-fail")) process.exit(7);
console.log("deploy ok");`,
  );
  await writeScript(
    "verify.mjs",
    `import { appendFileSync, existsSync } from "node:fs";
appendFileSync("events.log", "verify\\n");
if (existsSync("verify-fail")) process.exit(8);
console.log("verify ok");`,
  );
  await writeScript(
    "health.mjs",
    `import { appendFileSync, existsSync } from "node:fs";
appendFileSync("events.log", "health\\n");
if (existsSync("health-fail")) process.exit(9);
console.log("health ok");`,
  );
  await writeScript(
    "rollback.mjs",
    `import { appendFileSync, existsSync, rmSync } from "node:fs";
appendFileSync("events.log", "rollback\\n");
if (existsSync("rollback-fail")) process.exit(10);
rmSync("health-fail", { force: true });
console.log("rollback ok");`,
  );
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function writeScript(name: string, body: string): Promise<void> {
  const path = join(workspace, "scripts", name);
  await writeFile(path, body, "utf8");
  await chmod(path, 0o700);
}

function policy(
  patch: Partial<DeployTargetPolicy> = {},
): DeployTargetPolicy {
  return {
    enabled: true,
    command: ["node", "scripts/deploy.mjs"],
    verify_command: ["node", "scripts/verify.mjs"],
    health_check: ["node", "scripts/health.mjs"],
    rollback: ["node", "scripts/rollback.mjs"],
    timeout_ms: 5_000,
    health_timeout_ms: 5_000,
    allowed_change_types: ["source"],
    allowed_paths: ["src/**"],
    forbidden_paths: [],
    allowed_base_branches: ["main"],
    allowed_environment: [],
    freeze_windows: [],
    ...patch,
  };
}

async function run(
  target: "staging" | "production",
  targetPolicy = policy(),
  patch: Partial<Parameters<typeof runProjectDeploy>[0]> = {},
) {
  const authority = await computeDeployScriptAuthority({
    workspace_path: workspace,
    policy: targetPolicy,
  });
  return runProjectDeploy({
    target,
    workspace_path: workspace,
    policy: targetPolicy,
    expected_script_digest_sha256: authority.digest_sha256,
    host_environment: {
      PATH: process.env.PATH ?? "/usr/bin",
      HOME: "/safe/home",
      LANG: "en_US.UTF-8",
      TMPDIR: "/tmp",
    },
    ...patch,
  });
}

describe("project deployment runner", () => {
  it("rejects contradictory deploy outcome evidence", () => {
    const evidence = {
      argv: ["node", "scripts/fake.mjs"],
      exit_code: 0,
      duration_ms: 1,
      stdout_summary: "",
      stderr_summary: "",
      timed_out: false,
    };
    expect(ProjectDeployResultSchema.safeParse({
      target: "production",
      deploy: evidence,
      outcome: "healthy",
    }).success).toBe(false);
    expect(ProjectDeployResultSchema.safeParse({
      target: "production",
      deploy: evidence,
      verify: evidence,
      health: { ...evidence, exit_code: 9 },
      outcome: "health_failed_rolled_back",
    }).success).toBe(false);
    expect(ProjectDeployResultSchema.safeParse({
      target: "production",
      deploy: { ...evidence, exit_code: 7 },
      outcome: "deploy_failed",
    }).success).toBe(false);
  });

  it("runs staging command, verification, and health without a shell", async () => {
    const result = await run(
      "staging",
      policy({
        command: [
          "node",
          "scripts/deploy.mjs",
          "$(touch shell-injection)",
          "; touch shell-injection-2",
        ],
      }),
    );
    expect(result.outcome).toBe("healthy");
    expect(await readFile(join(workspace, "events.log"), "utf8")).toBe(
      "deploy\nverify\nhealth\n",
    );
    await expect(
      access(join(workspace, "shell-injection"), constants.F_OK),
    ).rejects.toThrow();
    await expect(
      access(join(workspace, "shell-injection-2"), constants.F_OK),
    ).rejects.toThrow();
  });

  it("reports a healthy production deployment only after verification and health pass", async () => {
    const result = await run("production");
    expect(result).toMatchObject({
      outcome: "healthy",
      deploy: { exit_code: 0 },
      verify: { exit_code: 0 },
      health: { exit_code: 0 },
    });
    expect(result.rollback).toBeUndefined();
    expect(await readFile(join(workspace, "events.log"), "utf8")).toBe(
      "deploy\nverify\nhealth\n",
    );
  });

  it("rolls unhealthy production back exactly once and verifies post-rollback health", async () => {
    await writeFile(join(workspace, "health-fail"), "", "utf8");
    const result = await run("production");
    expect(result).toMatchObject({
      outcome: "health_failed_rolled_back",
      health: { exit_code: 9 },
      rollback: { exit_code: 0 },
      post_rollback_health: { exit_code: 0 },
    });
    expect(await readFile(join(workspace, "events.log"), "utf8")).toBe(
      "deploy\nverify\nhealth\nrollback\nhealth\n",
    );
  });

  it("rolls a timed-out production health check back exactly once", async () => {
    await writeScript(
      "health-once-slow.mjs",
      `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
appendFileSync("events.log", "health\\n");
if (!existsSync("health-already-timed-out")) {
  writeFileSync("health-already-timed-out", "");
  setTimeout(() => {}, 60_000);
}`,
    );
    const result = await run(
      "production",
      policy({
        health_check: ["node", "scripts/health-once-slow.mjs"],
        health_timeout_ms: 1_000,
      }),
    );
    expect(result).toMatchObject({
      outcome: "health_failed_rolled_back",
      health: { timed_out: true },
      rollback: { exit_code: 0 },
      post_rollback_health: { exit_code: 0 },
    });
    expect(await readFile(join(workspace, "events.log"), "utf8")).toBe(
      "deploy\nverify\nhealth\nrollback\nhealth\n",
    );
  });

  it("does not claim rollback success when rollback or post-health fails", async () => {
    await writeFile(join(workspace, "health-fail"), "", "utf8");
    await writeFile(join(workspace, "rollback-fail"), "", "utf8");
    const failedCommand = await run("production");
    expect(failedCommand.outcome).toBe("rollback_failed");
    expect(failedCommand.rollback?.exit_code).toBe(10);

    await rm(join(workspace, "events.log"), { force: true });
    await rm(join(workspace, "rollback-fail"), { force: true });
    await writeScript(
      "rollback.mjs",
      `import { appendFileSync } from "node:fs";
appendFileSync("events.log", "rollback\\n");`,
    );
    const failedHealth = await run("production");
    expect(failedHealth.outcome).toBe("rollback_failed");
    expect(failedHealth.post_rollback_health?.exit_code).toBe(9);
  });

  it("times out and cancels children with bounded evidence", async () => {
    await writeScript(
      "slow.mjs",
      `console.log("x".repeat(5000));
console.error("y".repeat(5000));
setTimeout(() => {}, 60_000);`,
    );
    const slowPolicy = policy({
      command: ["node", "scripts/slow.mjs"],
      timeout_ms: 1_000,
    });
    const timedOut = await run("staging", slowPolicy, {
      max_output_bytes: 256,
    });
    expect(timedOut.outcome).toBe("deploy_failed");
    expect(timedOut.deploy.timed_out).toBe(true);
    expect(Buffer.byteLength(timedOut.deploy.stdout_summary)).toBeLessThanOrEqual(
      256,
    );
    expect(Buffer.byteLength(timedOut.deploy.stderr_summary)).toBeLessThanOrEqual(
      256,
    );

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const cancelled = await run("staging", slowPolicy, {
      signal: controller.signal,
    });
    expect(cancelled.outcome).toBe("cancelled");
  });

  it("passes only baseline and explicitly allowed non-control environment names", async () => {
    await writeScript(
      "env.mjs",
      `import { writeFileSync } from "node:fs";
console.log(process.env.DEPLOY_TOKEN);
writeFileSync("environment.json", JSON.stringify({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  DEPLOY_TOKEN: process.env.DEPLOY_TOKEN,
  UNRELATED_SECRET: process.env.UNRELATED_SECRET,
  APPROVAL_PRIVATE_KEY: process.env.APPROVAL_PRIVATE_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  GH_TOKEN: process.env.GH_TOKEN
}));`,
    );
    const envPolicy = policy({
      command: ["node", "scripts/env.mjs"],
      allowed_environment: ["DEPLOY_TOKEN"],
    });
    const deployToken = "s".repeat(300);
    const result = await run("staging", envPolicy, {
      max_output_bytes: 128,
      host_environment: {
        PATH: process.env.PATH ?? "/usr/bin",
        HOME: "/safe/home",
        LANG: "en_US.UTF-8",
        TMPDIR: "/tmp",
        DEPLOY_TOKEN: deployToken,
        UNRELATED_SECRET: "must-not-leak",
        APPROVAL_PRIVATE_KEY: "must-not-leak",
        TELEGRAM_BOT_TOKEN: "must-not-leak",
        GH_TOKEN: "must-not-leak",
      },
    });
    expect(result.outcome).toBe("healthy");
    expect(result.deploy.stdout_summary).not.toContain("s");
    expect(result.deploy.stdout_summary).toContain("[REDACTED]");
    expect(
      JSON.parse(await readFile(join(workspace, "environment.json"), "utf8")),
    ).toEqual({
      PATH: process.env.PATH ?? "/usr/bin",
      HOME: "/safe/home",
      DEPLOY_TOKEN: deployToken,
    });
  });

  it("fails closed before deployment when a bound script digest changes", async () => {
    const targetPolicy = policy();
    const authority = await computeDeployScriptAuthority({
      workspace_path: workspace,
      policy: targetPolicy,
    });
    expect(authority.files.map((file) => file.path)).toEqual([
      "scripts/deploy.mjs",
      "scripts/health.mjs",
      "scripts/rollback.mjs",
      "scripts/verify.mjs",
    ]);
    await writeFile(
      join(workspace, "scripts", "deploy.mjs"),
      "throw new Error('changed');",
      "utf8",
    );

    await expect(
      runProjectDeploy({
        target: "production",
        workspace_path: workspace,
        policy: targetPolicy,
        expected_script_digest_sha256: authority.digest_sha256,
        host_environment: {
          PATH: process.env.PATH ?? "/usr/bin",
          HOME: "/safe/home",
        },
      }),
    ).rejects.toThrow(/script.*digest|authority/i);
    await expect(
      access(join(workspace, "events.log"), constants.F_OK),
    ).rejects.toThrow();
  });

  it("rejects repository command paths that escape through a symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "osstack-deploy-outside-"));
    try {
      await writeFile(join(outside, "deploy.mjs"), "console.log('outside')", "utf8");
      await import("node:fs/promises").then(({ symlink }) =>
        symlink(join(outside, "deploy.mjs"), join(workspace, "scripts", "escape.mjs")),
      );
      await expect(
        computeDeployScriptAuthority({
          workspace_path: workspace,
          policy: policy({ command: ["node", "scripts/escape.mjs"] }),
        }),
      ).rejects.toThrow(/outside|escape|workspace/i);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
