import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchRegistryVersion: vi.fn(),
  spawn: vi.fn(),
}));

// Real SQLite graph hold checks have their own integration suite. This legacy
// updater harness uses literal "known-good" bytes as its snapshot fixture.
vi.mock("./graph-upgrade-guard.js", () => ({ assertGraphUpgradeSafe: async () => {} }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("./update-check.js", () => ({
  fetchRegistryVersion: mocks.fetchRegistryVersion,
}));

import { handleUpgradeCommand } from "./upgrade.js";
import { VERSION } from "./version.js";

const versionParts = VERSION.split(".");
const TARGET_VERSION = [
  versionParts[0] ?? "0",
  versionParts[1] ?? "0",
  String(Number.parseInt(versionParts[2] ?? "0", 10) + 1),
].join(".");

let tmp: string;
let globalRoot: string;
let installedVersion: string;
let servingVersion: string | null;
let failNewHealth: boolean;
let backupPresentAtInstall: boolean;
let commands: Array<{ command: string; args: string[] }>;
let rpcMethods: string[];
let oldHome: string | undefined;
let oldLaunchAgentsDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-upgrade-"));
  globalRoot = join(tmp, "global");
  installedVersion = VERSION;
  servingVersion = VERSION;
  failNewHealth = false;
  backupPresentAtInstall = false;
  commands = [];
  rpcMethods = [];
  oldHome = process.env["OSSTACK_HOME"];
  oldLaunchAgentsDir = process.env["OSSTACK_LAUNCH_AGENTS_DIR"];
  process.env["OSSTACK_HOME"] = join(tmp, "home");
  process.env["OSSTACK_LAUNCH_AGENTS_DIR"] = join(tmp, "LaunchAgents");
  mkdirSync(join(globalRoot, "@osstack", "cli", "dist"), { recursive: true });
  writeFileSync(
    join(globalRoot, "@osstack", "cli", "dist", "bin.js"),
    "#!/usr/bin/env node\n",
  );
  mkdirSync(process.env["OSSTACK_HOME"], { recursive: true });
  writeFileSync(join(process.env["OSSTACK_HOME"], "state.db"), "known-good");
  mocks.fetchRegistryVersion.mockResolvedValue(TARGET_VERSION);
  mocks.spawn.mockImplementation(
    (command: string, args: readonly string[] = []) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
        unref: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      child.unref = vi.fn();
      const argv = [...args];
      commands.push({ command, args: argv });

      if (command === "osstack") {
        servingVersion =
          failNewHealth && installedVersion === TARGET_VERSION
            ? `${TARGET_VERSION}-unhealthy`
            : installedVersion;
        if (servingVersion === `${TARGET_VERSION}-unhealthy`) {
          writeFileSync(
            join(process.env["OSSTACK_HOME"] ?? "", "state.db"),
            "migrated-by-unhealthy-release",
          );
        }
        return child as never;
      }

      queueMicrotask(() => {
        let exitCode = 0;
        if (command === "launchctl") {
          exitCode = 1;
        } else if (command === "npm" && argv[0] === "root") {
          child.stdout.emit("data", `${globalRoot}\n`);
        } else if (command === "npm" && argv[0] === "install") {
          const spec = argv.at(-1) ?? "";
          installedVersion = spec.slice(spec.lastIndexOf("@") + 1);
          if (installedVersion === TARGET_VERSION) {
            const backupDir = join(
              process.env["OSSTACK_HOME"] ?? "",
              "backups",
            );
            backupPresentAtInstall =
              existsSync(backupDir)
              && readdirSync(backupDir).some((name) => name.endsWith(".db"));
          }
        }
        child.emit("exit", exitCode);
      });
      return child as never;
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.fetchRegistryVersion.mockReset();
  mocks.spawn.mockReset();
  if (oldHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = oldHome;
  if (oldLaunchAgentsDir === undefined) {
    delete process.env["OSSTACK_LAUNCH_AGENTS_DIR"];
  } else {
    process.env["OSSTACK_LAUNCH_AGENTS_DIR"] = oldLaunchAgentsDir;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function rpc(
  method: string,
): Promise<{ ok: boolean; result?: { version: string } }> {
  rpcMethods.push(method);
  if (method === "version") {
    if (servingVersion === null) return Promise.reject(new Error("offline"));
    return Promise.resolve({
      ok: true,
      result: { version: servingVersion },
    });
  }
  if (method === "daemon.shutdown") servingVersion = null;
  return Promise.resolve({ ok: true });
}

describe("safe self-upgrade", () => {
  it("drains and snapshots state before installing and health-checking", async () => {
    await expect(handleUpgradeCommand([], rpc)).resolves.toBe(0);

    const installIndex = commands.findIndex(
      ({ command, args }) =>
        command === "npm" && args.includes(`@osstack/cli@${TARGET_VERSION}`),
    );
    expect(rpcMethods).toContain("daemon.drain");
    expect(rpcMethods).toContain("daemon.shutdown");
    expect(backupPresentAtInstall).toBe(true);
    expect(installIndex).toBeGreaterThan(-1);
    expect(installedVersion).toBe(TARGET_VERSION);
    expect(servingVersion).toBe(TARGET_VERSION);
  });

  it("restores the previous binary and database after failed health", async () => {
    failNewHealth = true;
    vi.useFakeTimers();

    const upgrade = handleUpgradeCommand([], rpc);
    await vi.runAllTimersAsync();
    await expect(upgrade).resolves.toBe(1);

    const installs = commands
      .filter(({ command, args }) => command === "npm" && args[0] === "install")
      .map(({ args }) => args.at(-1));
    expect(installs).toEqual([
      `@osstack/cli@${TARGET_VERSION}`,
      `@osstack/cli@${VERSION}`,
    ]);
    expect(installedVersion).toBe(VERSION);
    expect(servingVersion).toBe(VERSION);
    expect(
      readFileSync(
        join(process.env["OSSTACK_HOME"] ?? "", "state.db"),
        "utf-8",
      ),
    ).toBe("known-good");
  });
});

it('does not shut down or replace the installation when graph drain is incomplete', async () => {
  const withGraphHold = async (method: string) => method === 'daemon.drain'
    ? { ok: true, result: { drained: false, graph_holds: 1 } } : rpc(method);
  await expect(handleUpgradeCommand([], withGraphHold)).resolves.toBe(1);
  expect(rpcMethods).not.toContain('daemon.shutdown');
  expect(commands.some(c => c.command === 'npm' && c.args.includes('install'))).toBe(false);
});
