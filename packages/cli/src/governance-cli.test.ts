import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-governance-cli-"));
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

describe("governance CLI", () => {
  it("scans files and returns findings as JSON", async () => {
    const path = join(tmp, "unsafe.ts");
    await writeFile(path, "const api_key = \"sk-1234567890\";\nconsole.log('debug');\n");

    const exitCode = await main(["governance", "scan", path, "--json"]);

    expect(exitCode).toBe(2);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      findings: Array<{ rule_id: string; file: string }>;
    };
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule_id: "secret.api_key", file: path }),
      expect.objectContaining({ rule_id: "ts.console_spam", file: path }),
    ]));
  });

  it("passes clean files", async () => {
    const path = join(tmp, "safe.ts");
    await writeFile(path, "export const value: string = 'ok';\n");

    const exitCode = await main(["governance", "scan", path, "--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ ok: true, findings: [] });
    expect(errors).toEqual([]);
  });
});
