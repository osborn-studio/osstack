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

describe("top-level probe CLI", () => {
  it("dispatches probe help through main", async () => {
    const exitCode = await main(["probe", "--help"]);
    const output = stdout.join("\n");

    expect(exitCode).toBe(0);
    expect(output).toContain("osstack probe start --input <path|->");
    expect(output).toContain("osstack probe next --session <id>");
    expect(output).toContain("default: standard");
    expect(stderr).toEqual([]);
  });

  it("lists probe in English and Chinese top-level help", async () => {
    await main(["--help"]);
    expect(stdout.join("\n")).toContain("probe start");

    stdout = [];
    process.env["OSSTACK_LANG"] = "zh-CN";
    await main(["--help"]);
    expect(stdout.join("\n")).toContain("probe start");
  });
});
