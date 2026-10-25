import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScratchDirSync } from "@osstack/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDaemon, type DaemonHandles } from "./daemon.js";
import { acquireDaemonLock } from "./daemon-lock.js";
import { pidFilePath } from "./paths.js";

const cleanupFault = vi.hoisted(() => ({ enabled: false }));
vi.mock("./update-check.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./update-check.js")>();
  return {
    ...original,
    startUpdateChecker: (...args: Parameters<typeof original.startUpdateChecker>) => {
      const stop = original.startUpdateChecker(...args);
      return () => {
        stop();
        if (cleanupFault.enabled) throw new Error("injected update checker cleanup failure");
      };
    },
  };
});

let fixture: string;
let priorHome: string | undefined;
let daemon: DaemonHandles | undefined;

beforeEach(() => {
  // The worker TMPDIR is a short alias that points into the managed scratch root.
  // Keep socket paths below macOS's limit even when the scratch root is long.
  fixture = createScratchDirSync("tests", "daemon-startup-ownership", {
    OSSTACK_SCRATCH_ROOT: tmpdir(),
  });
  priorHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = join(fixture, "home");
  mkdirSync(join(fixture, "home"));
  cleanupFault.enabled = false;
});

afterEach(async () => {
  cleanupFault.enabled = false;
  await daemon?.close();
  daemon = undefined;
  if (priorHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = priorHome;
  await rm(fixture, { recursive: true, force: true });
});

describe("daemon startup and cleanup preserve ownership lifecycle", () => {
  it("releases ownership when an existing non-socket path prevents startup", async () => {
    const blockedSocket = join(fixture, "occupied.sock");
    writeFileSync(blockedSocket, "operator evidence");
    await expect(startDaemon({ socketPath: blockedSocket, adapters: [] })).rejects.toThrow("Refusing to remove non-socket");
    daemon = await startDaemon({ socketPath: join(fixture, "valid.sock"), adapters: [] });
    expect(daemon.socketPath).toBe(join(fixture, "valid.sock"));
  });

  it("releases ownership after an async listen failure even when startup cleanup throws", async () => {
    cleanupFault.enabled = true;
    await expect(startDaemon({ socketPath: join(fixture, "missing", "d.sock"), adapters: [] })).rejects.toThrow();
    cleanupFault.enabled = false;
    daemon = await startDaemon({ socketPath: join(fixture, "valid.sock"), adapters: [] });
    expect(daemon.socketPath).toBe(join(fixture, "valid.sock"));
  });

  it("completes shutdown and releases ownership even when a cleanup hook throws", async () => {
    daemon = await startDaemon({ socketPath: join(fixture, "valid.sock"), adapters: [] });
    cleanupFault.enabled = true;
    await daemon.close().catch(() => undefined);
    cleanupFault.enabled = false;
    const release = acquireDaemonLock(pidFilePath());
    release();
  });
});
