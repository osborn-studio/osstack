import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { LoopState } from "@osstack/loop";
/** No replay or cleanup port. A Loop JSON file is a lossy snapshot source. */
export async function readAttentionLoop(input: {
  repo: string;
  path: string;
  loop_id: string;
  signal?: AbortSignal;
}) {
  input.signal?.throwIfAborted();
  if (!isAbsolute(input.path) || !isAbsolute(input.repo) || !input.loop_id || input.loop_id.length>256 || input.path.length>4096)
    throw new Error("explicit_loop_binding_required");
  const repo = await realpath(input.repo);
  input.signal?.throwIfAborted();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const path = await realpath(input.path);
    input.signal?.throwIfAborted();
    const rel = relative(repo, path);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      throw new Error("loop_outside_scope");
    const before = await lstat(path);
    input.signal?.throwIfAborted();
    if (!before.isFile())
      throw new Error("regular_loop_file_required");
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    input.signal?.throwIfAborted();
    const stat = await handle.stat();
    input.signal?.throwIfAborted();
    const resolvedAfterOpen = await realpath(path);
    input.signal?.throwIfAborted();
    if (resolvedAfterOpen !== path || before.dev !== stat.dev || before.ino !== stat.ino)
      throw new Error("loop_source_changed");
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("unsupported_loop_source");
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    input.signal?.throwIfAborted();
    if (bytesRead > 1024 * 1024) throw new Error("oversized_loop_source");
    const state = LoopState.parse(
      JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"))
    );
    if (state.loop_id !== input.loop_id)
      throw new Error("loop_identity_conflict");
    const tasks=[...(state.pending??[]),...(state.in_progress??[])];
    if((state.pending?.length??0)>16||(state.in_progress?.length??0)>16||state.updated_at.length>64||tasks.some(task=>task.task_id.length>128||task.capability.length>64))throw Error("oversized_loop_source");
    const facts = {
      loop_id: input.loop_id,
      path,
      state: "snapshot_available",
      updated_at: state.updated_at,
      in_progress: (state.in_progress ?? []).map(task => ({ task_id: task.task_id, capability: task.capability })),
      pending: (state.pending ?? []).map(task => ({ task_id: task.task_id, capability: task.capability })),
      completed_count: state.completed_tasks.length,
      wait: state.wait_reason ?? null,
      process_liveness: "unknown",
      coverage: "snapshot_only",
      gap: "best_effort_snapshot_no_event_replay",
      recovery_required: (state.in_progress ?? []).length > 0,
    };
    if(Buffer.byteLength(JSON.stringify(facts))>8192)throw Error("oversized_loop_source");
    return facts;
  } catch (error) {
    input.signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        loop_id: input.loop_id,
        path: input.path,
        state: "source_missing",
        process_liveness: "unknown",
        coverage: "uncovered",
        gap: "source_missing",
      };
    throw error;
  } finally {
    await handle?.close();
  }
}
