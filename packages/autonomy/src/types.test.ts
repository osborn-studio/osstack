import { describe, expect, it } from "vitest";
import {
  AutonomyTaskIntent,
  DeliveryBudget,
  PostDiffInput,
} from "./types.js";

const SHA_A = "a".repeat(64);

describe("guarded autonomy package contracts", () => {
  it("parses a strict, canonical autonomy task intent", () => {
    const intent = {
      autonomy_run_id: "autonomy-run-1",
      task_id: "task-1",
      repo_id: "gilosbornhello/osstack",
      workspace_path: "/worktrees/osstack-task-1",
      goal: "add guarded delivery",
      expected_paths: ["packages/autonomy", "packages/protocol"],
      requested_actions: ["build", "verify"],
      contract_sha256: SHA_A,
    };

    expect(AutonomyTaskIntent.parse(intent)).toEqual(intent);
    expect(AutonomyTaskIntent.safeParse({ ...intent, unexpected: true }).success).toBe(false);
    expect(
      AutonomyTaskIntent.safeParse({
        ...intent,
        expected_paths: ["packages/protocol", "packages/autonomy"],
      }).success,
    ).toBe(false);
  });

  it("parses authoritative staged-diff material including NUL-delimited status", () => {
    const input = {
      base_commit_sha: "b".repeat(40),
      changed_paths: [".env.production", "src/auth/session.ts"],
      staged_diff_binary: "diff --git a/.env.production b/.env.production\n",
      status_porcelain_v1_z: "A  .env.production\0M  src/auth/session.ts\0",
      commands: ["pnpm test"],
      dependency_changes: [
        { name: "zod", from: "3.25.0", to: "4.0.0", major: true },
      ],
    };

    expect(PostDiffInput.parse(input)).toEqual(input);
    expect(
      PostDiffInput.safeParse({
        ...input,
        base_commit_sha: "not-a-commit",
      }).success,
    ).toBe(false);
  });

  it("applies bounded delivery budget defaults", () => {
    expect(DeliveryBudget.parse({})).toEqual({
      max_builder_iterations: 3,
      max_review_rounds: 3,
      max_wall_time_ms: 5_400_000,
      max_no_progress_rounds: 2,
    });
    expect(
      DeliveryBudget.safeParse({
        max_builder_iterations: 0,
      }).success,
    ).toBe(false);
  });
});
