import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readAttentionLoop } from "./attention-loop-source.js";
it("binds exact loop identity and never treats in-progress snapshots as live owners", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-source-"));
  try {
    const path = join(root, "state.json");
    await writeFile(
      path,
      JSON.stringify({
        loop_id: "l",
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        completed_tasks: [],
        pending: [],
        in_progress: [],
        decisions: [],
      })
    );
    expect(
      await readAttentionLoop({ repo: root, path, loop_id: "l" })
    ).toMatchObject({ process_liveness: "unknown", coverage: "snapshot_only" });
    await expect(
      readAttentionLoop({ repo: root, path, loop_id: "other" })
    ).rejects.toThrow("identity");
    expect(
      await readAttentionLoop({
        repo: root,
        path: join(root, "missing"),
        loop_id: "l",
      })
    ).toMatchObject({ state: "source_missing" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
