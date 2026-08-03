import { describe, expect, it, vi } from "vitest";
import {
  handleStewardCommand,
  type StewardCommandDeps,
} from "./steward-command.js";

describe("steward command module", () => {
  it("scans an explicit repository with the bounded default policy", async () => {
    const stdout = vi.fn<(line: string) => void>();
    const scanCandidates = vi.fn<NonNullable<StewardCommandDeps["scanCandidates"]>>(
      async () => ({
        repo: "gilosbornhello/osstack",
        base: "main",
        generatedAt: "2026-08-03T00:00:00.000Z",
        candidates: [],
        prIntents: [],
      }),
    );

    expect(await handleStewardCommand([
      "scan",
      "--repo", "gilosbornhello/osstack",
      "--workspace", "/repo",
      "--json",
    ], {
      scanCandidates,
      renderReport: vi.fn(() => "unused"),
      stdout,
      stderr: vi.fn(),
    })).toBe(0);

    expect(scanCandidates).toHaveBeenCalledWith(expect.objectContaining({
      repo: "gilosbornhello/osstack",
      base: "main",
      remote: "origin",
      branchPrefixAllowlist: ["feat/", "feature/", "codex/"],
      prThreshold: 80,
      autoMergeThreshold: 90,
    }), undefined, { cwd: "/repo" });
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      repo: "gilosbornhello/osstack",
      candidates: [],
    });
  });
});
