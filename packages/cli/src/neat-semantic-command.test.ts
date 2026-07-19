import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KnowledgeHygieneReportV2,
  type SemanticJudgePort,
  type SemanticJudgeRequestV1,
} from "@osstack/governance";
import { AgentCommandResult } from "@osstack/protocol";
import { describe, expect, it } from "vitest";
import {
  handleNeatCommand,
  type NeatCommandDependencies,
} from "./neat-command.js";

async function semanticRepo(enabled = true): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "osstack-neat-semantic-cli-"));
  await mkdir(join(repo, ".osstack"));
  await writeFile(join(repo, ".osstack", "neat.yaml"), `
version: 2
instructions:
  canonical: AGENTS.md
semantic:
  enabled: ${enabled}
${enabled ? "  judge_id: fake-no-tools\n" : ""}  dimensions: [narrative]
  schedule: manual
  max_input_tokens: 32000
  max_output_tokens: 4000
  max_calls: 8
`);
  await writeFile(join(repo, "AGENTS.md"), `# Rules
<claude-mem-context>
Session summary that belongs outside the durable rulebook.
</claude-mem-context>
`);
  return repo;
}

function fakeJudge(): SemanticJudgePort {
  return {
    id: "fake-no-tools",
    model_id: "fake-model",
    prompt_version: "1",
    supports_no_tools: true,
    async judge(request: SemanticJudgeRequestV1) {
      const source = request.evidence_pack.sources[0];
      const excerpt = source?.excerpts[0];
      if (source === undefined || excerpt === undefined) {
        throw new Error("test evidence missing");
      }
      return {
        nonce: request.nonce,
        raw_output: {
          dimension: request.evidence_pack.dimension,
          verdict: "issue",
          confidence: "high",
          citations: [{
            source: source.source,
            blob_sha256: source.blob_sha256,
            start_line: excerpt.start_line,
            end_line: excerpt.end_line,
            excerpt: excerpt.text,
            text_sha256: source.blob_sha256 === ""
              ? ""
              : await import("node:crypto").then(({ createHash }) =>
                createHash("sha256").update(excerpt.text).digest("hex")
              ),
          }],
          rationale: "The excerpt is transient session narrative.",
          proposed_disposition: "move",
          closure_conditions: [],
        },
        usage: { input_tokens: 100, output_tokens: 30, calls: 1 },
      };
    },
  };
}

function commandHarness(repo: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: NeatCommandDependencies = {
    cwd: () => repo,
    stdout: (value: string) => stdout.push(value),
    stderr: (value: string) => stderr.push(value),
    now: () => new Date("2026-07-18T20:00:00.000Z"),
    engine_ports: {
      now: () => new Date("2026-07-18T20:00:00.000Z"),
      repo_identity: () => "repo-semantic",
    },
    semantic: {
      judge_factory: (id: string) => {
        expect(id).toBe("fake-no-tools");
        return fakeJudge();
      },
    },
  };
  return {
    stdout,
    stderr,
    deps,
  };
}

function truncatedReport(repo: string) {
  return KnowledgeHygieneReportV2.parse({
    schema_version: "2",
    generated_at: "2026-07-18T20:00:00.000Z",
    repo: { root: repo, repo_id: "repo-semantic" },
    input: { mode: "all" },
    completeness: { complete: true, skipped_files: 0, reasons: [] },
    summary: { error: 0, warning: 0, info: 0, suppressed: 0 },
    findings: [],
    metrics: [],
    assessment_scope: { selected_rule_ids: ["semantic.narrative"] },
    coverage: [
      {
        dimension: "mechanical",
        state: "complete",
        source_units_total: 1,
        candidates_generated: 1,
        candidates_assessed: 1,
        candidates_skipped: 0,
        reason_codes: [],
      },
      {
        dimension: "narrative",
        state: "truncated",
        source_units_total: 1,
        candidates_generated: 2,
        candidates_assessed: 1,
        candidates_skipped: 1,
        reason_codes: ["call_budget_exhausted"],
      },
      ...["contradiction", "drift", "memory_overlap", "cross_repository"].map((dimension) => ({
        dimension,
        state: "not_assessed" as const,
        source_units_total: 0,
        candidates_generated: 0,
        candidates_assessed: 0,
        candidates_skipped: 0,
        reason_codes: ["not_requested" as const],
      })),
    ],
    health_claim: "assessment_incomplete",
    rejection_counts: {},
  });
}

describe("neat semantic", () => {
  it("runs an evidence-bound V2 audit through the configured judge", async () => {
    const repo = await semanticRepo();
    const command = commandHarness(repo);
    const code = await handleNeatCommand([
      "semantic",
      "--all",
      "--dimensions",
      "narrative",
      "--schema-version",
      "2",
      "--json",
    ], command.deps);

    expect(code).toBe(0);
    expect(command.stderr).toEqual([]);
    const envelope = AgentCommandResult.parse(JSON.parse(command.stdout[0] ?? ""));
    expect(envelope.result?.command).toBe("knowledge_hygiene.semantic");
    const report = envelope.result?.report as {
      schema_version: string;
      findings: Array<{ rule_id: string }>;
      coverage: Array<{ dimension: string; state: string }>;
    };
    expect(report.schema_version).toBe("2");
    expect(report.findings.map((finding) => finding.rule_id)).toContain(
      "semantic.narrative",
    );
    expect(report.coverage).toContainEqual(expect.objectContaining({
      dimension: "narrative",
      state: "partial",
    }));
  });

  it.each([
    ["legacy schema", ["--schema-version", "1"]],
    ["unknown dimension", ["--dimensions", "sentiment"]],
    ["duplicate dimension", ["--dimensions", "narrative,narrative"]],
    ["zero call budget", ["--max-calls", "0"]],
    ["fractional budget", ["--max-output-tokens", "1.5"]],
    ["head without base", ["--head", "HEAD"]],
    ["all with base", ["--all", "--base", "main"]],
    ["db without record", ["--db", "state.db"]],
  ])("returns exit 2 for %s", async (_label, flags) => {
    const repo = await semanticRepo();
    const command = commandHarness(repo);
    expect(await handleNeatCommand(["semantic", ...flags], command.deps)).toBe(2);
  });

  it("enforces the config kill switch", async () => {
    const repo = await semanticRepo(false);
    const command = commandHarness(repo);
    expect(await handleNeatCommand(["semantic", "--all"], command.deps)).toBe(2);
    expect(command.stderr.join("\n")).toContain("semantic.enabled");
  });

  it("returns exit 3 for truncated requested coverage unless explicitly allowed", async () => {
    const repo = await semanticRepo();
    const blocked = commandHarness(repo);
    blocked.deps.semantic = {
      ...blocked.deps.semantic,
      audit: async () => truncatedReport(repo),
    };
    expect(await handleNeatCommand(["semantic", "--all"], blocked.deps)).toBe(3);

    const allowed = commandHarness(repo);
    allowed.deps.semantic = {
      ...allowed.deps.semantic,
      audit: async () => truncatedReport(repo),
    };
    expect(await handleNeatCommand([
      "semantic",
      "--all",
      "--allow-truncated",
    ], allowed.deps)).toBe(0);
  });
});
