import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { main } from "./bin.js";

let logs: string[];
let errors: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("agent list CLI", () => {
  it("lists local agents with roles, capabilities, and auth modes", async () => {
    const exitCode = await main(["agent", "list", "--json"]);

    expect(exitCode).toBe(0);
    const output = JSON.parse(logs.join("\n")) as {
      agents: Array<{
        id: string;
        roles: string[];
        auth_mode: string;
        capabilities: Array<{ kind: string }>;
      }>;
    };
    expect(output.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "claude-cli",
        roles: expect.arrayContaining(["coding", "test-verify", "reviewer", "release/proof"]),
        auth_mode: "subprocess/login-reuse",
        capabilities: expect.arrayContaining([expect.objectContaining({ kind: "code.write" })]),
      }),
      expect.objectContaining({
        id: "codex-cli",
        roles: expect.arrayContaining(["coding", "test-verify", "reviewer", "release/proof"]),
        auth_mode: "subprocess/login-reuse",
        capabilities: expect.arrayContaining([expect.objectContaining({ kind: "code.write" })]),
      }),
      expect.objectContaining({
        id: "opencode-cli",
        roles: expect.arrayContaining(["coding", "test-verify", "reviewer", "release/proof"]),
        auth_mode: "subprocess/login-reuse",
        capabilities: expect.arrayContaining([expect.objectContaining({ kind: "code.write" })]),
      }),
      expect.objectContaining({
        id: "ds-review",
        roles: expect.arrayContaining(["reviewer"]),
        auth_mode: "local",
      }),
      expect.objectContaining({
        id: "claude-design",
        roles: expect.arrayContaining(["designer", "product/planning"]),
      }),
    ]));
  });

  it("prints a role-oriented human list", async () => {
    const exitCode = await main(["agent", "list"]);

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("codex-cli");
    expect(logs.join("\n")).toContain("roles=coding,test-verify,reviewer");
    expect(logs.join("\n")).toContain("auth_mode=subprocess/login-reuse");
    expect(errors).toEqual([]);
  });
});
