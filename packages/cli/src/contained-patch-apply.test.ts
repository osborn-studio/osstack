import { parseMissionPatch } from "@osstack/governance";
import { describe, expect, it } from "vitest";
import { applyContainedPatchFile } from "./contained-patch-apply.js";

const files = (patch: string) => { const parsed = parseMissionPatch(patch); if (!parsed.ok) throw new Error(JSON.stringify(parsed.rejections)); return parsed.files; };
const one = (patch: string) => { const all = files(patch); expect(all).toHaveLength(1); return all[0]!; };

describe("contained patch application", () => {
  it("applies modify hunks exactly and keeps untouched lines", () => {
    const change = one("diff --git a/x b/x\nindex 1111111..2222222 100644\n--- a/x\n+++ b/x\n@@ -2,2 +2,2 @@ ctx\n b\n-c\n+C\n@@ -5 +5,2 @@\n-e\n+E\n+F\n");
    expect(applyContainedPatchFile(change, "a\nb\nc\nd\ne\n")).toBe("a\nb\nC\nd\nE\nF\n");
  });
  it("adds and deletes whole files, including a header-only empty addition", () => {
    expect(applyContainedPatchFile(one("--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+x\n+y\n"), null)).toBe("x\ny\n");
    expect(applyContainedPatchFile(one("--- a/old.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n"), "x\ny\n")).toBeNull();
    const empty = one("diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000000..e69de29\n");
    expect(empty).toMatchObject({ path: "empty.txt", kind: "add", hunks: [] });
    expect(applyContainedPatchFile(empty, null)).toBe("");
  });
  it("takes paths from the classifier, so hunk text cannot add a target", () => {
    const smuggle = "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,2 +1,2 @@\n hi\n---- /dev/null\n++++ b/package.json\n";
    const parsed = files(smuggle);
    expect(parsed.map(f => f.path)).toEqual(["src/a.txt"]);
    expect(applyContainedPatchFile(parsed[0]!, "hi\n--- /dev/null\n")).toBe("hi\n+++ b/package.json\n");
  });
  it("decodes git-quoted paths the same way the classifier does", () => {
    expect(one('--- "a/src/\\303\\251.txt"\n+++ "b/src/\\303\\251.txt"\n@@ -1 +1 @@\n-a\n+b\n').path).toBe("src/é.txt");
  });
  it("honours missing final newlines on either side", () => {
    expect(applyContainedPatchFile(one("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n"), "a")).toBe("b\n");
    expect(applyContainedPatchFile(one("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n"), "a\n")).toBe("b");
    expect(applyContainedPatchFile(one("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"), "a\nz")).toBe("b\nz");
  });
  it("keeps the copied prefix's newline when deleting an unterminated last line", () => {
    expect(applyContainedPatchFile(one("--- a/x\n+++ b/x\n@@ -2 +1,0 @@\n-b\n\\ No newline at end of file\n"), "a\nb")).toBe("a\n");
  });
  it("rejects final-newline drift on the old side", () => {
    expect(() => applyContainedPatchFile(one("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"), "a")).toThrow("CONTAINED_PATCH_MISMATCH");
    expect(() => applyContainedPatchFile(one("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n"), "a\n")).toThrow("CONTAINED_PATCH_MISMATCH");
  });
  it("refuses any drift instead of fuzzing", () => {
    const change = one("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
    expect(() => applyContainedPatchFile(change, "q\n")).toThrow("CONTAINED_PATCH_MISMATCH");
    expect(() => applyContainedPatchFile(change, null)).toThrow("CONTAINED_PATCH_MISMATCH");
    expect(() => applyContainedPatchFile(one("--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+a\n"), "exists\n")).toThrow("CONTAINED_PATCH_MISMATCH");
    expect(() => applyContainedPatchFile(one("--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n"), "a\nb\n")).toThrow("CONTAINED_PATCH_MISMATCH");
  });
});
