import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoopEngine } from "@osstack/loop";

// R0.5 conformance #3 — an external consumer can run one loop iteration end to
// end using ONLY @osstack/loop, with a trivial local `node -e` execute command
// and a local verify command. NO network, NO real agent CLIs, NO osstack CLI
// product package.
// The queued-workspace fixture is replicated locally (per the R0.5 contract we
// must NOT import test helpers across packages) and mirrors the pattern in
// packages/loop/src/loop-engine.test.ts `makeQueuedWorkspace`.

async function makeQueuedWorkspace(): Promise<string> {
  const workspace = mkdtempSync(join(tmpdir(), "osstack-conformance-loop-"));
  await mkdir(join(workspace, "tasks"));
  await writeFile(
    join(workspace, "tasks", "task.json"),
    JSON.stringify({
      task_id: "task-1",
      capability: "code.test",
      prompt: "Exercise the local loop engine from an external consumer",
      priority: 80,
    }),
  );
  return workspace;
}

let workspace: string;
beforeEach(async () => {
  workspace = await makeQueuedWorkspace();
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("Loop-run conformance (@osstack/loop kernel consumption)", () => {
  it("runOnce completes a queued task and writes LOOP-STATE.json + STATE.md", async () => {
    const result = await new LoopEngine({
      loopId: "loop-conformance",
      workspacePath: workspace,
      sources: ["task_queue"],
      stateFilePath: "LOOP-STATE.json",
      executeCommand:
        "node -e \"require('fs').writeFileSync('loop-output.txt', 'ok')\"",
      verifyCommands: [
        "node -e \"process.exit(require('fs').existsSync('loop-output.txt') ? 0 : 1)\"",
      ],
      maxIterations: 1,
    }).runOnce();

    expect(result.state.completed_tasks).toEqual([
      expect.objectContaining({
        task_id: "task-1",
        outcome: "success",
      }),
    ]);

    await expect(
      readFile(join(workspace, "LOOP-STATE.json"), "utf-8"),
    ).resolves.toContain('"loop_id": "loop-conformance"');
    await expect(
      readFile(join(workspace, "STATE.md"), "utf-8"),
    ).resolves.toContain("task-1 - success");
  });
});
