import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];
let oldHome: string | undefined;
let oldLaunchAgentsDir: string | undefined;
let oldCli: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-serve-install-"));
  logs = [];
  errors = [];
  oldHome = process.env["OSSTACK_HOME"];
  oldLaunchAgentsDir = process.env["OSSTACK_LAUNCH_AGENTS_DIR"];
  oldCli = process.env["OSSTACK_CLI"];
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
  if (oldCli === undefined) delete process.env["OSSTACK_CLI"];
  else process.env["OSSTACK_CLI"] = oldCli;
  await rm(tmp, { recursive: true, force: true });
});

describe("serve launchd installer", () => {
  it("keeps packaged daemon and upgrade templates on the same stable service contract", async () => {
    const launchdDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "launchd",
    );
    const daemonTemplate = await readFile(
      join(launchdDir, "ai.osstack.daemon.plist.template"),
      "utf-8",
    );
    const upgradeTemplate = await readFile(
      join(launchdDir, "ai.osstack.autoupgrade.plist.template"),
      "utf-8",
    );
    const install = await readFile(join(launchdDir, "install.sh"), "utf-8");
    const installUpgrade = await readFile(
      join(launchdDir, "install-autoupgrade.sh"),
      "utf-8",
    );

    expect(daemonTemplate).toContain("<key>OSSTACK_AGENT_PROFILE</key>");
    expect(daemonTemplate).toContain("<key>OSSTACK_WRITE_CONCURRENCY</key>");
    expect(daemonTemplate).toContain("<key>SuccessfulExit</key>");
    expect(daemonTemplate).not.toContain("KIMI");
    expect(upgradeTemplate).toContain("<string>upgrade</string>");
    expect(upgradeTemplate).toContain("<string>--auto</string>");
    expect(upgradeTemplate).toContain("<key>OSSTACK_SOCKET</key>");
    for (const script of [install, installUpgrade]) {
      expect(script).toContain("refusing implicit development");
      expect(script).toContain("$" + "{HOME}/.local/bin");
      expect(script).not.toContain("readlink -f");
      expect(script).not.toContain("REPO_ROOT=");
    }
    expect(install).toContain("requireFromCli.resolve");
    expect(install).not.toContain("echo 11");
  });

  it("writes a LaunchAgent plist without loading it when --no-load is set", async () => {
    const binPath = join(tmp, "bin", "osstack");

    const exitCode = await main(["serve", "--install", "--no-load", "--bin", binPath, "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      label: string;
      plist_path: string;
      loaded: boolean;
      socket_path: string;
      profile: string;
      write_concurrency: number;
      read_concurrency: number;
    };
    expect(result).toMatchObject({
      label: "ai.osstack.daemon",
      plist_path: join(tmp, "LaunchAgents", "ai.osstack.daemon.plist"),
      loaded: false,
      socket_path: join(tmp, "home", "daemon.sock"),
      profile: "mac-mini",
      write_concurrency: 2,
      read_concurrency: 8,
    });
    const plist = await readFile(result.plist_path, "utf-8");
    expect(plist).toContain("<string>ai.osstack.daemon</string>");
    expect(plist).toContain(`<string>${binPath}</string>`);
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain(`<key>OSSTACK_HOME</key>\n    <string>${join(tmp, "home")}</string>`);
    expect(plist).toContain(`<key>OSSTACK_SOCKET</key>\n    <string>${join(tmp, "home", "daemon.sock")}</string>`);
    expect(plist).toContain("<key>OSSTACK_AGENT_PROFILE</key>\n    <string>mac-mini</string>");
    expect(plist).toContain("<key>OSSTACK_WRITE_CONCURRENCY</key>\n    <string>2</string>");
    expect(plist).toContain("<key>OSSTACK_READ_CONCURRENCY</key>\n    <string>8</string>");
    expect(plist).toContain("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:");
    expect(plist).toContain(`${process.env["HOME"]}/.local/bin`);
    expect(plist).toContain(`<string>${join(tmp, "home", "logs", "daemon.log")}</string>`);
    expect(plist).toContain("<key>SuccessfulExit</key>\n      <false/>");
    expect(plist).not.toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).not.toContain("KIMI");
    // Native (non-.js) binary binPath runs directly — no node interpreter.
    expect(plist).not.toContain("<string>node</string>");
  });

  it("injects PATH + node for a .js binPath (launchd PATH has no node)", async () => {
    const binPath = join(tmp, "dist", "bin.js");

    expect(await main(["serve", "--install", "--no-load", "--bin", binPath, "--json"])).toBe(0);
    const result = JSON.parse(logs.join("\n")) as { plist_path: string };
    const plist = await readFile(result.plist_path, "utf-8");
    // The shebang `#!/usr/bin/env node` fails with 127 under launchd's minimal
    // PATH. The plist extends PATH (current runtime dir first) and invokes
    // `node` by name — surviving future node upgrades — before the script.
    expect(plist).toContain(`<string>${dirname(process.execPath)}:`);
    expect(plist).toContain("<string>node</string>");
    expect(plist.indexOf("<string>node</string>")).toBeLessThan(
      plist.indexOf(`<string>${binPath}</string>`),
    );
  });

  it("renders an explicit profile and bounded concurrency and reports it from status", async () => {
    const binPath = join(tmp, "bin", "osstack");
    expect(await main([
      "serve",
      "--install",
      "--no-load",
      "--bin",
      binPath,
      "--profile",
      "mac-mini",
      "--write-concurrency",
      "3",
      "--read-concurrency",
      "7",
      "--json",
    ])).toBe(0);
    logs = [];

    expect(await main(["serve", "--status", "--no-load", "--json"])).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      installed: true,
      profile: "mac-mini",
      write_concurrency: 3,
      read_concurrency: 7,
    });
  });

  it("rejects relative binary paths and invalid concurrency", async () => {
    expect(await main([
      "serve",
      "--install",
      "--no-load",
      "--bin",
      "dist/bin.js",
    ])).toBe(1);
    expect(errors.join("\n")).toContain("absolute");
    errors = [];

    expect(await main([
      "serve",
      "--install",
      "--no-load",
      "--bin",
      join(tmp, "bin", "osstack"),
      "--write-concurrency",
      "0",
    ])).toBe(1);
    expect(errors.join("\n")).toContain("positive integer");
  });

  it("does not silently provision a default development dist as stable-serving", async () => {
    const developmentBin = join(
      tmp,
      "checkout",
      "packages",
      "cli",
      "dist",
      "bin.js",
    );
    await mkdir(dirname(developmentBin), { recursive: true });
    await writeFile(developmentBin, "#!/usr/bin/env node\n", "utf-8");
    process.env["OSSTACK_CLI"] = developmentBin;

    expect(await main([
      "serve",
      "--install",
      "--no-load",
      "--json",
    ])).toBe(78);
    expect(errors.join("\n")).toContain("development dist");

    errors = [];
    expect(await main([
      "serve",
      "--install",
      "--no-load",
      "--bin",
      developmentBin,
      "--json",
    ])).toBe(0);
    expect(errors).toEqual([]);
  });

  it("resolves an extensionless npm-shim symlink to its .js target (B1)", async () => {
    // npm global installs expose `osstack` as an extensionless symlink to
    // dist/bin.js — the interpreter decision must follow the realpath.
    const target = join(tmp, "dist", "bin.js");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "#!/usr/bin/env node\n", "utf-8");
    const shim = join(tmp, "bin", "osstack");
    await mkdir(dirname(shim), { recursive: true });
    await symlink(target, shim);

    expect(await main(["serve", "--install", "--no-load", "--bin", shim, "--json"])).toBe(0);
    const result = JSON.parse(logs.join("\n")) as { plist_path: string };
    const plist = await readFile(result.plist_path, "utf-8");
    expect(plist).toContain("<string>node</string>");
    // The plist still invokes the shim path the user asked for.
    expect(plist).toContain(`<string>${shim}</string>`);
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
