import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCommandResult } from "@osstack/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let stdout: string[];
let stderr: string[];
let oldLanguage: string | undefined;

beforeEach(() => {
  stdout = [];
  stderr = [];
  oldLanguage = process.env["OSSTACK_LANG"];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    stdout.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    stderr.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  if (oldLanguage === undefined) delete process.env["OSSTACK_LANG"];
  else process.env["OSSTACK_LANG"] = oldLanguage;
  vi.restoreAllMocks();
});

describe("top-level neat CLI", () => {
  it("dispatches a read-only all-mode check through main", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-main-"));
    try {
      const exitCode = await main([
        "neat",
        "--repo",
        repoRoot,
        "--all",
        "--json",
      ]);

      expect(exitCode).toBe(0);
      expect(AgentCommandResult.parse(JSON.parse(stdout.join("\n"))))
        .toMatchObject({
          status: "ok",
          result: { command: "knowledge_hygiene.check" },
        });
      expect(stderr).toEqual([]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it("documents check, trend, and opt-in proposal flags in neat help", async () => {
    const exitCode = await main(["neat", "--help"]);
    const output = stdout.join("\n");

    expect(exitCode).toBe(0);
    expect(output).toContain("osstack neat check [options]");
    expect(output).toContain("osstack neat semantic [semantic options]");
    expect(output).toContain("osstack neat memory <plan|approve|apply|recover>");
    expect(output).toContain("osstack neat narrative <plan|approve|apply|recover>");
    expect(output).toContain("--fail-on <error|warning|none>");
    expect(output).toContain("--adapter <claude-code>");
    expect(output).toContain("osstack neat trend [trend options]");
    expect(output).toContain("osstack neat propose [proposal options]");
    expect(output).toContain("--min-occurrences <n>");
    expect(output).toContain("--yes");
    expect(output).not.toContain("--apply");
    expect(output).not.toContain("reviewed_no_change");
  });

  it("lists neat in English and Chinese top-level help", async () => {
    await main(["--help"]);
    expect(stdout.join("\n")).toContain("neat check");

    stdout = [];
    process.env["OSSTACK_LANG"] = "zh-CN";
    await main(["--help"]);
    expect(stdout.join("\n")).toContain("neat check");
  });
});
