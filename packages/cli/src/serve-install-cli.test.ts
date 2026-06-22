import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];
let oldHome: string | undefined;
let oldLaunchAgentsDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-serve-install-"));
  logs = [];
  errors = [];
  oldHome = process.env["OSSTACK_HOME"];
  oldLaunchAgentsDir = process.env["OSSTACK_LAUNCH_AGENTS_DIR"];
  process.env["OSSTACK_HOME"] = join(tmp, "home");
  process.env["OSSTACK_LAUNCH_AGENTS_DIR"] = join(tmp, "LaunchAgents");
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
  if (oldLaunchAgentsDir === undefined) delete process.env["OSSTACK_LAUNCH_AGENTS_DIR"];
  else process.env["OSSTACK_LAUNCH_AGENTS_DIR"] = oldLaunchAgentsDir;
  await rm(tmp, { recursive: true, force: true });
});

describe("serve launchd installer", () => {
  it("writes a LaunchAgent plist without loading it when --no-load is set", async () => {
    const binPath = join(tmp, "bin", "osstack");

    const exitCode = await main(["serve", "--install", "--no-load", "--bin", binPath, "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      label: string;
      plist_path: string;
      loaded: boolean;
      socket_path: string;
    };
    expect(result).toMatchObject({
      label: "ai.osstack.daemon",
      plist_path: join(tmp, "LaunchAgents", "ai.osstack.daemon.plist"),
      loaded: false,
      socket_path: join(tmp, "home", "daemon.sock"),
    });
    const plist = await readFile(result.plist_path, "utf-8");
    expect(plist).toContain("<string>ai.osstack.daemon</string>");
    expect(plist).toContain(`<string>${binPath}</string>`);
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain(`<string>OSSTACK_HOME=${join(tmp, "home")}</string>`);
  });

  it("reports installed status and uninstalls the plist without launchctl when --no-load is set", async () => {
    const binPath = join(tmp, "bin", "osstack");
    expect(await main(["serve", "--install", "--no-load", "--bin", binPath])).toBe(0);
    logs = [];

    expect(await main(["serve", "--status", "--no-load", "--json"])).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      installed: true,
      loaded: false,
      plist_path: join(tmp, "LaunchAgents", "ai.osstack.daemon.plist"),
    });
    logs = [];

    expect(await main(["serve", "--uninstall", "--no-load", "--json"])).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      installed: false,
      unloaded: false,
    });
    logs = [];

    expect(await main(["serve", "--status", "--no-load", "--json"])).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      installed: false,
      loaded: false,
    });
    expect(errors.join("\n")).toBe("");
  });
});
