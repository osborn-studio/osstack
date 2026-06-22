import { mkdtempSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-deliver-cli-"));
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

describe("deliver CLI", () => {
  it("runs a product-entry delivery flow and writes report, scorecard, and proof", async () => {
    const exitCode = await main([
      "deliver",
      "Add billing dashboard",
      "--workspace",
      tmp,
      "--execute",
      "node -e \"require('fs').writeFileSync('billing.txt', 'ok')\"",
      "--verify",
      "node -e \"process.exit(require('fs').existsSync('billing.txt') ? 0 : 1)\"",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      prompt: string;
      task_path: string;
      verify_commands: string[];
      stages: string[];
      artifacts: {
        report?: string;
        scorecard_markdown?: string;
        scorecard_html?: string;
        proof_dir?: string;
        proof_zip?: string;
        proof_manifest?: string;
      };
      completed_tasks: Array<{ outcome: string }>;
    };
    expect(summary).toMatchObject({
      prompt: "Add billing dashboard",
      verify_commands: ["node -e \"process.exit(require('fs').existsSync('billing.txt') ? 0 : 1)\""],
      stages: ["intake", "plan", "execute-loop", "verify-review", "proof"],
      completed_tasks: [expect.objectContaining({ outcome: "success" })],
    });
    expect(summary.task_path).toMatch(/tasks\/task_[a-f0-9]{8}\.json$/);
    await expect(readFile(summary.task_path, "utf-8")).resolves.toContain("Add billing dashboard");
    await expect(readFile(summary.artifacts.report!, "utf-8")).resolves.toContain("# Osstack Loop Report");
    await expect(readFile(summary.artifacts.scorecard_html!, "utf-8")).resolves.toContain("<!doctype html>");
    await expect(readFile(summary.artifacts.proof_manifest!, "utf-8")).resolves.toContain("\"kind\": \"osstack.proof_pack\"");
    await expect(stat(summary.artifacts.proof_zip!)).resolves.toMatchObject({ size: expect.any(Number) });
  });

  it("records governed delivery findings without blocking by default", async () => {
    await writeFile(join(tmp, "unsafe.ts"), "const api_key = \"sk-test-secret-token\";\n");

    const exitCode = await main([
      "deliver",
      "Govern existing workspace",
      "--workspace",
      tmp,
      "--execute",
      "node -e \"process.exit(0)\"",
      "--govern",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      governance: { mode: string; status: string; blocking: boolean; findings: Array<{ rule_id: string }> };
      artifacts: { report: string; proof_dir: string };
    };
    expect(summary.governance).toMatchObject({
      mode: "warn",
      status: "fail",
      blocking: false,
      findings: [expect.objectContaining({ rule_id: "secret.api_key" })],
    });
    await expect(readFile(summary.artifacts.report, "utf-8")).resolves.toContain("governance-verifier");
    await expect(readFile(join(summary.artifacts.proof_dir, "governance-results.json"), "utf-8")).resolves.toContain("secret.api_key");
  });

  it("creates a shadow checkpoint before a non-worktree delivery run", async () => {
    process.env["OSSTACK_HOME"] = join(tmp, "home");
    await writeFile(join(tmp, "app.txt"), "before\n");

    const exitCode = await main([
      "deliver",
      "Checkpoint delivery",
      "--workspace",
      tmp,
      "--execute",
      "node -e \"require('fs').writeFileSync('app.txt', 'after\\n')\"",
      "--verify",
      "node -e \"process.exit(require('fs').readFileSync('app.txt','utf8') === 'after\\n' ? 0 : 1)\"",
      "--checkpoint",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      checkpoint: { checkpoint_id: string; checkpoint_dir: string };
    };
    expect(summary.checkpoint.checkpoint_id).toMatch(/^chk_/);
    await expect(readFile(join(tmp, "app.txt"), "utf-8")).resolves.toBe("after\n");
    await expect(readFile(join(summary.checkpoint.checkpoint_dir, "files", "app.txt"), "utf-8"))
      .resolves.toBe("before\n");
  });

  it("fails strict governed delivery runs on error severity findings", async () => {
    await writeFile(join(tmp, "unsafe.ts"), "const api_key = \"sk-test-secret-token\";\n");

    const exitCode = await main([
      "deliver",
      "Strict govern existing workspace",
      "--workspace",
      tmp,
      "--execute",
      "node -e \"process.exit(0)\"",
      "--govern",
      "strict",
      "--json",
    ]);

    expect(exitCode).toBe(2);
    const summary = JSON.parse(logs.join("\n")) as {
      governance: { mode: string; status: string; blocking: boolean };
      artifacts: { proof_dir: string };
    };
    expect(summary.governance).toMatchObject({ mode: "strict", status: "fail", blocking: true });
    const governance = JSON.parse(await readFile(join(summary.artifacts.proof_dir, "governance-results.json"), "utf-8")) as {
      blocking: boolean;
      findings: Array<{ rule_id: string; severity: string }>;
    };
    expect(governance).toMatchObject({
      blocking: true,
      findings: [expect.objectContaining({ rule_id: "secret.api_key", severity: "error" })],
    });
  });

  it("suggests a verify command from package.json and records it in task context", async () => {
    await writeFile(join(tmp, "package.json"), JSON.stringify({
      scripts: { test: "vitest run" },
    }, null, 2));

    const exitCode = await main([
      "deliver",
      "Wire user settings",
      "--workspace",
      tmp,
      "--execute",
      "node -e \"process.exit(0)\"",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      task_path: string;
      verify_commands: string[];
      suggested_verify: string;
    };
    expect(summary.suggested_verify).toBe("npm test");
    expect(summary.verify_commands).toEqual([]);
    const task = JSON.parse(await readFile(summary.task_path, "utf-8")) as {
      context: { deliver_pipeline: { suggested_verify: string } };
    };
    expect(task.context.deliver_pipeline.suggested_verify).toBe("npm test");
  });
});
