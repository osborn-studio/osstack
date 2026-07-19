import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runControlPlaneChecks, renderControlPlaneFindings } from "./control-plane-doctor.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "cpd-"));
  const home = join(root, "home"); const la = join(root, "LaunchAgents");
  mkdirSync(home); mkdirSync(la);
  return { home, la };
}

describe("control-plane doctor (G1.3)", () => {
  it("alerts on an unknown DB holder + multiple attachments", () => {
    const { home, la } = setup();
    writeFileSync(join(home, "daemon.pid"), "100");
    const f = runControlPlaneChecks({ home, launchAgentsDir: la, lsof: () => "100\n666\n" });
    expect(f.find((x) => x.check === "db_writers")?.level).toBe("alert");
    expect(f.find((x) => x.check === "multi_daemon")?.level).toBe("alert");
    expect(renderControlPlaneFindings(f).exitCode).toBe(1);
  });

  it("ok when only the recorded daemon holds the DB and labels are known", () => {
    const { home, la } = setup();
    writeFileSync(join(home, "daemon.pid"), "100");
    writeFileSync(join(la, "ai.osstack.daemon.plist"), "<plist>osstack</plist>");
    const f = runControlPlaneChecks({ home, launchAgentsDir: la, lsof: () => "100\n" });
    expect(f.filter((x) => x.level === "alert")).toHaveLength(0);
  });

  it("alerts on an UNKNOWN osstack LaunchAgent label", () => {
    const { home, la } = setup();
    writeFileSync(join(la, "com.rogue.osstack-starter.plist"), "<plist>runs osstack serve</plist>");
    const f = runControlPlaneChecks({ home, launchAgentsDir: la, lsof: () => "" });
    expect(f.find((x) => x.check === "launch_agents")?.level).toBe("alert");
    expect(f.find((x) => x.check === "launch_agents")?.detail).toContain("com.rogue.osstack-starter");
  });
});

describe("lsof edge cases (round-3)", () => {
  it("status-1 WITH stderr diagnostics is a warning, never a pass", () => {
    const root = mkdtempSync(join(tmpdir(), "cpd3-"));
    const home = join(root, "home"); const la = join(root, "la");
    mkdirSync(home); mkdirSync(la);
    const f = runControlPlaneChecks({ home, launchAgentsDir: la, lsof: () => { const e = new Error("perm") as Error & { status: number; stdout: string; stderr: string }; e.status = 1; e.stdout = ""; e.stderr = "lsof: permission denied"; throw e; } });
    expect(f.find((x) => x.check === "db_writers")?.level).toBe("warn");
    expect(renderControlPlaneFindings(f).exitCode).not.toBe(0);
  });
});
