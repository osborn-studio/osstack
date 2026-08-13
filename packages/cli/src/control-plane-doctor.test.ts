import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
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
  it("warns below the autonomy write floor and alerts at the drain floor", () => {
    const { home, la } = setup();
    const low = runControlPlaneChecks({
      home,
      launchAgentsDir: la,
      lsof: () => "",
      diskFreeBytes: () => 5 * 1024 ** 3 - 1,
    });
    expect(low.find(
      (finding) => finding.check === "autonomy_disk",
    )).toMatchObject({ level: "warn" });

    const critical = runControlPlaneChecks({
      home,
      launchAgentsDir: la,
      lsof: () => "",
      diskFreeBytes: () => 2 * 1024 ** 3 - 1,
    });
    expect(critical.find(
      (finding) => finding.check === "autonomy_disk",
    )).toMatchObject({
      level: "alert",
      detail: expect.stringContaining("daemon drain required"),
    });
  });

  it("alerts on a malformed repository autonomy lock", () => {
    const { home, la } = setup();
    mkdirSync(join(home, "locks", "repos"), { recursive: true });
    writeFileSync(join(home, "locks", "repos", "broken.lock"), "not-json");

    const findings = runControlPlaneChecks({
      home,
      launchAgentsDir: la,
      lsof: () => "",
      diskFreeBytes: () => 20 * 1024 ** 3,
    });

    expect(findings.find(
      (finding) => finding.check === "autonomy_repo_locks",
    )).toMatchObject({ level: "alert" });
  });

  it("alerts on an unknown DB holder + multiple attachments", () => {
    const { home, la } = setup();
    writeFileSync(join(home, "daemon.pid"), "100");
    const f = runControlPlaneChecks({ home, launchAgentsDir: la, lsof: () => "100\n666\n",  diskFreeBytes: () => 20 * 1024 ** 3 });
    expect(f.find((x) => x.check === "db_writers")?.level).toBe("alert");
    expect(f.find((x) => x.check === "multi_daemon")?.level).toBe("alert");
    expect(renderControlPlaneFindings(f).exitCode).toBe(1);
  });

  it("ok when only the recorded daemon holds the DB and labels are known", () => {
    const { home, la } = setup();
    writeFileSync(join(home, "daemon.pid"), "100");
    writeFileSync(join(la, "ai.osstack.daemon.plist"), "<plist>osstack</plist>");
    const f = runControlPlaneChecks({ home, launchAgentsDir: la, lsof: () => "100\n",  diskFreeBytes: () => 20 * 1024 ** 3 });
    expect(f.filter((x) => x.level === "alert")).toHaveLength(0);
  });

  it("alerts on an UNKNOWN osstack LaunchAgent label", () => {
    const { home, la } = setup();
    writeFileSync(join(la, "com.rogue.osstack-starter.plist"), "<plist>runs osstack serve</plist>");
    const f = runControlPlaneChecks({ home, launchAgentsDir: la, lsof: () => "",  diskFreeBytes: () => 20 * 1024 ** 3 });
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

describe("plist content drift (Phase 2.1-C)", () => {
  function setup2() {
    const r = mkdtempSync(join(tmpdir(), "cpd-p21-"));
    const home = join(r, "home"); const la = join(r, "la");
    mkdirSync(home); mkdirSync(la);
    return { r, home, la };
  }
  const { createHash } = require("node:crypto") as typeof import("node:crypto");

  it("alerts when the daemon plist differs from the recorded baseline (failure reproduction of 2026-07-19 rewrite)", () => {
    const { r, home, la } = setup2();
    const plist = join(r, "d.plist");
    writeFileSync(plist, "<plist>original osstack daemon</plist>");
    writeFileSync(join(home, "plist.sha256.baseline"), createHash("sha256").update("<plist>original osstack daemon</plist>").digest("hex"));
    writeFileSync(plist, "<plist>REWRITTEN by unknown process</plist>");
    const f = runControlPlaneChecks({ home, launchAgentsDir: la, lsof: () => "", daemonPlistPath: plist,  diskFreeBytes: () => 20 * 1024 ** 3 });
    expect(f.find((x) => x.check === "plist_drift")?.level).toBe("alert");
  });

  it("ok when plist matches baseline; warn when no baseline", () => {
    const { r, home, la } = setup2();
    const plist = join(r, "d.plist");
    writeFileSync(plist, "<plist>x</plist>");
    writeFileSync(join(home, "plist.sha256.baseline"), createHash("sha256").update("<plist>x</plist>").digest("hex"));
    expect(runControlPlaneChecks({ home, launchAgentsDir: la, lsof: () => "", daemonPlistPath: plist,  diskFreeBytes: () => 20 * 1024 ** 3 }).find((x) => x.check === "plist_drift")?.level).toBe("ok");
    rmSync(join(home, "plist.sha256.baseline"));
    expect(runControlPlaneChecks({ home, launchAgentsDir: la, lsof: () => "", daemonPlistPath: plist,  diskFreeBytes: () => 20 * 1024 ** 3 }).find((x) => x.check === "plist_drift")?.level).toBe("warn");
  });
});
