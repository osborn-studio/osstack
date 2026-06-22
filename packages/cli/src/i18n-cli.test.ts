import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let logs: string[];
let errors: string[];
let oldLang: string | undefined;

beforeEach(() => {
  logs = [];
  errors = [];
  oldLang = process.env["OSSTACK_LANG"];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  if (oldLang === undefined) delete process.env["OSSTACK_LANG"];
  else process.env["OSSTACK_LANG"] = oldLang;
  vi.restoreAllMocks();
});

describe("CLI i18n", () => {
  it("prints English help when OSSTACK_LANG=en", async () => {
    process.env["OSSTACK_LANG"] = "en";

    const exitCode = await main(["help"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("Hermes-resident project manager agent");
    expect(output).toContain("Usage:");
    expect(output).toContain("Project commands:");
    expect(errors).toEqual([]);
  });

  it("prints Chinese help when OSSTACK_LANG=zh-CN", async () => {
    process.env["OSSTACK_LANG"] = "zh-CN";

    const exitCode = await main(["help"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("Hermes 驻留项目经理 Agent");
    expect(output).toContain("用法：");
    expect(output).toContain("项目命令：");
    expect(errors).toEqual([]);
  });
});
