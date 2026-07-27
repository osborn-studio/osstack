import { describe, expect, it } from "vitest";
import {
  evaluateReviewBoundary,
  type ReviewBoundaryInput,
} from "./review-boundary.js";

const workspace = "/workspace";

function input(
  overrides: Partial<ReviewBoundaryInput> = {},
): ReviewBoundaryInput {
  return {
    workspace_path: workspace,
    changed_paths: ["src/app.ts"],
    files: [{
      path: "src/app.ts",
      resolved_path: "/workspace/src/app.ts",
      size_bytes: 24,
      kind: "text",
      content: "export const ok = true;\n",
      is_symlink: false,
    }],
    diff_bytes: 128,
    diff_content: "+export const ok = true;\n",
    forbidden_paths: [".env", ".git", ".ssh", ".aws", ".config"],
    max_file_bytes: 1_000_000,
    max_total_bytes: 5_000_000,
    allowed_extensions: [".ts", ".tsx", ".js", ".json", ".md", ".yaml", ".yml"],
    ...overrides,
  };
}

describe("evaluateReviewBoundary", () => {
  it("accepts bounded allowlisted text evidence", () => {
    const result = evaluateReviewBoundary(input());

    expect(result).toEqual({
      pass: true,
      findings: [],
      changed_paths: ["src/app.ts"],
      total_bytes: 24,
    });
  });

  it("blocks changed text containing secrets", () => {
    const result = evaluateReviewBoundary(input({
      files: [{
        path: "src/app.ts",
        resolved_path: "/workspace/src/app.ts",
        size_bytes: 40,
        kind: "text",
        content: 'api_key = "this-is-a-secret-value"\n',
        is_symlink: false,
      }],
    }));

    expect(ruleIds(result)).toContain("review.secret_detected");
  });

  it("blocks secrets present only in removed diff lines", () => {
    const result = evaluateReviewBoundary(input({
      files: [],
      diff_content: '-api_key = "removed-but-still-sensitive"\n',
    }));

    expect(ruleIds(result)).toContain("review.secret_detected");
  });

  it("blocks forbidden paths without inspecting their content", () => {
    const result = evaluateReviewBoundary(input({
      changed_paths: [".env"],
      files: [{
        path: ".env",
        resolved_path: "/workspace/.env",
        size_bytes: 100,
        kind: "unread",
        is_symlink: false,
      }],
    }));

    expect(ruleIds(result)).toContain("review.forbidden_path");
  });

  it("blocks symlinks that escape the workspace", () => {
    const result = evaluateReviewBoundary(input({
      changed_paths: ["src/external.ts"],
      files: [{
        path: "src/external.ts",
        resolved_path: "/private/external.ts",
        size_bytes: 20,
        kind: "unread",
        is_symlink: true,
      }],
    }));

    expect(ruleIds(result)).toContain("review.symlink_escape");
  });

  it("blocks files over the per-file byte limit", () => {
    const result = evaluateReviewBoundary(input({
      max_file_bytes: 10,
    }));

    expect(ruleIds(result)).toContain("review.file_too_large");
  });

  it("blocks diffs over the total byte limit", () => {
    const result = evaluateReviewBoundary(input({
      diff_bytes: 5_000_001,
    }));

    expect(ruleIds(result)).toContain("review.diff_too_large");
  });

  it("blocks binary and non-allowlisted file content", () => {
    const binary = evaluateReviewBoundary(input({
      files: [{
        path: "src/app.ts",
        resolved_path: "/workspace/src/app.ts",
        size_bytes: 10,
        kind: "binary",
        is_symlink: false,
      }],
    }));
    const extension = evaluateReviewBoundary(input({
      changed_paths: ["assets/image.png"],
      files: [{
        path: "assets/image.png",
        resolved_path: "/workspace/assets/image.png",
        size_bytes: 10,
        kind: "unread",
        is_symlink: false,
      }],
    }));

    expect(ruleIds(binary)).toContain("review.binary_disallowed");
    expect(ruleIds(extension)).toContain("review.binary_disallowed");
  });

  it("blocks lexical and resolved paths outside the workspace", () => {
    const lexical = evaluateReviewBoundary(input({
      changed_paths: ["../outside.ts"],
      files: [{
        path: "../outside.ts",
        resolved_path: "/outside.ts",
        size_bytes: 1,
        kind: "unread",
        is_symlink: false,
      }],
    }));
    const resolved = evaluateReviewBoundary(input({
      files: [{
        path: "src/app.ts",
        resolved_path: "/other/src/app.ts",
        size_bytes: 1,
        kind: "unread",
        is_symlink: false,
      }],
    }));

    expect(ruleIds(lexical)).toContain("review.path_outside_workspace");
    expect(ruleIds(resolved)).toContain("review.path_outside_workspace");
  });

  it("checks a forbidden resolved target for an in-workspace symlink", () => {
    const result = evaluateReviewBoundary(input({
      changed_paths: ["src/config.ts"],
      files: [{
        path: "src/config.ts",
        resolved_path: "/workspace/.config/private.ts",
        size_bytes: 10,
        kind: "unread",
        is_symlink: true,
      }],
    }));

    expect(ruleIds(result)).toContain("review.forbidden_path");
  });
});

function ruleIds(result: ReturnType<typeof evaluateReviewBoundary>): string[] {
  return result.findings.map((finding) => finding.rule_id);
}
