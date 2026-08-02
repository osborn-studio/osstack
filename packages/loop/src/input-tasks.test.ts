import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LoopEngine } from "./loop-engine.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory !== undefined) {
    await rm(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe("LoopEngine exact input tasks", () => {
  it("executes only the supplied task without scanning an ambient queue", async () => {
    directory = mkdtempSync(join(tmpdir(), "osstack-loop-input-"));
    const engine = new LoopEngine({
      workspacePath: directory,
      sources: [],
      inputTasks: [{
        task_id: "guarded-task",
        capability: "code.write",
        prompt: "write the guarded marker",
        priority: 50,
        source: "manual",
      }],
      executeCommand:
        "node -e \"require('fs').writeFileSync('guarded.txt','ok')\"",
      verifyCommands: [
        "node -e \"process.exit(require('fs').existsSync('guarded.txt') ? 0 : 1)\"",
      ],
    });

    const result = await engine.runOnce();

    expect(result.completedTasks).toEqual([
      expect.objectContaining({
        task_id: "guarded-task",
        outcome: "success",
      }),
    ]);
    await expect(readFile(join(directory, "guarded.txt"), "utf8"))
      .resolves.toBe("ok");
  });
});
