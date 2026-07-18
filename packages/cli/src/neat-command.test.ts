import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  KnowledgeHygieneReportV1,
  type KnowledgeHygieneReportV1 as KnowledgeHygieneReport,
} from "@osstack/governance";
import { AgentCommandResult } from "@osstack/protocol";
import { describe, expect, it } from "vitest";
import {
  handleNeatCommand,
  renderKnowledgeHygieneReport,
} from "./neat-command.js";

const execFileAsync = promisify(execFile);

function warningReport(): KnowledgeHygieneReport {
  return KnowledgeHygieneReportV1.parse({
    schema_version: "1",
    generated_at: "2026-07-17T23:00:00.000Z",
    repo: { root: "/repo", repo_id: "repo-1" },
    input: { mode: "all" },
    completeness: { complete: true, skipped_files: 0, reasons: [] },
    summary: { error: 0, warning: 1, info: 0, suppressed: 0 },
    findings: [{
      fingerprint: `khf_${"a".repeat(64)}`,
      rule_id: "surface.required_missing",
      rule_version: "1",
      surface: "documentation",
      severity: "warning",
      confidence: "high",
      location: { path: "README.md", anchor: "required:readme" },
      observed: { exists: false },
      expected: { exists: true, kind: "file" },
      rationale: "A configured knowledge surface is missing.",
      evidence_refs: [],
      remediation: { mode: "agent_edit" },
    }],
    metrics: [],
  });
}

function commandHarness(options: {
  cwd: string;
  check?: (input?: unknown) => Promise<KnowledgeHygieneReport>;
}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
      cwd: () => options.cwd,
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
      ...(options.check === undefined ? {} : { check: options.check }),
      engine_ports: {
        now: () => new Date("2026-07-17T23:00:00.000Z"),
        repo_identity: () => "repo-1",
      },
    },
  };
}

async function snapshotPaths(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true })).map(String).sort();
}

describe("handleNeatCommand", () => {
  it("treats bare neat and neat check as exact aliases", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-cli-"));
    const bare = commandHarness({ cwd: repoRoot });
    const explicit = commandHarness({ cwd: repoRoot });

    const bareCode = await handleNeatCommand(["--all", "--json"], bare.deps);
    const explicitCode = await handleNeatCommand(
      ["check", "--all", "--json"],
      explicit.deps,
    );

    expect(bareCode).toBe(0);
    expect(explicitCode).toBe(0);
    expect(bare.stdout).toEqual(explicit.stdout);
    expect(AgentCommandResult.parse(JSON.parse(bare.stdout[0] ?? ""))).toBeTruthy();
  });

  it.each([
    ["all with base", ["--all", "--base", "main"]],
    ["head without base", ["--head", "HEAD"]],
    ["unknown rule", ["--checks", "unknown.rule"]],
    ["conflicting filters", [
      "--checks",
      "scan.incomplete",
      "--skip-checks",
      "scan.incomplete",
    ]],
    ["bad format", ["--format", "xml"]],
    ["bad threshold", ["--fail-on", "info"]],
    ["json human conflict", ["--json", "--format", "human"]],
    ["missing value", ["--repo"]],
    ["unknown subcommand", ["review"]],
    ["unknown flag", ["--wat"]],
  ])("returns exit 2 for %s", async (_label, args) => {
    const harness = commandHarness({ cwd: "/repo" });

    const exitCode = await handleNeatCommand(args, harness.deps);

    expect(exitCode).toBe(2);
    if (args.includes("--json")) {
      expect(AgentCommandResult.parse(JSON.parse(harness.stdout[0] ?? "")))
        .toMatchObject({ status: "error", error: { code: "bad_request" } });
    } else {
      expect(harness.stderr.join("\n")).toContain("osstack neat:");
    }
  });

  it("changes only the exit code when fail-on changes", async () => {
    const report = warningReport();
    const permissive = commandHarness({
      cwd: "/repo",
      check: async () => report,
    });
    const blocking = commandHarness({
      cwd: "/repo",
      check: async () => report,
    });

    const permissiveCode = await handleNeatCommand(
      ["--all", "--json", "--fail-on", "none"],
      permissive.deps,
    );
    const blockingCode = await handleNeatCommand(
      ["--all", "--json", "--fail-on", "warning"],
      blocking.deps,
    );

    expect(permissiveCode).toBe(0);
    expect(blockingCode).toBe(1);
    const permissiveEnvelope = JSON.parse(permissive.stdout[0] ?? "") as {
      result: { report: unknown };
    };
    const blockingEnvelope = JSON.parse(blocking.stdout[0] ?? "") as {
      result: { report: unknown };
    };
    expect(permissiveEnvelope.result.report).toEqual(blockingEnvelope.result.report);
  });

  it("resolves an explicit relative repo against the injected cwd", async () => {
    const cwd = "/workspace";
    let receivedRepo: string | undefined;
    const harness = commandHarness({
      cwd,
      check: async (input?: unknown) => {
        receivedRepo = (input as { repo_root: string }).repo_root;
        return warningReport();
      },
    });

    const exitCode = await handleNeatCommand(
      ["--repo", "packages/example", "--all"],
      harness.deps,
    );

    expect(exitCode).toBe(0);
    expect(receivedRepo).toBe("/workspace/packages/example");
  });

  it("performs zero writes in default worktree mode", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-cli-"));
    await execFileAsync("git", ["init", "--quiet"], { cwd: repoRoot });
    await execFileAsync("git", ["config", "user.email", "neat@example.invalid"], {
      cwd: repoRoot,
    });
    await execFileAsync("git", ["config", "user.name", "Neat Test"], {
      cwd: repoRoot,
    });
    await writeFile(join(repoRoot, "AGENTS.md"), "# Canonical\n");
    await execFileAsync("git", ["add", "AGENTS.md"], { cwd: repoRoot });
    await execFileAsync("git", ["commit", "--quiet", "-m", "initial"], {
      cwd: repoRoot,
    });
    const before = await snapshotPaths(repoRoot);
    const harness = commandHarness({ cwd: repoRoot });

    const exitCode = await handleNeatCommand([], harness.deps);

    expect(exitCode).toBe(0);
    await expect(snapshotPaths(repoRoot)).resolves.toEqual(before);
  });

  it("fails closed on an invalid present config", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-cli-"));
    await mkdir(join(repoRoot, ".osstack"));
    await writeFile(join(repoRoot, ".osstack", "neat.yaml"), "version: 2\n");
    const harness = commandHarness({ cwd: repoRoot });

    const exitCode = await handleNeatCommand(["--all"], harness.deps);

    expect(exitCode).toBe(2);
    expect(harness.stderr).toMatchInlineSnapshot(`
      [
        "osstack neat: invalid neat config: version: Invalid literal value, expected 1",
      ]
    `);
  });
});

describe("renderKnowledgeHygieneReport", () => {
  it("renders a stable clean report", () => {
    const report = KnowledgeHygieneReportV1.parse({
      ...warningReport(),
      summary: { error: 0, warning: 0, info: 0, suppressed: 0 },
      findings: [],
    });

    expect(renderKnowledgeHygieneReport(report, "none")).toMatchInlineSnapshot(`
      "Knowledge hygiene: 0 error, 0 warning, 0 info

      No active findings.

      Completeness: complete
      Suppressed: 0
      Exit policy: --fail-on none (exit 0)"
    `);
  });

  it("renders every finding field and evidence without absolute locations", () => {
    const output = renderKnowledgeHygieneReport(warningReport(), "warning");

    expect(output).toMatchInlineSnapshot(`
      "Knowledge hygiene: 0 error, 1 warning, 0 info

      WARNING surface.required_missing  README.md
        Rationale: A configured knowledge surface is missing.
        Observed: {"exists":false}
        Expected: {"exists":true,"kind":"file"}
        Evidence: none
        Resolve: agent_edit
        Fingerprint: khf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

      Completeness: complete
      Suppressed: 0
      Exit policy: --fail-on warning (exit 1)"
    `);
    expect(output).not.toContain("/repo");
  });

  it("renders incomplete reasons without truncation", () => {
    const report = KnowledgeHygieneReportV1.parse({
      ...warningReport(),
      completeness: {
        complete: false,
        skipped_files: 2,
        reasons: ["first reason", "second reason"],
      },
    });

    const output = renderKnowledgeHygieneReport(report, "none");

    expect(output).toMatchInlineSnapshot(`
      "Knowledge hygiene: 0 error, 1 warning, 0 info

      WARNING surface.required_missing  README.md
        Rationale: A configured knowledge surface is missing.
        Observed: {"exists":false}
        Expected: {"exists":true,"kind":"file"}
        Evidence: none
        Resolve: agent_edit
        Fingerprint: khf_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

      Completeness: incomplete (2 skipped)
        - first reason
        - second reason
      Suppressed: 0
      Exit policy: --fail-on none (exit 0)"
    `);
  });
});
