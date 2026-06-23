import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];
let oldHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-checkpoint-cli-"));
  oldHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = join(tmp, "home");
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (oldHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = oldHome;
  await rm(tmp, { recursive: true, force: true });
});

describe("checkpoint CLI", () => {
  it("creates a shadow checkpoint outside the workspace without copying .git", async () => {
    const workspace = join(tmp, "workspace");
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, ".git"), { recursive: true });
    await writeFile(join(workspace, "src", "app.ts"), "export const value = 1;\n");
    await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");

    const exitCode = await main(["checkpoint", "create", "--workspace", workspace, "--json"]);
    const realWorkspace = realpathSync(workspace);

    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    const summary = JSON.parse(logs.join("\n")) as {
      checkpoint_id: string;
      checkpoint_dir: string;
      metadata_path: string;
      files: number;
      bytes: number;
    };
    expect(summary.checkpoint_id).toMatch(/^chk_/);
    expect(summary.checkpoint_dir).toContain(join(tmp, "home", "checkpoints"));
    expect(summary.checkpoint_dir.startsWith(realWorkspace)).toBe(false);
    expect(summary.files).toBe(1);
    expect(summary.bytes).toBeGreaterThan(0);

    await expect(readFile(join(summary.checkpoint_dir, "files", "src", "app.ts"), "utf-8"))
      .resolves.toBe("export const value = 1;\n");
    await expect(readFile(join(summary.checkpoint_dir, "files", ".git", "HEAD"), "utf-8"))
      .rejects.toThrow();
    const metadata = JSON.parse(await readFile(summary.metadata_path, "utf-8")) as {
      kind: string;
      workspace: string;
      files: Array<{ path: string; sha256: string; bytes: number }>;
      exclusions: string[];
    };
    expect(metadata).toMatchObject({
      kind: "osstack.shadow_checkpoint",
      workspace: realWorkspace,
      files: [expect.objectContaining({
        path: "src/app.ts",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      })],
      exclusions: expect.arrayContaining([".git", "node_modules"]),
    });
  });

  it("dry-runs checkpoint restore by default without changing workspace files", async () => {
    const workspace = join(tmp, "workspace");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "app.ts"), "export const value = 1;\n");

    const createExitCode = await main(["checkpoint", "create", "--workspace", workspace, "--json"]);
    expect(createExitCode).toBe(0);
    const created = JSON.parse(logs.join("\n")) as { checkpoint_id: string };

    logs = [];
    await writeFile(join(workspace, "src", "app.ts"), "export const value = 2;\n");
    const restoreExitCode = await main(["checkpoint", "restore", created.checkpoint_id, "--json"]);

    expect(restoreExitCode).toBe(0);
    const restored = JSON.parse(logs.join("\n")) as {
      mode: string;
      restored_files: number;
      files: Array<{ path: string; target: string }>;
    };
    expect(restored).toMatchObject({
      mode: "dry-run",
      restored_files: 1,
      files: [expect.objectContaining({ path: "src/app.ts" })],
    });
    await expect(readFile(join(workspace, "src", "app.ts"), "utf-8"))
      .resolves.toBe("export const value = 2;\n");
  });

  it("restores checkpoint files with --apply without deleting newer files", async () => {
    const workspace = join(tmp, "workspace");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "app.ts"), "export const value = 1;\n");

    const createExitCode = await main(["checkpoint", "create", "--workspace", workspace, "--json"]);
    expect(createExitCode).toBe(0);
    const created = JSON.parse(logs.join("\n")) as { checkpoint_dir: string };

    logs = [];
    await writeFile(join(workspace, "src", "app.ts"), "export const value = 3;\n");
    await writeFile(join(workspace, "src", "new.ts"), "export const newer = true;\n");
    const restoreExitCode = await main(["checkpoint", "restore", created.checkpoint_dir, "--apply", "--json"]);

    expect(restoreExitCode).toBe(0);
    const restored = JSON.parse(logs.join("\n")) as {
      mode: string;
      workspace: string;
      restored_files: number;
      bytes: number;
    };
    expect(restored).toMatchObject({
      mode: "applied",
      workspace: realpathSync(workspace),
      restored_files: 1,
    });
    expect(restored.bytes).toBeGreaterThan(0);
    await expect(readFile(join(workspace, "src", "app.ts"), "utf-8"))
      .resolves.toBe("export const value = 1;\n");
    await expect(readFile(join(workspace, "src", "new.ts"), "utf-8"))
      .resolves.toBe("export const newer = true;\n");
  });

  it("refuses to restore a tampered checkpoint file", async () => {
    const workspace = join(tmp, "workspace");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "app.ts"), "export const value = 1;\n");

    const createExitCode = await main(["checkpoint", "create", "--workspace", workspace, "--json"]);
    expect(createExitCode).toBe(0);
    const created = JSON.parse(logs.join("\n")) as { checkpoint_dir: string };

    logs = [];
    await writeFile(join(created.checkpoint_dir, "files", "src", "app.ts"), "tampered\n");
    await writeFile(join(workspace, "src", "app.ts"), "export const value = 4;\n");

    await expect(main(["checkpoint", "restore", created.checkpoint_dir, "--apply", "--json"]))
      .rejects.toThrow("checkpoint file sha256 mismatch: src/app.ts");
    await expect(readFile(join(workspace, "src", "app.ts"), "utf-8"))
      .resolves.toBe("export const value = 4;\n");
  });
});
