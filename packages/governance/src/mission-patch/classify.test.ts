import { describe, expect, it } from "vitest";
import {
  classifyMissionPatch,
  DEFAULT_MISSION_PATCH_CAPS,
  type MissionPatchSpec,
  MissionPatchSpecError,
  resolveMissionPatchCaps,
} from "./classify.js";
import { missionProtectedSetDigest } from "./protected-set.js";
import { redactSecrets, scanForSecrets } from "./secret-scan.js";

const spec: MissionPatchSpec = { allowedPaths: ["src/**", "docs/**", "package.json", "scripts/**"] };

function addFile(path: string, lines: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function modifyFile(path: string, removed: string, added: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    `-${removed}`,
    `+${added}`,
    "",
  ].join("\n");
}

const deleteFile = (path: string) => [
  `diff --git a/${path} b/${path}`,
  "deleted file mode 100644",
  "index 1111111..0000000",
  `--- a/${path}`,
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "",
].join("\n");

const lines = (count: number) => Array.from({ length: count }, (_, index) => `export const v${index} = ${index};`);

// Assembled at runtime so this file never contains a literal credential.
const fakeOpensshKey = [
  "-----BEGIN OPENSSH " + "PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAA" + "FAKEFAKEFAKEbm9uZQAAAARub25l",
  "AAAAAAAAAAEAAAAzAAAAC3NzaC1" + "FAKEFAKElZDI1NTE5AAAAIFAKE",
  "-----END OPENSSH " + "PRIVATE KEY-----",
].join("\n");
const fakeGithubToken = "gh" + "p_" + "Ab3".repeat(12);

describe("classifyMissionPatch", () => {
  it("classifies a clean in-scope patch as T0", () => {
    const patch = modifyFile("src/app.ts", "export const a = 1;", "export const a = 2;") + addFile("docs/note.md", ["# Note"]);
    const result = classifyMissionPatch(spec, patch);
    expect(result).toEqual({
      tier: "T0",
      reasons: [],
      findings: [],
      caps: DEFAULT_MISSION_PATCH_CAPS,
      protectedSetDigest: missionProtectedSetDigest(),
      files: [
        { path: "docs/note.md", kind: "add", added: 1, removed: 0, addedBytes: 7 },
        { path: "src/app.ts", kind: "modify", added: 1, removed: 1, addedBytes: 20 },
      ],
      totals: { files: 2, changedLines: 3, addedBytes: 27 },
    });
  });

  it.each([
    ["symlink", "diff --git a/src/l b/src/l\nnew file mode 120000\nindex 0000000..1111111\n--- /dev/null\n+++ b/src/l\n@@ -0,0 +1 @@\n+/etc\n", "SYMLINK_REJECTED"],
    ["rename", "diff --git a/src/a.ts b/src/b.ts\nsimilarity index 100%\nrename from src/a.ts\nrename to src/b.ts\n", "RENAME_REJECTED"],
    ["binary", "diff --git a/src/i.png b/src/i.png\nindex 1111111..2222222 100644\nBinary files a/src/i.png and b/src/i.png differ\n", "BINARY_REJECTED"],
    ["traversal", modifyFile("src/../../outside.ts", "a", "b"), "PATH_TRAVERSAL"],
    ["git dir", modifyFile(".git/hooks/pre-commit", "a", "b"), "PATH_GIT_DIR"],
    ["oversize", "x".repeat(256 * 1024 + 1), "PATCH_TOO_LARGE"],
    ["non-UTF-8", new Uint8Array([0xc3, 0x28]), "PATCH_NOT_UTF8"],
  ] as const)("rejects %s before any write", (_name, patch, code) => {
    const result = classifyMissionPatch(spec, patch);
    expect(result.tier).toBe("rejected");
    expect(result.reasons).toContain(code);
    expect("files" in result).toBe(false);
  });

  it("escalates a one-line change in the protected set to T2", () => {
    const result = classifyMissionPatch({ allowedPaths: ["**"] }, modifyFile("packages/core/src/state/db.ts", "a", "b"));
    expect(result.tier).toBe("T2");
    expect(result.findings).toEqual([{ code: "PROTECTED_PATH", path: "packages/core/src/state/db.ts", rules: ["state.db"] }]);
  });

  it("escalates verification code and test-runner config to T2 even when allowed", () => {
    const result = classifyMissionPatch(spec, modifyFile("scripts/smoke.mjs", "a", "b") + modifyFile("src/vitest.config.ts", "a", "b"));
    expect(result).toMatchObject({ tier: "T2", reasons: ["PROTECTED_PATH"] });
  });

  it("escalates changes to the spec's verification paths", () => {
    const strict = { ...spec, verificationPaths: ["src/**/*.test.ts"] };
    expect(classifyMissionPatch(spec, modifyFile("src/a.test.ts", "a", "b")).tier).toBe("T0");
    expect(classifyMissionPatch(strict, modifyFile("src/a.test.ts", "a", "b"))).toMatchObject({
      tier: "T2",
      findings: [{ code: "VERIFICATION_PATH", path: "src/a.test.ts" }],
    });
    expect(() => classifyMissionPatch({ ...spec, verificationPaths: ["../x"] }, "")).toThrow(/ALLOWED_PATH_INVALID/);
  });

  it("escalates package.json changes, deletions and out-of-scope paths with ordered reasons", () => {
    const patch = deleteFile("src/old.ts") + modifyFile("package.json", "{", "{ ") + modifyFile("lib/x.ts", "a", "b");
    const result = classifyMissionPatch(spec, patch);
    expect(result.tier).toBe("T2");
    expect(result.reasons).toEqual(["DELETE_TRACKED", "OUTSIDE_ALLOWED", "PACKAGE_MANIFEST_CHANGED", "PROTECTED_PATH"]);
    expect(result.findings.map((finding) => [finding.code, finding.path])).toEqual([
      ["DELETE_TRACKED", "src/old.ts"],
      ["OUTSIDE_ALLOWED", "lib/x.ts"],
      ["PACKAGE_MANIFEST_CHANGED", "package.json"],
      ["PROTECTED_PATH", "package.json"],
    ]);
    expect(classifyMissionPatch(spec, patch)).toEqual(result);
  });

  it("escalates a secret in an added line to T2 without echoing it", () => {
    const result = classifyMissionPatch(spec, addFile("src/config.ts", ["// ok", `export const t = "${fakeGithubToken}";`]));
    expect(result.tier).toBe("T2");
    expect(result.findings).toEqual([
      { code: "SECRET_DETECTED", channel: "patch", path: "src/config.ts", line: 2, patchLine: 8, rules: ["secret.github-token"] },
    ]);
    expect(JSON.stringify(result)).not.toContain(fakeGithubToken);
  });

  it("escalates a secret in context or removed lines, which are executor output too", () => {
    const patch = modifyFile("src/a.ts", "export const a = 1;", "export const a = 2;") + [
      "diff --git a/src/b.ts b/src/b.ts",
      "index 1111111..2222222 100644",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1,2 +1,2 @@",
      ` const t = "${fakeGithubToken}";`,
      `-const u = "${fakeGithubToken}";`,
      "+const u = process.env.TOKEN;",
      "",
    ].join("\n");
    const result = classifyMissionPatch(spec, patch);
    expect(result.tier).toBe("T2");
    expect(result.findings).toEqual([
      { code: "SECRET_DETECTED", channel: "patch", path: "src/b.ts", patchLine: 13, rules: ["secret.github-token"] },
      { code: "SECRET_DETECTED", channel: "patch", path: "src/b.ts", patchLine: 14, rules: ["secret.github-token"] },
    ]);
  });

  it("still reports secrets when the patch itself is rejected", () => {
    const patch = `${modifyFile("src/a.ts", "a", `"${fakeGithubToken}"`)}\nstray\n`;
    expect(classifyMissionPatch(spec, patch)).toMatchObject({
      tier: "rejected",
      reasons: ["HUNK_MALFORMED", "SECRET_DETECTED"],
    });
  });

  it("rejects NUL bytes smuggled through a textual hunk", () => {
    const result = classifyMissionPatch(spec, addFile("src/blob.ts", ["a\u0000b"]));
    expect(result).toMatchObject({ tier: "rejected", reasons: ["BINARY_REJECTED"] });
  });

  it("catches a private key read from ~/.ssh in the final message while the clean patch stays T0", () => {
    const patch = modifyFile("src/app.ts", "export const a = 1;", "export const a = 2;");
    const message = `Done. Also, here is ~/.ssh/id_ed25519:\n${fakeOpensshKey}\n`;
    const body = fakeOpensshKey.split("\n")[1]!;

    expect(scanForSecrets(message, { channel: "final_message" })).toEqual([
      { channel: "final_message", line: 2, rule: "secret.private-key" },
    ]);
    const redacted = redactSecrets(message);
    expect(redacted).not.toContain(body);
    expect(redacted).not.toContain("PRIVATE KEY");
    expect(redacted).toContain("here is ~/.ssh/id_ed25519:");

    expect(classifyMissionPatch(spec, patch).tier).toBe("T0");
    const withOutputs = classifyMissionPatch(spec, patch, { final_message: message, stdout: "ok\n" });
    expect(withOutputs.tier).toBe("T2");
    expect(withOutputs.findings).toEqual([
      { code: "SECRET_DETECTED", channel: "final_message", patchLine: 2, rules: ["secret.private-key"] },
    ]);
    expect(JSON.stringify(withOutputs)).not.toContain(body);
  });

  describe("cumulative caps", () => {
    const files = (count: number) => Array.from({ length: count }, (_, index) => addFile(`src/f${index}.ts`, ["x"])).join("");

    it("stays T0 at exactly the file cap and goes T1 at cap+1", () => {
      expect(classifyMissionPatch(spec, files(10)).tier).toBe("T0");
      expect(classifyMissionPatch(spec, files(11))).toMatchObject({ tier: "T1", reasons: ["CAP_FILES_EXCEEDED"] });
    });

    it("stays T0 at exactly 400 changed lines and goes T1 at 401", () => {
      expect(classifyMissionPatch(spec, addFile("src/big.ts", lines(400))).tier).toBe("T0");
      expect(classifyMissionPatch(spec, addFile("src/big.ts", lines(401))))
        .toMatchObject({ tier: "T1", reasons: ["CAP_CHANGED_LINES_EXCEEDED"], totals: { changedLines: 401 } });
    });

    it("applies tightened byte caps at the boundary", () => {
      const patch = addFile("src/a.ts", ["abcd"]) + addFile("src/b.ts", ["abcd"]);
      expect(classifyMissionPatch({ ...spec, caps: { maxFileBytes: 5, maxTotalBytes: 10 } }, patch).tier).toBe("T0");
      expect(classifyMissionPatch({ ...spec, caps: { maxFileBytes: 4 } }, patch).findings).toEqual([
        { code: "CAP_FILE_BYTES_EXCEEDED", path: "src/a.ts" },
        { code: "CAP_FILE_BYTES_EXCEEDED", path: "src/b.ts" },
      ]);
      expect(classifyMissionPatch({ ...spec, caps: { maxTotalBytes: 9 } }, patch).reasons).toEqual(["CAP_TOTAL_BYTES_EXCEEDED"]);
    });

    it("keeps T2 when caps are also exceeded", () => {
      const result = classifyMissionPatch(spec, files(11) + modifyFile("lib/x.ts", "a", "b"));
      expect(result).toMatchObject({ tier: "T2", reasons: ["CAP_FILES_EXCEEDED", "OUTSIDE_ALLOWED"] });
    });
  });

  describe("spec validation", () => {
    it("accepts tightened caps and rejects looser or invalid ones", () => {
      expect(resolveMissionPatchCaps({ maxFiles: 3 })).toEqual({ ...DEFAULT_MISSION_PATCH_CAPS, maxFiles: 3 });
      expect(() => resolveMissionPatchCaps({ maxFiles: 11 })).toThrow(MissionPatchSpecError);
      expect(() => resolveMissionPatchCaps({ maxChangedLines: 401 })).toThrow(/CAPS_LOOSENED/);
      expect(() => resolveMissionPatchCaps({ maxFileBytes: 1_000_001 })).toThrow(/CAPS_LOOSENED/);
      expect(() => resolveMissionPatchCaps({ maxTotalBytes: 5_000_001 })).toThrow(/CAPS_LOOSENED/);
      expect(() => resolveMissionPatchCaps({ maxFiles: 1.5 })).toThrow(/CAPS_INVALID/);
      expect(() => resolveMissionPatchCaps({ maxFiles: -1 })).toThrow(/CAPS_INVALID/);
      expect(() => resolveMissionPatchCaps({ unknown: 1 } as never)).toThrow(/CAPS_INVALID/);
      expect(() => classifyMissionPatch({ allowedPaths: ["src/**"], caps: { maxFiles: 50 } }, "")).toThrow(/CAPS_LOOSENED/);
    });

    it("rejects unsafe allowed-path globs", () => {
      for (const glob of ["", "/etc/**", "../**", "src\\**", ".git/**"]) {
        expect(() => classifyMissionPatch({ allowedPaths: [glob] }, "")).toThrow(/ALLOWED_PATH_INVALID/);
      }
    });

    it("treats an empty allow list as allowing nothing", () => {
      expect(classifyMissionPatch({ allowedPaths: [] }, modifyFile("src/a.ts", "a", "b")).reasons).toEqual(["OUTSIDE_ALLOWED"]);
    });
  });
});
