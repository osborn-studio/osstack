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
});
