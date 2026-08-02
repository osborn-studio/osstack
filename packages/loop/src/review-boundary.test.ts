import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectReviewBoundary } from "./review-boundary.js";

let root: string;
let workspace: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "osstack-review-boundary-"));
  workspace = join(root, "repo");
  await mkdir(join(workspace, "src"), { recursive: true });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "test"]);
  git(["config", "user.email", "test@example.invalid"]);
  await writeFile(join(workspace, "src/app.ts"), "export const base = true;\n");
  git(["add", "."]);
  git(["commit", "-m", "base"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("collectReviewBoundary", () => {
  it("collects tracked and untracked text with argv-safe Git calls", async () => {
    await writeFile(join(workspace, "src/app.ts"), "export const changed = true;\n");
    await writeFile(join(workspace, "src/new file.ts"), "export const added = true;\n");

    const result = await collectReviewBoundary(workspace);

    expect(result.boundary.pass).toBe(true);
    expect(result.boundary.changed_paths).toEqual([
      "src/app.ts",
      "src/new file.ts",
    ]);
    expect(result.sanitized_diff).toContain("diff --git");
    expect(result.sanitized_diff).toContain("export const changed = true");
    expect(result.sanitized_diff).toContain("<UNTRACKED_FILE");
    expect(result.sanitized_diff).toContain("export const added = true");
  });

  it("uses NUL-delimited path parsing", async () => {
    const path = "src/line\nbreak.ts";
    await writeFile(join(workspace, path), "export const newline = true;\n");

    const result = await collectReviewBoundary(workspace);

    expect(result.boundary.pass).toBe(true);
    expect(result.boundary.changed_paths).toContain(path);
  });

  it("blocks secrets and does not return a reviewer diff", async () => {
    await writeFile(
      join(workspace, "src/app.ts"),
      'api_key = "this-is-a-secret-value"\n',
    );

    const result = await collectReviewBoundary(workspace);

    expect(ruleIds(result)).toContain("review.secret_detected");
    expect(result.sanitized_diff).toBeUndefined();
  });

  it("blocks a secret present only in a deleted file diff", async () => {
    const removedPath = join(workspace, "src/removed.ts");
    await writeFile(removedPath, 'api_key = "removed-but-still-sensitive"\n');
    git(["add", "."]);
    git(["commit", "-m", "add sensitive fixture"]);
    await rm(removedPath);

    const result = await collectReviewBoundary(workspace);

    expect(ruleIds(result)).toContain("review.secret_detected");
    expect(result.sanitized_diff).toBeUndefined();
  });

  it("blocks forbidden paths without reading them", async () => {
    await writeFile(join(workspace, ".env"), "TOKEN=do-not-read\n");

    const result = await collectReviewBoundary(workspace);

    expect(ruleIds(result)).toContain("review.forbidden_path");
    expect(result.sanitized_diff).toBeUndefined();
  });

  it("blocks an escaping symlink", async () => {
    const external = join(root, "external.ts");
    await writeFile(external, "export const external = true;\n");
    await symlink(external, join(workspace, "src/external.ts"));

    const result = await collectReviewBoundary(workspace);

    expect(ruleIds(result)).toContain("review.symlink_escape");
    expect(result.sanitized_diff).toBeUndefined();
  });

  it("blocks files over the per-file limit", async () => {
    await writeFile(join(workspace, "src/large.ts"), "x".repeat(100));

    const result = await collectReviewBoundary(workspace, {
      max_file_bytes: 50,
    });

    expect(ruleIds(result)).toContain("review.file_too_large");
  });

  it("blocks a total diff over the byte limit", async () => {
    await writeFile(join(workspace, "src/app.ts"), `export const value = "${"x".repeat(200)}";\n`);

    const result = await collectReviewBoundary(workspace, {
      max_total_bytes: 64,
    });

    expect(ruleIds(result)).toContain("review.diff_too_large");
  });

  it("blocks binary and non-allowlisted files", async () => {
    await writeFile(join(workspace, "src/blob.ts"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(workspace, "image.png"), Buffer.from([1, 2, 3]));

    const result = await collectReviewBoundary(workspace);

    expect(ruleIds(result)).toContain("review.binary_disallowed");
    expect(result.sanitized_diff).toBeUndefined();
  });
});

function git(args: string[]): void {
  execFileSync("git", args, { cwd: workspace, stdio: "ignore" });
}

function ruleIds(
  result: Awaited<ReturnType<typeof collectReviewBoundary>>,
): string[] {
  return result.boundary.findings.map((finding) => finding.rule_id);
}
