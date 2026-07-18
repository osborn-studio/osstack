import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KnowledgeHygieneReportV1,
  KnowledgeHygieneReviewArtifactV1,
} from "@osstack/governance";
import { AgentCommandResult, PROTOCOL_VERSION } from "@osstack/protocol";
import { describe, expect, it } from "vitest";
import { handleNeatCommand } from "./neat-command.js";

const diffId = `diff_${"a".repeat(64)}`;
const fingerprint = `khf_${"b".repeat(64)}`;

function report(diff = diffId) {
  return KnowledgeHygieneReportV1.parse({
    schema_version: "1",
    generated_at: "2026-07-17T00:00:00.000Z",
    repo: { root: "/repo", repo_id: "repo" },
    input: { mode: "worktree", base_ref: "HEAD", diff_id: diff },
    completeness: { complete: true, skipped_files: 0, reasons: [] },
    summary: { error: 0, warning: 1, info: 0, suppressed: 0 },
    findings: [{
      fingerprint,
      rule_id: "contract.review_required",
      rule_version: "1",
      surface: "documentation",
      severity: "warning",
      confidence: "medium",
      location: { path: "src/app.ts", anchor: "contract:docs" },
      observed: {},
      expected: {},
      rationale: "Review evidence is required.",
      evidence_refs: [{ kind: "proof", ref: "src/app.ts" }],
      remediation: { mode: "human_decision" },
    }],
    metrics: [],
  });
}

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
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    },
  };
}

function reviewArgs(reportPath: string, outputPath: string) {
  return [
    "review",
    "--report",
    reportPath,
    "--finding",
    fingerprint,
    "--outcome",
    "reviewed_no_change",
    "--reason",
    "No maintained documentation changed",
    "--actor",
    "osborn",
    "--output",
    outputPath,
  ];
}

describe("neat review", () => {
  it("creates an atomic artifact from a strict CLI report envelope", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "osstack-neat-review-"));
    const reportPath = join(cwd, "report.json");
    const outputPath = join(cwd, "review.json");
    const envelope = AgentCommandResult.parse({
      protocol_version: PROTOCOL_VERSION,
      status: "ok",
      result: { command: "knowledge_hygiene.check", report: report() },
    });
    await writeFile(reportPath, JSON.stringify(envelope));
    const command = harness(cwd);

    const exitCode = await handleNeatCommand(
      reviewArgs("report.json", "review.json"),
      command.deps,
    );

    expect(exitCode).toBe(0);
    const artifact = KnowledgeHygieneReviewArtifactV1.parse(
      JSON.parse(await readFile(outputPath, "utf8")),
    );
    expect(artifact).toMatchObject({
      diff_id: diffId,
      resolutions: [{
        fingerprint,
        outcome: "reviewed_no_change",
        actor: { kind: "human", id: "osborn" },
        resolved_at: "2026-07-17T12:00:00.000Z",
        evidence_refs: [{ kind: "proof", ref: "src/app.ts" }],
      }],
    });
    expect((await readdir(cwd)).sort()).toEqual(["report.json", "review.json"]);
    expect(command.stdout.join("\n")).toContain("created review.json");
  });

  it("replaces one fingerprint deterministically without duplication", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "osstack-neat-review-"));
    await writeFile(join(cwd, "report.json"), JSON.stringify(report()));
    const command = harness(cwd);
    const args = reviewArgs("report.json", "review.json");

    expect(await handleNeatCommand(args, command.deps)).toBe(0);
    const first = await readFile(join(cwd, "review.json"), "utf8");
    const acceptedRiskArgs = [...args];
    acceptedRiskArgs[acceptedRiskArgs.indexOf("--outcome") + 1] = "accepted_risk";
    expect(await handleNeatCommand(acceptedRiskArgs, command.deps)).toBe(0);
    const replaced = KnowledgeHygieneReviewArtifactV1.parse(
      JSON.parse(await readFile(join(cwd, "review.json"), "utf8")),
    );
    expect(replaced.resolutions).toHaveLength(1);
    expect(replaced.resolutions[0]?.outcome).toBe("accepted_risk");

    expect(await handleNeatCommand(args, command.deps)).toBe(0);
    expect(await readFile(join(cwd, "review.json"), "utf8")).toBe(first);
  });

  it.each([
    ["unknown fingerprint", `khf_${"c".repeat(64)}`, diffId],
    ["mismatched diff", fingerprint, `diff_${"d".repeat(64)}`],
  ])("rejects %s without changing an existing output", async (
    _label,
    requestedFingerprint,
    artifactDiff,
  ) => {
    const cwd = await mkdtemp(join(tmpdir(), "osstack-neat-review-"));
    await writeFile(join(cwd, "report.json"), JSON.stringify(report()));
    const original = JSON.stringify({
      schema_version: "1",
      diff_id: artifactDiff,
      resolutions: [{
        schema_version: "1",
        diff_id: artifactDiff,
        fingerprint,
        outcome: "fixed",
        actor: { kind: "human", id: "owner" },
        reason: "Existing evidence",
        evidence_refs: [],
        resolved_at: "2026-07-17T00:00:00.000Z",
      }],
    });
    await writeFile(join(cwd, "review.json"), original);
    const command = harness(cwd);
    const args = reviewArgs("report.json", "review.json");
    args[args.indexOf("--finding") + 1] = requestedFingerprint;

    const exitCode = await handleNeatCommand(args, command.deps);

    expect(exitCode).toBe(2);
    expect(await readFile(join(cwd, "review.json"), "utf8")).toBe(original);
    expect(command.stderr.join("\n")).toContain("osstack neat:");
  });

  it.each([
    ["missing output", ["review", "--report", "report.json"]],
    ["malformed report", reviewArgs("bad.json", "review.json")],
    ["same input and output", reviewArgs("report.json", "report.json")],
  ])("rejects %s with exit 2", async (_label, args) => {
    const cwd = await mkdtemp(join(tmpdir(), "osstack-neat-review-"));
    await writeFile(join(cwd, "report.json"), JSON.stringify(report()));
    await writeFile(join(cwd, "bad.json"), "not json");
    const command = harness(cwd);

    expect(await handleNeatCommand(args, command.deps)).toBe(2);
  });

  it("rejects a symbolic-link output without changing its target", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "osstack-neat-review-"));
    await writeFile(join(cwd, "report.json"), JSON.stringify(report()));
    await writeFile(join(cwd, "target.json"), "preserve me");
    await symlink("target.json", join(cwd, "review.json"));
    const command = harness(cwd);

    expect(await handleNeatCommand(
      reviewArgs("report.json", "review.json"),
      command.deps,
    )).toBe(2);
    expect(await readFile(join(cwd, "target.json"), "utf8")).toBe("preserve me");
  });

  it("classifies an unavailable output directory as a runtime failure", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "osstack-neat-review-"));
    await writeFile(join(cwd, "report.json"), JSON.stringify(report()));
    const command = harness(cwd);

    expect(await handleNeatCommand(
      reviewArgs("report.json", "missing/review.json"),
      command.deps,
    )).toBe(3);
    expect(command.stderr.join("\n")).toContain("osstack neat:");
  });
});
