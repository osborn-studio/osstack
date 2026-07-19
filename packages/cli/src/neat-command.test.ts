import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  KnowledgeHygieneReportV1,
  type KnowledgeHygieneReportV1 as KnowledgeHygieneReport,
} from "@osstack/governance";
import { AgentCommandResult } from "@osstack/protocol";
import Database from "better-sqlite3";
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
    ["unknown subcommand", ["archive"]],
    ["unknown flag", ["--wat"]],
    ["unknown adapter", ["--adapter", "codex"]],
    ["memory directory without consent", ["--claude-memory-dir", "/memory"]],
    [
      "relative memory directory",
      ["--adapter", "claude-code", "--claude-memory-dir", "relative/memory"],
    ],
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

  it("explicitly enables Claude Code memory in strict JSON", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-cli-"));
    const memoryRoot = await mkdtemp(join(tmpdir(), "osstack-neat-memory-"));
    await writeFile(join(memoryRoot, "MEMORY.md"), "line\n".repeat(201));
    const harness = commandHarness({ cwd: repoRoot });

    const exitCode = await handleNeatCommand([
      "check",
      "--all",
      "--adapter",
      "claude-code",
      "--claude-memory-dir",
      memoryRoot,
      "--json",
    ], harness.deps);

    expect(exitCode).toBe(0);
    const envelope = AgentCommandResult.parse(
      JSON.parse(harness.stdout.join("\n")),
    );
    const report = (envelope.result as { report: KnowledgeHygieneReport }).report;
    expect(report.adapters).toEqual([expect.objectContaining({
      id: "claude-code",
      version: "1",
      status: "available",
    })]);
    expect(report.findings).toEqual([expect.objectContaining({
      rule_id: "memory.platform_limit_exceeded",
    })]);
  });

  it("renders explicit adapter status and source for humans", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-cli-"));
    const memoryRoot = await mkdtemp(join(tmpdir(), "osstack-neat-memory-"));
    await writeFile(join(memoryRoot, "MEMORY.md"), "line\n".repeat(201));
    const harness = commandHarness({ cwd: repoRoot });

    expect(await handleNeatCommand([
      "--all",
      "--adapter",
      "claude-code",
      "--claude-memory-dir",
      memoryRoot,
    ], harness.deps)).toBe(0);

    expect(harness.stdout.join("\n")).toContain(
      "Adapters: claude-code@1 available (https://code.claude.com/docs/en/memory)",
    );
    expect(harness.stdout.join("\n")).toContain(
      "WARNING memory.platform_limit_exceeded",
    );
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

  it("applies a matching review file and excludes resolved findings from fail-on", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "osstack-neat-cli-"));
    const diffId = `diff_${"b".repeat(64)}`;
    const report = KnowledgeHygieneReportV1.parse({
      ...warningReport(),
      input: { mode: "worktree", base_ref: "HEAD", diff_id: diffId },
    });
    await writeFile(join(cwd, "review.json"), JSON.stringify({
      schema_version: "1",
      diff_id: diffId,
      resolutions: [{
        schema_version: "1",
        diff_id: diffId,
        fingerprint: report.findings[0]?.fingerprint,
        outcome: "reviewed_no_change",
        actor: { kind: "human", id: "osborn" },
        reason: "No maintained documentation changed.",
        evidence_refs: [],
        resolved_at: "2026-07-17T23:30:00.000Z",
      }],
    }));
    const harness = commandHarness({ cwd, check: async () => report });

    const exitCode = await handleNeatCommand([
      "--review-file",
      "review.json",
      "--json",
      "--fail-on",
      "warning",
    ], harness.deps);

    expect(exitCode).toBe(0);
    const envelope = AgentCommandResult.parse(
      JSON.parse(harness.stdout[0] ?? ""),
    );
    const reviewed = KnowledgeHygieneReportV1.parse(envelope.result?.report);
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.summary).toMatchObject({ warning: 0, resolved: 1 });
    expect(reviewed.resolved_findings).toEqual([{
      finding: report.findings[0],
      resolution: expect.objectContaining({ outcome: "reviewed_no_change" }),
    }]);
  });

  it("rejects a stale review file with exit 2", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "osstack-neat-cli-"));
    const report = KnowledgeHygieneReportV1.parse({
      ...warningReport(),
      input: {
        mode: "worktree",
        diff_id: `diff_${"b".repeat(64)}`,
      },
    });
    const staleDiff = `diff_${"c".repeat(64)}`;
    await writeFile(join(cwd, "review.json"), JSON.stringify({
      schema_version: "1",
      diff_id: staleDiff,
      resolutions: [{
        schema_version: "1",
        diff_id: staleDiff,
        fingerprint: report.findings[0]?.fingerprint,
        outcome: "obsolete",
        actor: { kind: "human", id: "osborn" },
        reason: "Stale review.",
        evidence_refs: [],
        resolved_at: "2026-07-17T23:30:00.000Z",
      }],
    }));
    const harness = commandHarness({ cwd, check: async () => report });

    expect(await handleNeatCommand([
      "--review-file",
      "review.json",
    ], harness.deps)).toBe(2);
    expect(harness.stdout).toEqual([]);
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

  it("records only when explicit and deduplicates the same report", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "osstack-neat-record-"));
    const dbPath = join(cwd, "state", "neat.db");
    const first = commandHarness({ cwd, check: async () => warningReport() });

    expect(await handleNeatCommand([
      "--all",
      "--record",
      "--db",
      dbPath,
      "--json",
    ], first.deps)).toBe(0);
    const firstEnvelope = AgentCommandResult.parse(
      JSON.parse(first.stdout[0] ?? ""),
    );
    expect(firstEnvelope.result?.recording).toMatchObject({ inserted: true });
    const firstRecording = firstEnvelope.result?.recording as { run_id: string };

    const second = commandHarness({ cwd, check: async () => warningReport() });
    expect(await handleNeatCommand([
      "--all",
      "--record",
      "--db",
      dbPath,
      "--json",
    ], second.deps)).toBe(0);
    const secondEnvelope = AgentCommandResult.parse(
      JSON.parse(second.stdout[0] ?? ""),
    );
    expect(secondEnvelope.result?.recording).toEqual({
      run_id: firstRecording.run_id,
      inserted: false,
      db_path: dbPath,
    });
    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_hygiene_runs").get())
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_hygiene_occurrences").get())
      .toEqual({ count: 1 });
    db.close();
  });

  it("rejects --db without --record and does not create it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "osstack-neat-record-"));
    const dbPath = join(cwd, "state.db");
    const command = commandHarness({ cwd, check: async () => warningReport() });

    expect(await handleNeatCommand([
      "--all",
      "--db",
      dbPath,
    ], command.deps)).toBe(2);
    await expect(access(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
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

      No findings in the mechanical V1 rule set; semantic dimensions were not assessed.

      Completeness: complete
      Semantic coverage: not assessed (V1 mechanical rule set only)
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
      Semantic coverage: not assessed (V1 mechanical rule set only)
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
      Semantic coverage: not assessed (V1 mechanical rule set only)
      Suppressed: 0
      Exit policy: --fail-on none (exit 0)"
    `);
  });
});
