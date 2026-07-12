import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    // Native (non-.js) binary binPath: launchd runs it directly — no node
    // interpreter and no PATH override injected.
    expect(plist).not.toContain("<string>node</string>");
    expect(plist).not.toContain("<string>PATH=");
  });

  it("injects PATH + node for a .js binPath (launchd PATH has no node)", async () => {
    const binPath = join(tmp, "dist", "bin.js");

    expect(await main(["serve", "--install", "--no-load", "--bin", binPath, "--json"])).toBe(0);
    const result = JSON.parse(logs.join("\n")) as { plist_path: string };
    const plist = await readFile(result.plist_path, "utf-8");
    // The shebang `#!/usr/bin/env node` fails with 127 under launchd's minimal
    // PATH. The plist extends PATH (current runtime dir first) and invokes
    // `node` by name — surviving future node upgrades — before the script.
    expect(plist).toContain(`<string>PATH=${dirname(process.execPath)}:`);
    expect(plist).toContain("<string>node</string>");
    expect(plist.indexOf("<string>node</string>")).toBeLessThan(
      plist.indexOf(`<string>${binPath}</string>`),
    );
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
