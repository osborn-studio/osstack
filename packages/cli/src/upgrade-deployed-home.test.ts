import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alignEnvWithDeployment, resolveDeployedHome } from "./upgrade.js";

// Incident 2026-08-12 (0.16.1 → 0.17.0): `osstack upgrade` run from a shell
// without the daemon's env re-provisioned the control-plane role file for
// ~/.osstack while the launchd plist serves ~/.osstack-stable — the guard
// then refused every boot, including the rollback's. These tests pin the
// deployed-home resolution priority: plist → existing role file → env.

const PLIST_WITH_HOME = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OSSTACK_HOME</key>
    <string>/Users/example/.osstack-stable</string>
    <key>OSSTACK_SOCKET</key>
    <string>/Users/example/.osstack-stable/daemon.sock</string>
  </dict>
</dict></plist>`;

let tmp: string;
let npmRoot: string;
let oldHome: string | undefined;
let oldSocket: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-deployed-home-"));
  npmRoot = join(tmp, "npm-root");
  oldHome = process.env["OSSTACK_HOME"];
  oldSocket = process.env["OSSTACK_SOCKET"];
  delete process.env["OSSTACK_HOME"];
  delete process.env["OSSTACK_SOCKET"];
});

afterEach(async () => {
  if (oldHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = oldHome;
  if (oldSocket === undefined) delete process.env["OSSTACK_SOCKET"];
  else process.env["OSSTACK_SOCKET"] = oldSocket;
  await rm(tmp, { recursive: true, force: true });
});

function writeRoleFile(home: string): void {
  const dist = join(npmRoot, "@osstack", "cli", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "control-plane.json"), JSON.stringify({
    role: "stable-serving",
    allowed_osstack_homes: [home],
    schema: { min: 22, max: 22 },
  }));
}

describe("resolveDeployedHome", () => {
  it("prefers the launchd plist env over role file and caller env", () => {
    writeRoleFile("~/.osstack");
    process.env["OSSTACK_HOME"] = "/somewhere/else";
    const r = resolveDeployedHome(PLIST_WITH_HOME, npmRoot);
    expect(r).toEqual({ home: "/Users/example/.osstack-stable", source: "launchd plist" });
  });

  it("falls back to the existing role file when there is no plist home", () => {
    writeRoleFile("~/.osstack-stable");
    const r = resolveDeployedHome(null, npmRoot);
    expect(r).toEqual({ home: "~/.osstack-stable", source: "existing role file" });
  });

  it("falls back to caller env, then the default, when neither exists", () => {
    process.env["OSSTACK_HOME"] = "/env/home";
    expect(resolveDeployedHome(null, npmRoot)).toEqual({ home: "/env/home", source: "environment" });
    delete process.env["OSSTACK_HOME"];
    expect(resolveDeployedHome(null, null)).toEqual({ home: "~/.osstack", source: "environment" });
  });

  it("treats an unreadable role file as absent", () => {
    const dist = join(npmRoot, "@osstack", "cli", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "control-plane.json"), "not json");
    expect(resolveDeployedHome(null, npmRoot).source).toBe("environment");
  });
});

describe("alignEnvWithDeployment", () => {
  it("points OSSTACK_HOME and OSSTACK_SOCKET at the deployment", () => {
    alignEnvWithDeployment(PLIST_WITH_HOME, npmRoot);
    expect(process.env["OSSTACK_HOME"]).toBe("/Users/example/.osstack-stable");
    expect(process.env["OSSTACK_SOCKET"]).toBe("/Users/example/.osstack-stable/daemon.sock");
  });

  it("overrides a mismatched caller env (the incident shape)", () => {
    process.env["OSSTACK_HOME"] = "/Users/example/.osstack";
    alignEnvWithDeployment(PLIST_WITH_HOME, npmRoot);
    expect(process.env["OSSTACK_HOME"]).toBe("/Users/example/.osstack-stable");
  });

  it("expands a tilde-prefixed role-file home to an absolute path", () => {
    // Role files may carry literal "~/..." entries (the pre-fix upgrade code
    // wrote exactly that). osstackHome()/resolveSocketPath() do no expansion,
    // so a raw assignment would derive relative paths and a literal ./~ dir.
    writeRoleFile("~/.osstack-stable");
    alignEnvWithDeployment(null, npmRoot);
    expect(process.env["OSSTACK_HOME"]).toBe(join(homedir(), ".osstack-stable"));
  });

  it("never overrides an explicit OSSTACK_SOCKET", () => {
    process.env["OSSTACK_SOCKET"] = "/custom/socket.sock";
    alignEnvWithDeployment(PLIST_WITH_HOME, npmRoot);
    expect(process.env["OSSTACK_SOCKET"]).toBe("/custom/socket.sock");
  });

  it("leaves env untouched when only the caller env names a home", () => {
    process.env["OSSTACK_HOME"] = "/env/home";
    alignEnvWithDeployment(null, null);
    expect(process.env["OSSTACK_HOME"]).toBe("/env/home");
    expect(process.env["OSSTACK_SOCKET"]).toBeUndefined();
  });
});
