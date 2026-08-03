import { describe, expect, it, vi } from "vitest";
import { handleAgentCommand, type AgentCommandDeps } from "./agent-command.js";

describe("agent command module", () => {
  it("renders an injected local agent registry without daemon access", async () => {
    const rpc = vi.fn<AgentCommandDeps["rpc"]>();
    const stdout = vi.fn<(line: string) => void>();
    const stderr = vi.fn<(line: string, detail?: string) => void>();
    const listProfiles = vi.fn<NonNullable<AgentCommandDeps["listProfiles"]>>(async () => [{
      id: "codex-cli",
      display_name: "Codex CLI",
      cost_tier: "medium",
      auth_mode: "subprocess/login-reuse",
      roles: ["coding", "reviewer"],
      capabilities: [{
        id: "codex.code.write",
        kind: "code.write",
        description: "Write code",
        cost_tier: "medium",
      }],
      available: { available: true, last_checked_at: 1 },
    }]);

    expect(await handleAgentCommand(["list", "--json"], {
      rpc,
      stateDbPath: async () => "/unused/state.db",
      listProfiles,
      stdout,
      stderr,
    })).toBe(0);

    expect(rpc).not.toHaveBeenCalled();
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      agents: [{ id: "codex-cli", roles: ["coding", "reviewer"] }],
    });
    expect(stderr).not.toHaveBeenCalled();
  });

  it("routes daemon-backed listing through agent.list", async () => {
    const rpc = vi.fn<AgentCommandDeps["rpc"]>(async () => ({
      ok: true,
      result: { agents: [] },
    }));
    const stdout = vi.fn<(line: string) => void>();

    expect(await handleAgentCommand(["list", "--daemon"], {
      rpc,
      stateDbPath: async () => "/unused/state.db",
      stdout,
    })).toBe(0);

    expect(rpc).toHaveBeenCalledWith("agent.list");
    expect(stdout).toHaveBeenCalledWith(JSON.stringify({ agents: [] }, null, 2));
  });
});
