import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkKnowledgeHygieneV2 } from "@osstack/governance";
import { KnowledgeHygieneSimulatedCrashV1 } from "@osstack/governance";
import {
  handleNeatTransactionCommand,
  type NeatTransactionCommandDependencies,
} from "./neat-transaction-command.js";

const execFile = promisify(execFileCallback);
const created: string[] = [];
const originalApplyDisabled = process.env["OSSTACK_NEAT_APPLY_DISABLED"];

afterEach(async () => {
  if (originalApplyDisabled === undefined) {
    delete process.env["OSSTACK_NEAT_APPLY_DISABLED"];
  } else {
    process.env["OSSTACK_NEAT_APPLY_DISABLED"] = originalApplyDisabled;
  }
  await Promise.all(created.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function repository(): Promise<{
  root: string;
  repo: string;
  memory: string;
  home: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "osstack-neat-transaction-cli-"));
  created.push(root);
  const repo = join(root, "repo");
  const memory = join(root, "memory");
  const home = join(root, "home");
  await mkdir(join(repo, "docs"), { recursive: true });
  await mkdir(memory, { recursive: true });
  await mkdir(home, { recursive: true });
  await execFile("git", ["init", "-q"], { cwd: repo });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  await execFile("git", ["config", "user.name", "Test"], { cwd: repo });
  return { root, repo: await realpath(repo), memory: await realpath(memory), home };
}

function command(fixture: Awaited<ReturnType<typeof repository>>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let tick = 0;
  return {
    stdout,
    stderr,
    deps: {
      cwd: () => fixture.repo,
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
      home: () => fixture.home,
      now: () => new Date(Date.UTC(2026, 6, 18, 0, tick++)),
      is_tty: () => true,
      local_user_id: () => "501",
      min_free_bytes: 0,
    },
  };
}

function lastJson(output: string[]): Record<string, unknown> {
  return JSON.parse(output.at(-1) ?? "{}") as Record<string, unknown>;
}

describe("neat memory and narrative transactions", () => {
  it("plans, approves, dry-runs, and applies an exact memory move", async () => {
    const fixture = await repository();
    await writeFile(join(fixture.memory, "MEMORY.md"), "alpha\nbeta\n");
    await writeFile(join(fixture.repo, "docs", "knowledge.md"), "# Knowledge\n");
    await execFile("git", ["add", "."], { cwd: fixture.repo });
    await execFile("git", ["commit", "-qm", "fixture"], { cwd: fixture.repo });
    const harness = command(fixture);

    expect(await handleNeatTransactionCommand("memory", [
      "plan",
      "--repo",
      fixture.repo,
      "--adapter",
      "claude-code",
      "--claude-memory-dir",
      fixture.memory,
      "--source",
      "MEMORY.md",
      "--start-line",
      "1",
      "--end-line",
      "1",
      "--target",
      "docs/knowledge.md",
      "--json",
    ], harness.deps)).toBe(0);
    const planId = String(lastJson(harness.stdout)["plan_id"]);

    harness.deps.is_tty = () => false;
    expect(await handleNeatTransactionCommand("memory", [
      "approve",
      "--plan",
      planId,
      "--actions",
      "all",
      "--actor",
      "owner",
      "--reason",
      "Graduate the exact durable claim.",
      "--if-revision",
      "1",
    ], harness.deps)).toBe(2);
    harness.deps.is_tty = () => true;
    expect(await handleNeatTransactionCommand("memory", [
      "approve",
      "--plan",
      planId,
      "--actions",
      "all",
      "--actor",
      "owner",
      "--reason",
      "Graduate the exact durable claim.",
      "--if-revision",
      "1",
      "--json",
    ], harness.deps)).toBe(0);
    expect(await handleNeatTransactionCommand("memory", [
      "apply",
      "--plan",
      planId,
      "--if-revision",
      "1",
      "--dry-run",
      "--json",
    ], harness.deps)).toBe(0);
    expect(await readFile(join(fixture.memory, "MEMORY.md"), "utf8"))
      .toBe("alpha\nbeta\n");

    process.env["OSSTACK_NEAT_APPLY_DISABLED"] = "1";
    expect(await handleNeatTransactionCommand("memory", [
      "apply",
      "--plan",
      planId,
      "--if-revision",
      "1",
      "--execute",
    ], harness.deps)).toBe(2);
    delete process.env["OSSTACK_NEAT_APPLY_DISABLED"];
    expect(await handleNeatTransactionCommand("memory", [
      "apply",
      "--plan",
      planId,
      "--if-revision",
      "1",
      "--execute",
      "--json",
    ], harness.deps)).toBe(0);
    expect(await readFile(join(fixture.memory, "MEMORY.md"), "utf8")).toBe("beta\n");
    expect(await readFile(join(fixture.repo, "docs", "knowledge.md"), "utf8"))
      .toContain("alpha\n");
    const replayCode = await handleNeatTransactionCommand("memory", [
      "apply",
      "--plan",
      planId,
      "--if-revision",
      "1",
      "--execute",
      "--json",
    ], harness.deps);
    expect(replayCode, harness.stderr.at(-1)).toBe(0);
    expect(lastJson(harness.stdout)["state"]).toBe("applied");
  });

  it("removes a selected narrative finding and proves it absent", async () => {
    const fixture = await repository();
    const agents = [
      "# Instructions",
      "",
      "Keep durable guidance.",
      "",
      "<claude-mem-context>",
      "Session summary: transient state",
      "</claude-mem-context>",
      "",
    ].join("\n");
    await writeFile(join(fixture.repo, "AGENTS.md"), agents);
    await execFile("git", ["add", "."], { cwd: fixture.repo });
    await execFile("git", ["commit", "-qm", "fixture"], { cwd: fixture.repo });
    const report = await checkKnowledgeHygieneV2({
      schema_version: "2",
      repo_root: fixture.repo,
      mode: "all",
      checks: ["rulebook.managed_context_block"],
    });
    const fingerprint = report.findings[0]?.fingerprint;
    expect(fingerprint).toBeDefined();
    const harness = command(fixture);

    expect(await handleNeatTransactionCommand("narrative", [
      "plan",
      "--repo",
      fixture.repo,
      "--findings",
      fingerprint!,
      "--json",
    ], harness.deps)).toBe(0);
    const planId = String(lastJson(harness.stdout)["plan_id"]);
    expect(await handleNeatTransactionCommand("narrative", [
      "approve",
      "--plan",
      planId,
      "--actions",
      "all",
      "--actor",
      "owner",
      "--reason",
      "Remove verified transient session context.",
      "--if-revision",
      "1",
      "--json",
    ], harness.deps)).toBe(0);
    expect(await handleNeatTransactionCommand("narrative", [
      "apply",
      "--plan",
      planId,
      "--if-revision",
      "1",
      "--execute",
      "--json",
    ], harness.deps)).toBe(0);

    const after = await checkKnowledgeHygieneV2({
      schema_version: "2",
      repo_root: fixture.repo,
      mode: "all",
      checks: ["rulebook.managed_context_block"],
    });
    expect(after.findings.map((finding) => finding.fingerprint))
      .not.toContain(fingerprint);
  });

  it("marks a plan stale when its approved memory root changes", async () => {
    const fixture = await repository();
    await writeFile(join(fixture.memory, "MEMORY.md"), "alpha\n");
    await writeFile(join(fixture.repo, "docs", "knowledge.md"), "# Knowledge\n");
    await execFile("git", ["add", "."], { cwd: fixture.repo });
    await execFile("git", ["commit", "-qm", "fixture"], { cwd: fixture.repo });
    const harness = command(fixture);
    expect(await handleNeatTransactionCommand("memory", [
      "plan",
      "--repo",
      fixture.repo,
      "--adapter",
      "claude-code",
      "--claude-memory-dir",
      fixture.memory,
      "--target",
      "docs/knowledge.md",
      "--json",
    ], harness.deps)).toBe(0);
    const planId = String(lastJson(harness.stdout)["plan_id"]);
    expect(await handleNeatTransactionCommand("memory", [
      "approve",
      "--plan",
      planId,
      "--actions",
      "all",
      "--actor",
      "owner",
      "--reason",
      "Approve exact move.",
      "--if-revision",
      "1",
    ], harness.deps)).toBe(0);
    await writeFile(join(fixture.memory, "MEMORY.md"), "changed\n");
    expect(await handleNeatTransactionCommand("memory", [
      "apply",
      "--plan",
      planId,
      "--if-revision",
      "1",
      "--dry-run",
    ], harness.deps)).toBe(3);
    expect(harness.stderr.at(-1)).toContain("memory root changed");
  });

  it("persists recovery_required after interruption and recovers via CLI", async () => {
    const fixture = await repository();
    await writeFile(join(fixture.memory, "MEMORY.md"), "alpha\n");
    await writeFile(join(fixture.repo, "docs", "knowledge.md"), "# Knowledge\n");
    await execFile("git", ["add", "."], { cwd: fixture.repo });
    await execFile("git", ["commit", "-qm", "fixture"], { cwd: fixture.repo });
    const harness = command(fixture);
    expect(await handleNeatTransactionCommand("memory", [
      "plan",
      "--repo",
      fixture.repo,
      "--adapter",
      "claude-code",
      "--claude-memory-dir",
      fixture.memory,
      "--target",
      "docs/knowledge.md",
      "--json",
    ], harness.deps)).toBe(0);
    const planId = String(lastJson(harness.stdout)["plan_id"]);
    expect(await handleNeatTransactionCommand("memory", [
      "approve",
      "--plan",
      planId,
      "--actions",
      "all",
      "--actor",
      "owner",
      "--reason",
      "Approve exact move.",
      "--if-revision",
      "1",
    ], harness.deps)).toBe(0);
    const deps = harness.deps as NeatTransactionCommandDependencies;
    deps.apply_hooks = {
      after_write: (index) => {
        if (index === 0) throw new KnowledgeHygieneSimulatedCrashV1();
      },
    };
    expect(await handleNeatTransactionCommand("memory", [
      "apply",
      "--plan",
      planId,
      "--if-revision",
      "1",
      "--execute",
      "--json",
    ], deps)).toBe(3);
    delete deps.apply_hooks;
    expect(await handleNeatTransactionCommand("memory", [
      "recover",
      "--plan",
      planId,
      "--json",
    ], deps)).toBe(0);
    expect(lastJson(harness.stdout)["state"]).toBe("recovered");
    expect(await readFile(join(fixture.memory, "MEMORY.md"), "utf8"))
      .toBe("alpha\n");
    expect(await readFile(join(fixture.repo, "docs", "knowledge.md"), "utf8"))
      .toBe("# Knowledge\n");
  });
});
