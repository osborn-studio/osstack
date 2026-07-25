import {
  KnowledgeHygieneReportV1,
  type KnowledgeHygieneReportV1 as KnowledgeHygieneReport,
} from "@osstack/governance";
import { describe, expect, it, vi } from "vitest";
import { runLoopNeatFinalizer } from "./loop-neat-finalizer.js";

function report(complete = true): KnowledgeHygieneReport {
  return KnowledgeHygieneReportV1.parse({
    schema_version: "1",
    generated_at: "2026-07-17T23:00:00.000Z",
    repo: { root: "/repo", repo_id: "repo" },
    input: { mode: "all" },
    completeness: {
      complete,
      skipped_files: complete ? 0 : 1,
      reasons: complete ? [] : ["fixture skipped one file"],
    },
    summary: { error: complete ? 0 : 1, warning: 0, info: 0, suppressed: 0 },
    findings: [],
    metrics: [],
  });
}

describe("application-layer loop neat finalizer", () => {
  it("is disabled by default and does not invoke governance", async () => {
    const check = vi.fn(async () => report());

    await expect(runLoopNeatFinalizer({
      enabled: false,
      loop_succeeded: true,
      workspace_path: "/repo",
    }, { check })).resolves.toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it("does not run after a failed or idle loop", async () => {
    const check = vi.fn(async () => report());

    await expect(runLoopNeatFinalizer({
      enabled: true,
      loop_succeeded: false,
      workspace_path: "/repo",
    }, { check })).resolves.toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it("attaches the complete report and exposes incomplete coverage", async () => {
    const incomplete = report(false);

    await expect(runLoopNeatFinalizer({
      enabled: true,
      loop_succeeded: true,
      workspace_path: "/repo",
    }, { check: async () => incomplete })).resolves.toEqual({
      command: "knowledge_hygiene.check",
      status: "ok",
      report: incomplete,
    });
  });

  it("converts finalizer failure to non-gating evidence", async () => {
    await expect(runLoopNeatFinalizer({
      enabled: true,
      loop_succeeded: true,
      workspace_path: "/repo",
    }, {
      check: async () => {
        throw new Error("adapter unavailable");
      },
    })).resolves.toEqual({
      command: "knowledge_hygiene.check",
      status: "error",
      error: "adapter unavailable",
    });
  });
});
