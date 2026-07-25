import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyKnowledgeHygienePatchPlan,
  KnowledgeHygieneReportV1,
} from "@osstack/governance";
import { AgentCommandResult } from "@osstack/protocol";
import { describe, expect, it } from "vitest";
import { handleNeatCommand } from "./neat-command.js";

const configSource = `version: 1
instructions:
  canonical: AGENTS.md
  mirrors:
    - path: CLAUDE.md
      mode: import
`;
const configSha = createHash("sha256").update(configSource).digest("hex");

function report(root: string) {
  return KnowledgeHygieneReportV1.parse({
    schema_version: "1",
    generated_at: "2026-07-17T00:00:00.000Z",
    repo: { root, repo_id: "repo" },
    input: {
      mode: "worktree",
      diff_id: `diff_${"b".repeat(64)}`,
      config_path: ".osstack/neat.yaml",
      config_sha256: configSha,
    },
    completeness: { complete: true, skipped_files: 0, reasons: [] },
    summary: { error: 0, warning: 1, info: 0, suppressed: 0 },
    findings: [{
      fingerprint: `khf_${"a".repeat(64)}`,
      rule_id: "instruction.mirror_missing",
      rule_version: "1",
      surface: "instruction",
      severity: "warning",
      confidence: "high",
      location: { path: "CLAUDE.md" },
      observed: { exists: false },
      expected: { exists: true, mode: "import" },
      rationale: "The configured instruction mirror is missing.",
      evidence_refs: [],
      remediation: { mode: "safe_patch" },
    }],
    metrics: [],
  });
}

async function fixture(policy?: string) {
  const root = await mkdtemp(join(tmpdir(), "osstack-neat-fix-"));
  await mkdir(join(root, ".osstack"));
  await writeFile(join(root, ".osstack", "neat.yaml"), configSource);
  if (policy !== undefined) {
    await writeFile(join(root, ".osstack", "policy.yaml"), policy);
  }
  await writeFile(join(root, "AGENTS.md"), "# Canonical\n");
  await writeFile(join(root, "report.json"), JSON.stringify(report(root)));
  return root;
}

function harness(root: string, fix: Record<string, unknown> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    deps: {
      cwd: () => root,
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
      now: () => new Date("2026-07-17T01:00:00.000Z"),
      fix,
    },
  };
}

async function expectTargetMissing(root: string) {
  await expect(readFile(join(root, "CLAUDE.md"), "utf8"))
    .rejects.toMatchObject({ code: "ENOENT" });
}

describe("neat fix", () => {
  it("previews by default without requiring policy or writing", async () => {
    const root = await fixture();
    const command = harness(root);

    expect(await handleNeatCommand([
      "fix",
      "--from",
      "report.json",
    ], command.deps)).toBe(0);

    expect(command.stdout.join("\n")).toContain("Patch preview");
    expect(command.stdout.join("\n")).toContain("CREATE CLAUDE.md");
    await expectTargetMissing(root);
  });

  it("refuses --apply without --yes before any write", async () => {
    const root = await fixture();
    const command = harness(root);

    expect(await handleNeatCommand([
      "fix",
      "--from",
      "report.json",
      "--apply",
    ], command.deps)).toBe(2);
    await expectTargetMissing(root);
  });

  it.each([
    ["observe", "schema_version: 1\nmode: observe\n"],
    ["propose", "schema_version: 1\nmode: propose\n"],
    ["invalid", "schema_version: 1\nmode: execute\nbogus: true\n"],
  ])("refuses %s policy without writing", async (_label, policy) => {
    const root = await fixture(policy);
    const command = harness(root);

    expect(await handleNeatCommand([
      "fix",
      "--from",
      "report.json",
      "--apply",
      "--yes",
    ], command.deps)).toBe(2);
    expect(command.stderr.join("\n")).toMatch(/policy/i);
    await expectTargetMissing(root);
  });

  it("applies an allowed action and emits before/after hash evidence", async () => {
    const root = await fixture(`schema_version: 1
mode: execute
auto_apply: true
allowed_auto_changes: [docs]
`);
    const command = harness(root);

    expect(await handleNeatCommand([
      "fix",
      "--from",
      "report.json",
      "--apply",
      "--yes",
      "--json",
    ], command.deps)).toBe(0);

    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    const envelope = AgentCommandResult.parse(
      JSON.parse(command.stdout[0] ?? ""),
    );
    expect(envelope).toMatchObject({
      status: "ok",
      result: {
        command: "knowledge_hygiene.fix",
        mode: "apply",
        apply_result: {
          actions: [{
            status: "applied",
            before: { exists: false, sha256: null },
            after: { exists: true, sha256: expect.any(String) },
          }],
        },
      },
    });

    const repeated = harness(root);
    expect(await handleNeatCommand([
      "fix",
      "--from",
      "report.json",
      "--apply",
      "--yes",
      "--json",
    ], repeated.deps)).toBe(0);
    const repeatedEnvelope = AgentCommandResult.parse(
      JSON.parse(repeated.stdout[0] ?? ""),
    );
    expect(repeatedEnvelope.result?.apply_result).toMatchObject({
      actions: [{ status: "already_applied" }],
    });
  });

  it("reports a conflict when target state changes after preview", async () => {
    const root = await fixture(`schema_version: 1
mode: execute
auto_apply: true
allowed_auto_changes: [docs]
`);
    const command = harness(root, {
      apply_patch: async (...args: Parameters<typeof applyKnowledgeHygienePatchPlan>) => {
        await writeFile(join(root, "CLAUDE.md"), "concurrent change\n");
        return applyKnowledgeHygienePatchPlan(...args);
      },
    });

    expect(await handleNeatCommand([
      "fix",
      "--from",
      "report.json",
      "--apply",
      "--yes",
    ], command.deps)).toBe(3);
    expect(command.stderr.join("\n")).toContain("precondition failed");
    expect(await readFile(join(root, "CLAUDE.md"), "utf8"))
      .toBe("concurrent change\n");
  });
});
