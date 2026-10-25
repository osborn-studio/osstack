import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ModuleKind, transpileModule } from "typescript";
import { createScratchDirSync } from "@osstack/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireDaemonLock, DaemonAlreadyRunningError, supportsLockFilesystem } from "./daemon-lock.js";

it.skipIf(process.platform !== "darwin")("uses the real named filesystem probe and rejects devfs", () => {
  expect(supportsLockFilesystem("darwin", 0x19, fixture)).toBe(true);
  expect(supportsLockFilesystem("darwin", 0x1a, "/dev")).toBe(false);
});

let fixture: string;
let pidFile: string;
let moduleUrl: string;
const children = new Set<ChildProcess>();
const releases: Array<() => void> = [];

beforeEach(() => {
  fixture = createScratchDirSync("tests", "daemon-lock-ownership");
  pidFile = join(fixture, "daemon.pid");
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const compiled = transpileModule(readFileSync(join(sourceDirectory, "daemon-lock.ts"), "utf8"), {
    compilerOptions: { module: ModuleKind.ESNext },
  }).outputText;
  const compiledPath = join(fixture, "daemon-lock.mjs");
  writeFileSync(compiledPath, compiled);
  symlinkSync(resolve(sourceDirectory, "../node_modules"), join(fixture, "node_modules"), "dir");
  moduleUrl = pathToFileURL(compiledPath).href;
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  }));
  children.clear();
  for (const release of releases.splice(0)) release();
  await rm(fixture, { recursive: true, force: true });
});

function acquire(): () => void {
  const release = acquireDaemonLock(pidFile);
  releases.push(release);
  return release;
}

function launch(code: string): { child: ChildProcess; nextLine: () => Promise<string> } {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let pending = "";
  let errors = "";
  child.stderr?.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  child.stdout?.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    while (pending.includes("\n")) {
      const newline = pending.indexOf("\n");
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line); else lines.push(line);
    }
  });
  return {
    child,
    nextLine: async () => {
      const queued = lines.shift();
      if (queued !== undefined) return queued;
      return await new Promise<string>((resolveLine, reject) => {
        const timer = setTimeout(() => reject(new Error(`child did not report: ${errors}`)), 8_000);
        waiters.push((line) => { clearTimeout(timer); resolveLine(line); });
      });
    },
  };
}

function ownerCode(afterAcquire = ""): string {
  return `
    import { acquireDaemonLock } from ${JSON.stringify(moduleUrl)};
    const release = acquireDaemonLock(${JSON.stringify(pidFile)});
    ${afterAcquire}
    console.log('owned');
    process.stdin.resume();
    process.stdin.on('data', () => { release(); process.exit(0); });
  `;
}

describe("daemon kernel ownership admission", () => {
  it.each(["daemon.pid", "daemon.pid.lock.db"])("rejects a dangling %s symlink without creating its target", (file) => {
    const target = join(fixture, "must-not-create");
    symlinkSync(target, join(fixture, file));
    expect(() => acquire()).toThrow("daemon_lock_requires_regular_file");
    expect(existsSync(target)).toBe(false);
  });

  it.each(["daemon.pid", "daemon.pid.lock.db"])("rejects a %s symlink without modifying existing evidence", (file) => {
    const target = join(fixture, "preserved-evidence");
    writeFileSync(target, "existing data");
    symlinkSync(target, join(fixture, file));
    expect(() => acquire()).toThrow("daemon_lock_requires_regular_file");
    expect(readFileSync(target, "utf8")).toBe("existing data");
  });

  it("refuses a second daemon in the same process", () => {
    acquire();
    expect(() => acquireDaemonLock(pidFile)).toThrow(DaemonAlreadyRunningError);
  });

  it("keeps one lock inode across ownership transfers", () => {
    const release = acquire();
    const identity = statSync(`${pidFile}.lock.db`);
    release();
    acquire();
    const next = statSync(`${pidFile}.lock.db`);
    expect({ dev: next.dev, ino: next.ino }).toEqual({ dev: identity.dev, ino: identity.ino });
  });

  it("an old release callback cannot release a newer owner", () => {
    const oldRelease = acquire();
    oldRelease();
    acquire();
    oldRelease();
    expect(() => acquireDaemonLock(pidFile)).toThrow(DaemonAlreadyRunningError);
  });

  it("a stale diagnostic PID cannot override live kernel ownership", () => {
    acquire();
    writeFileSync(pidFile, "0\n");
    expect(() => acquireDaemonLock(pidFile)).toThrow(DaemonAlreadyRunningError);
  });

  it("admits exactly one of eight synchronized processes", async () => {
    const contenders = Array.from({ length: 8 }, () => launch(`
      import { acquireDaemonLock } from ${JSON.stringify(moduleUrl)};
      console.log('ready');
      process.stdin.once('data', () => {
        try {
          globalThis.releaseOwnership = acquireDaemonLock(${JSON.stringify(pidFile)});
          console.log('owned');
        } catch (error) {
          console.log(error.name === 'DaemonAlreadyRunningError' ? 'blocked' : 'error:' + error.message);
        }
        setInterval(() => {}, 60_000);
      });
    `));
    expect(await Promise.all(contenders.map((entry) => entry.nextLine()))).toEqual(Array(8).fill("ready"));
    for (const entry of contenders) entry.child.stdin?.write("go\n");
    const outcomes = await Promise.all(contenders.map((entry) => entry.nextLine()));
    expect(outcomes.filter((outcome) => outcome === "owned")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "blocked")).toHaveLength(7);
  }, 15_000);

  it("reacquires after SIGKILL without deleting diagnostic or lock files", async () => {
    const owner = launch(ownerCode());
    expect(await owner.nextLine()).toBe("owned");
    expect(() => acquireDaemonLock(pidFile)).toThrow(DaemonAlreadyRunningError);
    const stopped = once(owner.child, "exit");
    owner.child.kill("SIGKILL");
    await stopped;
    expect(() => acquire()).not.toThrow();
  });

  it("a surviving exec child does not retain a dead parent's admission lock", async () => {
    const descendantMarker = join(fixture, "descendant.pid");
    const owner = launch(ownerCode(`
      const { spawn } = await import('node:child_process');
      const { writeFileSync } = await import('node:fs');
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
        stdio: 'ignore', detached: true,
      });
      writeFileSync(${JSON.stringify(descendantMarker)}, String(descendant.pid));
      descendant.unref();
    `));
    let descendantPid: number | undefined;
    try {
      expect(await owner.nextLine()).toBe("owned");
      descendantPid = Number(readFileSync(descendantMarker, "utf8"));
      const stopped = once(owner.child, "exit");
      owner.child.kill("SIGKILL");
      await stopped;
      expect(() => process.kill(descendantPid!, 0)).not.toThrow();
      expect(() => acquire()).not.toThrow();
    } finally {
      if (descendantPid !== undefined) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already exited */ }
      }
    }
  });
});
