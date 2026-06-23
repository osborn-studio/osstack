import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-contracts-cli-"));
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

describe("contracts CLI", () => {
  it("checks workspace contract alignment as JSON", async () => {
    await writeContractWorkspace({ backendPost: true });

    const exitCode = await main(["contracts", "check", "--workspace", tmp, "--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      kind: "osstack.contract_validation",
      status: "pass",
      service: "demo",
      endpoints: 2,
      findings: [],
    });
    expect(errors).toEqual([]);
  });

  it("returns exit code 2 when a frontend call has no backend route", async () => {
    await writeContractWorkspace({ backendPost: false });

    const exitCode = await main(["contracts", "check", "--workspace", tmp, "--json"]);

    expect(exitCode).toBe(2);
    const result = JSON.parse(logs.join("\n")) as {
      status: string;
      findings: Array<{ rule_id: string; method: string; path: string }>;
    };
    expect(result.status).toBe("fail");
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule_id: "contract.missing_backend", method: "POST", path: "/api/users" }),
    ]));
  });
});

async function writeContractWorkspace(options: { backendPost: boolean }): Promise<void> {
  await mkdir(join(tmp, "src"), { recursive: true });
  await writeFile(join(tmp, "osstack.contracts.json"), JSON.stringify({
    schema_version: 1,
    kind: "osstack.contract_manifest",
    service: "demo",
    endpoints: [
      { id: "get-users", method: "GET", path: "/api/users" },
      { id: "create-users", method: "POST", path: "/api/users" },
    ],
  }, null, 2));
  await writeFile(join(tmp, "src", "client.ts"), `
    await fetch("/api/users");
    await fetch("/api/users", { method: "POST" });
  `);
  await writeFile(join(tmp, "src", "server.ts"), `
    router.get("/api/users", handler);
    ${options.backendPost ? "router.post(\"/api/users\", handler);" : ""}
  `);
}
