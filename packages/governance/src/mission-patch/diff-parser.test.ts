import { describe, expect, it } from "vitest";
import { MISSION_PATCH_MAX_BYTES, parseMissionPatch } from "./diff-parser.js";

const modify = (path = "src/app.ts") => [
  `diff --git a/${path} b/${path}`,
  "index 1111111..2222222 100644",
  `--- a/${path}`,
  `+++ b/${path}`,
  "@@ -1,2 +1,3 @@",
  " export const a = 1;",
  "-export const b = 2;",
  "+export const b = 3;",
  "+export const c = 4;",
  "",
].join("\n");

function codes(patch: string | Uint8Array): string[] {
  const result = parseMissionPatch(patch);
  return result.ok ? [] : result.rejections.map((rejection) => rejection.code);
}

describe("parseMissionPatch", () => {
  it("parses a modification with line counts and new-file line numbers", () => {
    const result = parseMissionPatch(modify());
    expect(result).toEqual({
      ok: true,
      files: [{
        path: "src/app.ts",
        kind: "modify",
        added: 2,
        removed: 1,
        addedBytes: 40,
        addedLines: [{ line: 2, text: "export const b = 3;" }, { line: 3, text: "export const c = 4;" }],
      }],
    });
  });

  it("recognises new files, deletions (by mode or /dev/null) and empty new files", () => {
    const patch = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+export {};",
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "index 4444444..0000000",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-a",
      "-b",
      "--- a/src/plain.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/src/empty.ts b/src/empty.ts",
      "new file mode 100644",
      "index 0000000..e69de29",
      "",
    ].join("\n");
    const result = parseMissionPatch(patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map(({ path, kind, added, removed }) => ({ path, kind, added, removed }))).toEqual([
      { path: "src/new.ts", kind: "add", added: 1, removed: 0 },
      { path: "src/old.ts", kind: "delete", added: 0, removed: 2 },
      { path: "src/plain.ts", kind: "delete", added: 0, removed: 1 },
      { path: "src/empty.ts", kind: "add", added: 0, removed: 0 },
    ]);
  });

  it("accepts plain unified sections and the no-newline marker", () => {
    const patch = [
      "--- a/README.md\t2026-10-31 00:00:00",
      "+++ b/README.md\t2026-10-31 00:00:01",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(parseMissionPatch(patch)).toMatchObject({ ok: true, files: [{ path: "README.md", added: 1, removed: 1 }] });
  });

  it("decodes quoted paths before validating them", () => {
    const patch = modify("docs/x.md")
      .replaceAll("a/docs/x.md", "\"a/docs/\\346\\227\\245.md\"")
      .replaceAll("b/docs/x.md", "\"b/docs/\\346\\227\\245.md\"");
    expect(parseMissionPatch(patch)).toMatchObject({ ok: true, files: [{ path: "docs/日.md" }] });
    const control = modify("x").replaceAll("a/x", "\"a/x\\ty\"").replaceAll("b/x", "\"b/x\\ty\"");
    expect(codes(control)).toContain("PATH_CONTROL_CHAR");
  });

  it("rejects oversized, non-UTF-8 and empty input", () => {
    expect(codes("x".repeat(MISSION_PATCH_MAX_BYTES + 1))).toEqual(["PATCH_TOO_LARGE"]);
    expect(codes("é".repeat(MISSION_PATCH_MAX_BYTES / 2 + 1))).toEqual(["PATCH_TOO_LARGE"]);
    expect(codes(new Uint8Array(MISSION_PATCH_MAX_BYTES + 1))).toEqual(["PATCH_TOO_LARGE"]);
    expect(codes(new Uint8Array([0x2b, 0xff, 0xfe]))).toEqual(["PATCH_NOT_UTF8"]);
    expect(codes(`${modify()}\ud800`)).toEqual(["PATCH_NOT_UTF8"]);
    expect(codes("")).toEqual(["PATCH_EMPTY"]);
    expect(parseMissionPatch(new TextEncoder().encode(modify())).ok).toBe(true);
  });

  it.each([
    ["rename", ["diff --git a/a.ts b/b.ts", "similarity index 90%", "rename from a.ts", "rename to b.ts"], "RENAME_REJECTED"],
    ["copy", ["diff --git a/a.ts b/b.ts", "similarity index 100%", "copy from a.ts", "copy to b.ts"], "COPY_REJECTED"],
    ["mode change", ["diff --git a/a.sh b/a.sh", "old mode 100644", "new mode 100755"], "MODE_CHANGE_REJECTED"],
    ["executable new file", ["diff --git a/a.sh b/a.sh", "new file mode 100755", "index 0000000..1111111"], "MODE_CHANGE_REJECTED"],
    ["symlink", ["diff --git a/l b/l", "new file mode 120000", "index 0000000..1111111", "--- /dev/null", "+++ b/l", "@@ -0,0 +1 @@", "+/etc/passwd"], "SYMLINK_REJECTED"],
    ["symlink modify", ["diff --git a/l b/l", "index 1111111..2222222 120000", "--- a/l", "+++ b/l", "@@ -1 +1 @@", "-x", "+y"], "SYMLINK_REJECTED"],
    ["submodule", ["diff --git a/vendor/m b/vendor/m", "new file mode 160000", "index 0000000..1111111"], "SUBMODULE_REJECTED"],
    ["git binary patch", ["diff --git a/i.png b/i.png", "new file mode 100644", "index 0000000..1111111", "GIT binary patch", "literal 3", "abc"], "BINARY_REJECTED"],
    ["binary files", ["diff --git a/i.png b/i.png", "index 1111111..2222222 100644", "Binary files a/i.png and b/i.png differ"], "BINARY_REJECTED"],
  ])("rejects %s", (_name, lines, code) => {
    expect(codes(`${lines.join("\n")}\n`)).toContain(code);
  });

  it.each([
    ["../escape.ts", "PATH_TRAVERSAL"],
    ["src/../../escape.ts", "PATH_TRAVERSAL"],
    ["src/./a.ts", "PATH_TRAVERSAL"],
    ["src\\a.ts", "PATH_BACKSLASH"],
    [".git/config", "PATH_GIT_DIR"],
    ["sub/.GIT/hooks/pre-commit", "PATH_GIT_DIR"],
    ["src//a.ts", "PATH_INVALID"],
    ["src/a\u0001.ts", "PATH_CONTROL_CHAR"],
  ])("rejects unsafe path %j", (path, code) => {
    expect(codes(modify(path))).toContain(code);
  });

  it("rejects absolute paths", () => {
    const patch = ["--- /etc/passwd", "+++ /etc/passwd", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    expect(codes(patch)).toEqual(["PATCH_MALFORMED"]);
    expect(codes(modify("x").replaceAll("a/x", "a//etc/x").replaceAll("b/x", "b//etc/x"))).toContain("PATH_ABSOLUTE");
  });

  it.each([
    ["too few lines", ["--- a/x", "+++ b/x", "@@ -1,3 +1,3 @@", " a", "-b", "+c"]],
    ["too many lines", ["--- a/x", "+++ b/x", "@@ -1 +1 @@", "-a", "+b", "+c"]],
    ["bad header", ["--- a/x", "+++ b/x", "@@ -1 +1", "-a", "+b"]],
    ["empty context line", ["--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", "", "-a", "+b"]],
    ["no hunks", ["--- a/x", "+++ b/x"]],
    ["new file with old lines", ["--- /dev/null", "+++ b/x", "@@ -1 +1 @@", "-a", "+b"]],
    ["unordered hunks", ["--- a/x", "+++ b/x", "@@ -5 +5 @@", "-a", "+b", "@@ -1 +1 @@", "-c", "+d"]],
  ])("rejects malformed hunk: %s", (_name, lines) => {
    expect(codes(`${lines.join("\n")}\n`)).toEqual(["HUNK_MALFORMED"]);
  });

  it("rejects stray text, mismatched paths and duplicate files", () => {
    expect(codes(`Here is the patch:\n${modify()}`)).toEqual(["PATCH_MALFORMED"]);
    expect(codes(modify().replace("+++ b/src/app.ts", "+++ b/src/other.ts"))).toEqual(["PATCH_MALFORMED"]);
    expect(codes(modify() + modify())).toEqual(["DUPLICATE_FILE"]);
  });

  it("reports every rejection in a stable order", () => {
    const patch = [
      "diff --git a/b.sh b/b.sh",
      "old mode 100644",
      "new mode 100755",
      "diff --git a/a.ts b/c.ts",
      "rename from a.ts",
      "rename to c.ts",
      "",
    ].join("\n");
    const first = parseMissionPatch(patch);
    expect(first).toEqual({
      ok: false,
      rejections: [
        { code: "MODE_CHANGE_REJECTED", path: "b.sh", patchLine: 2 },
        { code: "MODE_CHANGE_REJECTED", path: "b.sh", patchLine: 3 },
        { code: "RENAME_REJECTED", patchLine: 5 },
        { code: "RENAME_REJECTED", patchLine: 6 },
      ],
    });
    expect(parseMissionPatch(patch)).toEqual(first);
  });
});
