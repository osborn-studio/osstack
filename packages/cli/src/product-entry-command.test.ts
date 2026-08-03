import { describe, expect, it, vi } from "vitest";
import {
  handleProductDoctorCommand,
  type ProductEntryCommandDeps,
} from "./product-entry-command.js";

describe("product entry command module", () => {
  it("combines loop and agent readiness into JSON next steps", async () => {
    const stdout = vi.fn<(line: string) => void>();
    const loopDoctor = vi.fn<ProductEntryCommandDeps["loopDoctor"]>(async (input) => ({
      ok: true,
      workspace_path: input.workspacePath,
      state_json: input.stateFilePath,
      daemon_checked: input.checkDaemon,
      socket_path: "/tmp/osstack.sock",
      checks: [{
        id: "task_queue",
        status: "ok",
        summary: "task queue ready",
      }],
    }));
    const agentDoctor = vi.fn<NonNullable<ProductEntryCommandDeps["agentDoctor"]>>(async () => ({
      total: 1,
      available: 1,
      unavailable: 0,
      by_role: { coding: ["codex-cli"] },
      profiles: [{
        id: "codex-cli",
        display_name: "Codex CLI",
        auth_mode: "subprocess/login-reuse",
        cost_tier: "medium",
        roles: ["coding"],
        available: true,
      }],
    }));

    expect(await handleProductDoctorCommand([
      "--workspace", "/repo",
      "--daemon",
      "--json",
    ], {
      loopDoctor,
      printLoopDoctor: vi.fn(),
      resolveLoopPath: (path, workspace) => `${workspace}/${path}`,
      agentDoctor,
      stdout,
    })).toBe(0);

    expect(loopDoctor).toHaveBeenCalledWith({
      workspacePath: "/repo",
      stateFilePath: "/repo/LOOP-STATE.json",
      checkDaemon: true,
    });
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      workspace: "/repo",
      agents: { available: 1, total: 1 },
      next_steps: [
        "Run queued work: osstack loop run --source task_queue --report --scorecard --proof",
        "Try routing: osstack loop run --source task_queue --auto-agent --verify \"pnpm test\"",
        "Read examples: osstack examples",
      ],
    });
  });
});
