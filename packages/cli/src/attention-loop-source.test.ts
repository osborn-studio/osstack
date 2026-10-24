import { mkdtemp, writeFile, rm, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
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
        reason: "owner_released", admitted: 0, wait: {owner:"human"}, state_path:"/untrusted",
      })
    );
    expect(
      await readAttentionLoop({ repo: root, path, loop_id: "l" })
    ).toMatchObject({ process_liveness: "unknown", coverage: "snapshot_only" });
    const facts = await readAttentionLoop({repo:root,path,loop_id:"l"});
    expect(facts).not.toHaveProperty("reason");
    expect(facts).not.toHaveProperty("admitted");
    expect(facts).not.toHaveProperty("state_path");
    expect(facts).toHaveProperty("wait", null);
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

const race = vi.hoisted(() => ({ swap: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: async (...args: Parameters<typeof original.open>) => {
    const swap = race.swap; race.swap = undefined; await swap?.();
    return original.open(...args);
  } };
});
it("rejects a snapshot replaced between path validation and open", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-race-"));
  try {
    const path = join(root, 'state.json'); const original = join(root, 'original.json');
    await writeFile(path, '{}');
    race.swap = async () => { await rename(path, original); await symlink(original, path); };
    await expect(readAttentionLoop({ repo: root, path, loop_id: 'l' })).rejects.toThrow();
    await rm(path); await rename(original, path);
    race.swap = async () => { await rename(path, original); await writeFile(path, '{}'); };
    await expect(readAttentionLoop({ repo: root, path, loop_id: 'l' })).rejects.toThrow('loop_source_changed');
  } finally { race.swap = undefined; await rm(root, { recursive: true, force: true }); }
});

it("honors abort before IO and after opening without reading a snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-abort-"));
  try {
    const path = join(root, "state.json");
    await writeFile(path, "{}");
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(readAttentionLoop({ repo: root, path, loop_id: "l", signal: controller.signal })).rejects.toThrow("stopped");
    const during = new AbortController();
    race.swap = async () => { during.abort(new Error("stopped during open")); };
    await expect(readAttentionLoop({ repo: root, path, loop_id: "l", signal: during.signal })).rejects.toThrow("stopped during open");
  } finally { race.swap = undefined; await rm(root, { recursive: true, force: true }); }
});

it("projects task identity only and never exposes prompts, context or evaluator inputs", async () => {
  const root=await mkdtemp(join(tmpdir(),"loop-metadata-"));
  try {
    const path=join(root,"state.json");
    const task={task_id:"task",capability:"code.write",prompt:"PRIVATE_PROMPT",source:"manual",context:{token:"PRIVATE_CONTEXT"},evaluation:[]};
    await writeFile(path,JSON.stringify({loop_id:"l",started_at:new Date().toISOString(),updated_at:new Date().toISOString(),pending:[task],in_progress:[task],completed_tasks:[]}));
    const facts=await readAttentionLoop({repo:root,path,loop_id:"l"});
    expect(facts).toMatchObject({pending:[{task_id:"task",capability:"code.write"}],in_progress:[{task_id:"task",capability:"code.write"}]});
    expect(JSON.stringify(facts)).not.toContain("PRIVATE_");
    expect(facts.pending?.[0]).not.toHaveProperty("evaluation");
  }finally{await rm(root,{recursive:true,force:true});}
});
