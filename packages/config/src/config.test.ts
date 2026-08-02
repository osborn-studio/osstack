import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configExists,
  configPath,
  defaultConfig,
  loadConfig,
  saveConfig,
  selectProfile,
} from "./config.js";

describe("defaultConfig", () => {
  it("is internally valid and ships both machine profiles", () => {
    const cfg = defaultConfig();
    expect(cfg.version).toBe(1);
    expect(cfg.active_profile).toBe("auto");
    expect(cfg.agent_runtime).toEqual({});
    expect(Object.keys(cfg.profiles).sort()).toEqual(["mac-mini", "macbook-pro"]);
    expect(cfg.defaults.roles.coding.primary).toBe("claude-code");
    expect(cfg.profiles["macbook-pro"]!.roles.coding.primary).toBe("codex-cli");
    expect(cfg.profiles["mac-mini"]!.roles["test-verify"]).toEqual({
      primary: "kimi-code",
      fallback: ["codex-cli", "claude-cli"],
    });
    expect(cfg.profiles["macbook-pro"]!.roles["test-verify"]).toEqual({
      primary: "kimi-code",
      fallback: ["claude-code", "codex-cli"],
    });
    expect(cfg.defaults.roles["test-verify"]).toEqual({
      primary: "kimi-code",
      fallback: ["codex-cli", "claude-cli"],
    });
    expect(cfg.profiles["mac-mini"]!.roles.design.fallback).toContain("google-stitch");
    expect(Object.values(cfg.profiles).every(
      (profile) => profile.match.hostnames.length === 0,
    )).toBe(true);
  });
});

describe("selectProfile", () => {
  const cfg = defaultConfig();

  it("matches by hostname (case-insensitive)", () => {
    const withPublicFixture = structuredClone(cfg);
    withPublicFixture.profiles["mac-mini"]!.match.hostnames = [
      "build-host.local",
    ];
    const r = selectProfile(withPublicFixture, {
      hostname: "BUILD-HOST.LOCAL",
    });
    expect(r.name).toBe("mac-mini");
    expect(r.roles.coding.primary).toBe("claude-code");
  });

  it("matches by Mac hardware model hint when hostname is generic", () => {
    const r = selectProfile(cfg, { hostname: "office-box", model: "Macmini15,12" });
    expect(r.name).toBe("mac-mini");
    expect(r.reason).toContain("model");
  });

  it("honours an explicit override above hostname", () => {
    const r = selectProfile(cfg, {
      hostname: "build-host.local",
      override: "macbook-pro",
    });
    expect(r.name).toBe("macbook-pro");
    expect(r.roles.coding.primary).toBe("codex-cli");
  });

  it("honours active_profile when not auto", () => {
    const pinned = { ...cfg, active_profile: "macbook-pro" };
    const r = selectProfile(pinned, { hostname: "build-host.local" });
    expect(r.name).toBe("macbook-pro");
  });

  it("falls back to defaults when nothing matches", () => {
    const r = selectProfile(cfg, { hostname: "some-random-box" });
    expect(r.name).toBe("defaults");
    expect(r.reason).toContain("no profile matched");
  });

  it("falls back to defaults when a pinned profile is missing", () => {
    const r = selectProfile(cfg, { hostname: "x", override: "nope" });
    expect(r.name).toBe("defaults");
    expect(r.reason).toContain("not found");
  });
});

describe("save / load round-trip", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "osstack-config-"));
    process.env["OSSTACK_CONFIG"] = join(dir, "config.yaml");
  });

  afterEach(() => {
    delete process.env["OSSTACK_CONFIG"];
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns defaults (without writing) when no file exists", () => {
    expect(configExists()).toBe(false);
    const cfg = loadConfig();
    expect(cfg.profiles["mac-mini"]).toBeDefined();
    expect(configExists()).toBe(false);
  });

  it("writes YAML and reads it back identically", () => {
    const cfg = defaultConfig();
    cfg.profiles["mac-mini"]!.roles.coding.primary = "codex-cli";
    cfg.agent_runtime["kimi-code"] = {
      provider_id: "kimi",
      model_id: "kimi-code/k3",
      agent_profile: "osstack-kimi-review",
    };
    const path = saveConfig(cfg);
    expect(path).toBe(configPath());
    expect(configExists()).toBe(true);
    const back = loadConfig();
    expect(back.profiles["mac-mini"]!.roles.coding.primary).toBe("codex-cli");
    expect(back.defaults.roles.design.primary).toBe("claude-design");
    expect(back.agent_runtime["kimi-code"]).toEqual({
      provider_id: "kimi",
      model_id: "kimi-code/k3",
      agent_profile: "osstack-kimi-review",
    });
  });
});
