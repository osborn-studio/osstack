import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enqueueTask } from "@osstack/loop";

// R0.5 conformance #2 — an external consumer can enqueue a task into a kernel
// file queue using ONLY @osstack/loop. The written task JSON must carry the
// cross-process Task shape (task_id, capability, prompt, source). We assert on
// the *parsed JSON fields on disk* rather than importing any protocol package —
// this documents the wire shape a second consumer would read, independent of
// any in-process type. (@osstack/protocol arrives in a later PR.)

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-conformance-task-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("Task enqueue conformance (@osstack/loop kernel consumption)", () => {
  it("writes a task file whose JSON has the cross-process Task shape", async () => {
    const { path } = await enqueueTask({
      workspacePath: tmp,
      prompt: "Conformance-check the cross-process task shape",
      capability: "code.write",
    });

    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    expect(parsed).toHaveProperty("task_id");
    expect(parsed).toHaveProperty("capability");
    expect(parsed).toHaveProperty("prompt");
    expect(parsed).toHaveProperty("source");

    expect(typeof parsed["task_id"]).toBe("string");
    expect(parsed["capability"]).toBe("code.write");
    expect(parsed["prompt"]).toBe("Conformance-check the cross-process task shape");
    expect(parsed["source"]).toBe("task_queue");
  });
});
