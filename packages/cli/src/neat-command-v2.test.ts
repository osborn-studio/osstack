import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCommandResult } from "@osstack/protocol";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { handleNeatCommand } from "./neat-command.js";

function harness(cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
      cwd: () => cwd,
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
      engine_ports: {
        now: () => new Date("2026-07-18T00:00:00.000Z"),
        repo_identity: () => "repo-1",
      },
    },
  };
}

async function v2Repo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "osstack-neat-cli-v2-"));
  await mkdir(join(repo, ".osstack"));
  await writeFile(join(repo, ".osstack", "neat.yaml"), `
version: 2
instructions:
  canonical: AGENTS.md
`);
  await writeFile(join(repo, "AGENTS.md"), `# Rules
<claude-mem-context>
Session summary.
</claude-mem-context>
`);
  return repo;
}

describe("neat check V2", () => {
  it("runs explicit V2, exposes honest coverage, and detects managed context", async () => {
    const repo = await v2Repo();
    const command = harness(repo);
    const exitCode = await handleNeatCommand([
      "check",
      "--all",
      "--schema-version",
      "2",
      "--json",
    ], command.deps);
    expect(command.stderr).toEqual([]);
    expect(exitCode).toBe(0);

    const envelope = AgentCommandResult.parse(JSON.parse(command.stdout[0] ?? ""));
    const report = envelope.result?.report as {
      schema_version: string;
      findings: Array<{ rule_id: string }>;
      coverage: Array<{ dimension: string; state: string }>;
    };
    expect(report.schema_version).toBe("2");
    expect(report.findings.map((finding) => finding.rule_id)).toContain(
      "rulebook.managed_context_block",
    );
    expect(report.coverage).toHaveLength(6);
  });

  it("records V2 reports only in the additive V2 tables", async () => {
    const repo = await v2Repo();
    const dbPath = join(repo, "state", "neat.db");
    const command = harness(repo);
    expect(await handleNeatCommand([
      "--all",
      "--schema-version",
      "2",
      "--record",
      "--db",
      dbPath,
      "--json",
    ], command.deps)).toBe(0);

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_hygiene_runs_v2",
    ).get()).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM knowledge_hygiene_runs",
    ).get()).toEqual({ count: 0 });
    db.close();
  });

  it("rejects V2-only rules under the legacy writer", async () => {
    const command = harness("/repo");
    expect(await handleNeatCommand([
      "--schema-version",
      "1",
      "--checks",
      "rulebook.managed_context_block",
    ], command.deps)).toBe(2);
  });
});
