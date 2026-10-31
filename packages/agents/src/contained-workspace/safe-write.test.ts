import { execFileSync } from "node:child_process";
import { link, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createScratchDir } from "@osstack/core";
import { describe, expect, it } from "vitest";
import { SafeFileError, safeReadFile, safeRemoveFile, safeWriteFile } from "./safe-write.js";

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof SafeFileError ? error.code : String(error)),
  );

async function fixture() {
  const dir = await createScratchDir("tests", "safe-write");
  const root = join(dir, "root");
  const outside = join(dir, "outside");
  await mkdir(root);
  await mkdir(outside);
  return { root, outside };
}

describe("safeWriteFile", () => {
  it("writes, creates parents, applies the mode and leaves no temp files", async () => {
    const { root } = await fixture();
    const result = await safeWriteFile(root, "a/b/run.sh", "#!/bin/sh\n", 0o755);
    expect(await readFile(join(root, "a/b/run.sh"), "utf8")).toBe("#!/bin/sh\n");
    expect((await stat(join(root, "a/b/run.sh"))).mode & 0o777).toBe(0o755);
    expect(result.size).toBe(10);
    await safeWriteFile(root, "a/b/run.sh", "replaced\n");
    const read = await safeReadFile(root, "a/b/run.sh");
    expect(read.bytes.toString()).toBe("replaced\n");
    expect(read.executable).toBe(false);
    expect(await readdir(join(root, "a/b"))).toEqual(["run.sh"]);
  });

  it("rejects a symlinked parent component without writing outside", async () => {
    const { root, outside } = await fixture();
    await symlink(outside, join(root, "link"));
    expect(await code(safeWriteFile(root, "link/x.txt", "x"))).toBe("SAFE_PATH_SYMLINK_COMPONENT");
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects a symlink target", async () => {
    const { root, outside } = await fixture();
    await writeFile(join(outside, "secret"), "keep");
    await symlink(join(outside, "secret"), join(root, "file.txt"));
    expect(await code(safeWriteFile(root, "file.txt", "x"))).toBe("SAFE_PATH_SYMLINK");
    expect(await code(safeReadFile(root, "file.txt"))).toBe("SAFE_PATH_SYMLINK");
    expect(await code(safeRemoveFile(root, "file.txt"))).toBe("SAFE_PATH_SYMLINK");
    expect(await readFile(join(outside, "secret"), "utf8")).toBe("keep");
  });

  it("rejects a hard-linked file", async () => {
    const { root, outside } = await fixture();
    await writeFile(join(outside, "shared"), "keep");
    await link(join(outside, "shared"), join(root, "file.txt"));
    expect(await code(safeWriteFile(root, "file.txt", "x"))).toBe("SAFE_PATH_HARDLINK");
    expect(await code(safeRemoveFile(root, "file.txt"))).toBe("SAFE_PATH_HARDLINK");
    expect(await readFile(join(outside, "shared"), "utf8")).toBe("keep");
  });

  it("rejects unsafe relative paths", async () => {
    const { root } = await fixture();
    for (const path of ["../x", "a/../../x", "/etc/passwd", "a//b", ".git/config", "a/.GIT/x", "a\u0001b", "a\\b", "", "./x"]) {
      expect(await code(safeWriteFile(root, path, "x")), path).toBe("SAFE_PATH_INVALID");
    }
  });

  it("rejects a non-directory parent and removes regular files", async () => {
    const { root } = await fixture();
    await writeFile(join(root, "plain"), "x");
    expect(await code(safeWriteFile(root, "plain/child", "x"))).toBe("SAFE_PATH_NOT_DIRECTORY");
    await safeRemoveFile(root, "plain");
    expect(await readdir(root)).toEqual([]);
    expect(await code(safeRemoveFile(root, "plain"))).toBe("SAFE_PATH_NOT_FOUND");
  });

  it("rejects a named pipe without blocking", async () => {
    const { root } = await fixture();
    execFileSync("mkfifo", [join(root, "pipe")]);
    expect(await code(safeReadFile(root, "pipe"))).toBe("SAFE_PATH_NOT_REGULAR");
    expect(await code(safeWriteFile(root, "pipe", "x"))).toBe("SAFE_PATH_NOT_REGULAR");
  });
});
