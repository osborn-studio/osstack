import { describe, expect, it, vi } from "vitest";
import {
  handleComplianceCommand,
  handleContractsCommand,
  handleGovernanceCommand,
} from "./assurance-command.js";

describe("assurance command module", () => {
  it.each([
    ["governance", handleGovernanceCommand, "govern check"],
    ["contracts", handleContractsCommand, "contracts check"],
    ["compliance", handleComplianceCommand, "compliance list"],
  ])("keeps %s help at the module boundary", async (_name, handler, expected) => {
    const stdout = vi.fn<(line: string) => void>();

    expect(await handler(["help"], { stdout, stderr: vi.fn() })).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining(expected));
  });
});
