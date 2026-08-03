import { describe, expect, it, vi } from "vitest";
import { handleSessionCommand, type SessionCommandDeps } from "./session-command.js";

function commandDeps() {
  const stdout = vi.fn<(line: string) => void>();
  const stderr = vi.fn<(line: string) => void>();
  const rpc = vi.fn<SessionCommandDeps["rpc"]>(async () => ({
    ok: true,
    result: { session_id: "session_1" },
  }));
  return { deps: { rpc, stdout, stderr }, rpc, stdout, stderr };
}

describe("session command module", () => {
  it("routes list through the read-only session RPC", async () => {
    const { deps, rpc, stdout } = commandDeps();

    expect(await handleSessionCommand(["list", "--json"], deps)).toBe(0);

    expect(rpc).toHaveBeenCalledWith("session.list", undefined, 10_000);
    expect(stdout).toHaveBeenCalledWith(JSON.stringify({ session_id: "session_1" }, null, 2));
  });

  it("maps start flags to the governed session RPC contract", async () => {
    const { deps, rpc } = commandDeps();

    expect(await handleSessionCommand([
      "start",
      "--request-id", "request_1",
      "--agent", "codex",
      "--repo", "/repo",
      "--title", "Resume work",
      "--text", "Continue",
      "--json",
    ], deps)).toBe(0);

    expect(rpc).toHaveBeenCalledWith("session.start", {
      request_id: "request_1",
      agent_id: "codex",
      repo_path: "/repo",
      title: "Resume work",
      prompt: "Continue",
    }, 300_000);
  });

  it("rejects an invalid send version before contacting the daemon", async () => {
    const { deps, rpc, stderr } = commandDeps();

    expect(await handleSessionCommand([
      "send", "session_1",
      "--runtime", "codex",
      "--turn", "turn_1",
      "--message-id", "message_1",
      "--expected-version", "0",
      "--text", "Continue",
    ], deps)).toBe(1);

    expect(rpc).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      "osstack: session send requires --runtime, --turn, --message-id, --expected-version, and --text",
    );
  });
});
