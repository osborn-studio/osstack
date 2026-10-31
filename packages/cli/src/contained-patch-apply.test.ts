import { describe, expect, it } from "vitest";
import { applyContainedPatchFile, parseContainedPatch } from "./contained-patch-apply.js";

const one = (patch: string) => { const files = parseContainedPatch(patch); expect(files).toHaveLength(1); return files[0]!; };

describe("contained patch application", () => {
  it("applies modify hunks exactly and keeps untouched lines", () => {
    const change = one("diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -2,2 +2,2 @@ ctx\n b\n-c\n+C\n@@ -5 +5,2 @@\n-e\n+E\n+F\n");
    expect(applyContainedPatchFile(change, "a\nb\nc\nd\ne\n")).toBe("a\nb\nC\nd\nE\nF\n");
  });
  it("adds and deletes whole files", () => {
    expect(applyContainedPatchFile(one("--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+x\n+y\n"), null)).toBe("x\ny\n");
    expect(applyContainedPatchFile(one("--- a/old.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n"), "x\ny\n")).toBeNull();
  });
  it("honours missing final newlines on either side", () => {
    expect(applyContainedPatchFile(one("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n"), "a")).toBe("b\n");
    expect(applyContainedPatchFile(one("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n"), "a\n")).toBe("b");
    expect(applyContainedPatchFile(one("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n"), "a\nz")).toBe("b\nz");
  });
  it("refuses any drift instead of fuzzing", () => {
    const change = one("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
    expect(() => applyContainedPatchFile(change, "q\n")).toThrow("CONTAINED_PATCH_MISMATCH");
    expect(() => applyContainedPatchFile(change, null)).toThrow("CONTAINED_PATCH_MISMATCH");
    expect(() => applyContainedPatchFile(one("--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+a\n"), "exists\n")).toThrow("CONTAINED_PATCH_MISMATCH");
    expect(() => applyContainedPatchFile(one("--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n"), "a\nb\n")).toThrow("CONTAINED_PATCH_MISMATCH");
  });
});
