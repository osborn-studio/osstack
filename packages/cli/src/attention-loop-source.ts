import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { LoopState } from "@osstack/loop";
/** No replay or cleanup port. A Loop JSON file is a lossy snapshot source. */
export async function readAttentionLoop(input: {
  repo: string;
  path: string;
  loop_id: string;
}) {
  if (!isAbsolute(input.path) || !isAbsolute(input.repo) || !input.loop_id)
    throw new Error("explicit_loop_binding_required");
  const repo = await realpath(input.repo);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const path = await realpath(input.path);
    const rel = relative(repo, path);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      throw new Error("loop_outside_scope");
    const before = await lstat(path);
    if (!before.isFile())
      throw new Error("regular_loop_file_required");
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    const resolvedAfterOpen = await realpath(path);
    if (resolvedAfterOpen !== path || before.dev !== stat.dev || before.ino !== stat.ino)
      throw new Error("loop_source_changed");
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("unsupported_loop_source");
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024 * 1024) throw new Error("oversized_loop_source");
    const state = LoopState.parse(
      JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"))
    );
    if (state.loop_id !== input.loop_id)
      throw new Error("loop_identity_conflict");
    return {
      loop_id: input.loop_id,
      path,
      state: "snapshot_available",
      updated_at: state.updated_at,
      in_progress: state.in_progress ?? [],
      pending: state.pending,
      completed_count: state.completed_tasks.length,
      wait: state.wait_reason ?? null,
      process_liveness: "unknown",
      coverage: "snapshot_only",
      gap: "best_effort_snapshot_no_event_replay",
      recovery_required: (state.in_progress ?? []).length > 0,
    };
  } catch (error) {
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
