import { describe, expect, it, vi } from "vitest";
import {
  handleSkillsCommand,
  type SkillsCommandDeps,
} from "./skills-command.js";

describe("skills command module", () => {
  it("lists tracked sources through the manifest boundary", async () => {
    const stdout = vi.fn<(line: string) => void>();
    const readManifest = vi.fn<NonNullable<SkillsCommandDeps["readManifest"]>>(() => ({
      version: 1,
      sources: [{
        id: "neat-freak",
        name: "Neat Freak",
        origin: "https://github.com/KKKKhazix/khazix-skills.git",
        ref: "main",
        subdir: ".",
        package_version: null,
        blessed_sha: "a".repeat(40),
        last_checked: null,
        auto_minor: false,
        notes: "reference skill",
      }],
    }));

    expect(await handleSkillsCommand(["list"], {
      manifestPath: () => "/repo/skills.config.yaml",
      readManifest,
      writeManifest: vi.fn(),
      checkAll: vi.fn(),
      addSource: vi.fn(),
      removeSource: vi.fn(),
      stdout,
      stderr: vi.fn(),
    })).toBe(0);

    expect(readManifest).toHaveBeenCalledWith("/repo/skills.config.yaml");
    expect(stdout.mock.calls.map(([line]) => line).join("\n")).toContain("neat-freak");
  });

  it("returns drift as an actionable exit code", async () => {
    const source = {
      id: "neat-freak",
      name: "Neat Freak",
      origin: "https://github.com/KKKKhazix/khazix-skills.git",
      ref: "main",
        subdir: ".",
        package_version: null,
      blessed_sha: "a".repeat(40),
      last_checked: null,
      auto_minor: false,
      notes: "",
    };
    const stdout = vi.fn<(line: string) => void>();

    expect(await handleSkillsCommand(["check"], {
      manifestPath: () => "/repo/skills.config.yaml",
      readManifest: () => ({ version: 1, sources: [source] }),
      writeManifest: vi.fn(),
      checkAll: vi.fn(async () => ({
        generated_at: "2026-08-03T00:00:00.000Z",
        entries: [{
          source,
          ok: true,
          current_sha: "b".repeat(40),
          drifted: true,
        }],
      })),
      addSource: vi.fn(),
      removeSource: vi.fn(),
      stdout,
      stderr: vi.fn(),
    })).toBe(2);

    expect(stdout.mock.calls.map(([line]) => line).join("\n")).toContain("1 source(s) drifted");
  });

  it("blesses the fetched head and persists the generated timestamp", async () => {
    const source = {
      id: "neat-freak",
      name: "Neat Freak",
      origin: "https://github.com/KKKKhazix/khazix-skills.git",
      ref: "main",
        subdir: ".",
        package_version: null,
      blessed_sha: null,
      last_checked: null,
      auto_minor: false,
      notes: "",
    };
    const manifest = { version: 1 as const, sources: [source] };
    const next = {
      version: 1 as const,
      sources: [{
        ...source,
        blessed_sha: "b".repeat(40),
        last_checked: "2026-08-03T00:00:00.000Z",
      }],
    };
    const addSource = vi.fn<NonNullable<SkillsCommandDeps["addSource"]>>(() => next);
    const writeManifest = vi.fn<NonNullable<SkillsCommandDeps["writeManifest"]>>();

    expect(await handleSkillsCommand(["bless", "neat-freak"], {
      manifestPath: () => "/repo/skills.config.yaml",
      readManifest: () => manifest,
      writeManifest,
      checkAll: vi.fn(async () => ({
        generated_at: "2026-08-03T00:00:00.000Z",
        entries: [{
          source,
          ok: true,
          current_sha: "b".repeat(40),
          drifted: true,
        }],
      })),
      addSource,
      removeSource: vi.fn(),
      stdout: vi.fn(),
      stderr: vi.fn(),
    })).toBe(0);

    expect(addSource).toHaveBeenCalledWith(manifest, expect.objectContaining({
      id: "neat-freak",
      blessed_sha: "b".repeat(40),
      last_checked: "2026-08-03T00:00:00.000Z",
    }));
    expect(writeManifest).toHaveBeenCalledWith(next, "/repo/skills.config.yaml");
  });

  it.each([
    { name: "missing ref", states: ["failed"], reason: "no_matching_ref", exit: 1, failed: 1, drifted: 0 },
    { name: "timeout", states: ["failed"], reason: "timeout", exit: 1, failed: 1, drifted: 0 },
    { name: "Git spawn failure", states: ["failed"], reason: "spawn_failed: missing git", exit: 1, failed: 1, drifted: 0 },
    { name: "failure before drift and healthy source", states: ["failed", "drift", "current"], reason: "no_matching_ref", exit: 1, failed: 1, drifted: 1 },
    { name: "failure after drift", states: ["drift", "failed"], reason: "timeout", exit: 1, failed: 1, drifted: 1 },
    { name: "multiple failures", states: ["failed", "failed"], reason: "no_matching_ref", exit: 1, failed: 2, drifted: 0 },
    { name: "only drift and healthy sources", states: ["drift", "current"], reason: "", exit: 2, failed: 0, drifted: 1 },
    { name: "all sources healthy", states: ["current", "current"], reason: "", exit: 0, failed: 0, drifted: 0 },
    { name: "empty manifest", states: [], reason: "", exit: 0, failed: 0, drifted: 0 },
  ])("reports separate failure and drift counts for $name", async (scenario) => {
    const entries = scenario.states.map((state, index) => ({
      source: {
        id: `source-${index}`,
        name: "",
        origin: "https://example.invalid/fixture.git",
        ref: "main",
        subdir: ".",
        package_version: null,
        blessed_sha: "a".repeat(40),
        last_checked: null,
        auto_minor: false,
        notes: "",
      },
      ok: state !== "failed",
      drifted: state === "drift",
      ...(state === "failed"
        ? { reason: scenario.reason }
        : { current_sha: (state === "drift" ? "b" : "a").repeat(40) }),
    }));
    const stdout = vi.fn<(line: string) => void>();
    const writeManifest = vi.fn();
    const exitCode = await handleSkillsCommand(["check"], {
      manifestPath: () => "/fixture/skills.config.yaml",
      readManifest: () => ({ version: 1, sources: entries.map(entry => entry.source) }),
      checkAll: async () => ({ generated_at: "2026-10-28T00:00:00.000Z", entries }),
      writeManifest,
      stdout,
      stderr: vi.fn(),
    });

    expect(exitCode).toBe(scenario.exit);
    const output = stdout.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain(`${scenario.failed} source(s) failed to check.`);
    expect(output).toContain(`${scenario.drifted} source(s) drifted from blessed_sha.`);
    for (const [index, state] of scenario.states.entries()) {
      expect(output).toContain(state === "failed"
        ? `source-${index}  unreachable: ${scenario.reason}`
        : state === "drift" ? `source-${index}  drift` : `source-${index}  up-to-date`);
    }
    expect(writeManifest).not.toHaveBeenCalled();
  });
});
