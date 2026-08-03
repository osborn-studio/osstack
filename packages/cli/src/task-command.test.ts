import { describe, expect, it, vi } from "vitest";
import { handleTaskCommand, type TaskCommandDeps } from "./task-command.js";

function commandDeps() {
  const rpc = vi.fn<TaskCommandDeps["rpc"]>(async () => ({
    ok: true,
    result: { state: "completed" },
  }));
  const submit = vi.fn<TaskCommandDeps["submit"]>(async () => 0);
  const observe = vi.fn<TaskCommandDeps["observe"]>(async () => 0);
  const stdout = vi.fn<(line: string) => void>();
  const stderr = vi.fn<(line: string, detail?: string) => void>();
  return { deps: { rpc, submit, observe, stdout, stderr }, rpc, submit, observe, stdout, stderr };
}

describe("task command module", () => {
  it("maps submit routing flags and context without changing the prompt", async () => {
    const { deps, submit } = commandDeps();

    expect(await handleTaskCommand([
      "submit",
      "continue", "the", "migration",
      "--kind", "code.typescript",
      "--agent", "codex-cli",
      "--tag", "relay",
      "--max-iter", "8",
      "--repo", "/repo",
    ], deps)).toBe(0);

    expect(submit).toHaveBeenCalledWith({
      prompt: "continue the migration",
      kind: "code.typescript",
      agent_id: "codex-cli",
      context: {
        tag: "relay",
        max_iterations: 8,
        repo_path: "/repo",
      },
    });
  });

  it("routes status through the run status RPC", async () => {
    const { deps, rpc, stdout } = commandDeps();

    expect(await handleTaskCommand(["status", "run_1"], deps)).toBe(0);

    expect(rpc).toHaveBeenCalledWith("run.status", { run_id: "run_1" });
    expect(stdout).toHaveBeenCalledWith(JSON.stringify({ state: "completed" }, null, 2));
  });

  it("routes cancel through the task cancellation RPC", async () => {
    const { deps, rpc } = commandDeps();

    expect(await handleTaskCommand(["cancel", "run_1"], deps)).toBe(0);

    expect(rpc).toHaveBeenCalledWith("task.cancel", { run_id: "run_1" });
  });

  it("passes the optional sequence cursor to the observe stream", async () => {
    const { deps, observe } = commandDeps();

    expect(await handleTaskCommand(["observe", "run_1", "17"], deps)).toBe(0);

    expect(observe).toHaveBeenCalledWith("run_1", 17);
  });
});
