import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { classifyClaudeAttentionHook, readClaudeHookInput } from "./attention-hook.js";
const binding = {
  harness_version: "2.1.291",
  session_id: "s",
  scope_id: "scope",
  client_id: "c",
  token: "a".repeat(64),
  role: "foreground_owner" as const,
};
it("accepts observed Claude root Stop shape and ignores cancellation, worker and repeated-stop shapes", () => {
  const normal = {
    hook_event_name: "Stop",
    session_id: "s",
    stop_hook_active: false,
  };
  expect(classifyClaudeAttentionHook(normal, binding)).toBe("remind");
  for (const event of [
    { ...normal, session_id: "other" },
    { ...normal, stop_hook_active: true },
    { ...normal, agent_id: "worker" },
    { ...normal, hook_event_name: "SessionEnd", reason: "cancelled" },
  ])
    expect(classifyClaudeAttentionHook(event, binding)).toBe("ignore");
  expect(
    classifyClaudeAttentionHook(normal, {
      ...binding,
      harness_version: "unknown",
    })
  ).toBe("ignore");
});

it("bounds an unclosed hook producer and releases its input", async () => {
  const stream = new PassThrough();
  const result = readClaudeHookInput(stream, 20);
  stream.write('{"unfinished":');
  expect(await result).toBeNull();
  expect(stream.destroyed).toBe(true);
  expect(stream.listenerCount("data")).toBe(0);
});
it("counts input bytes and preserves split UTF-8 chunks", async () => {
  const stream = new PassThrough(); const result = readClaudeHookInput(stream);
  const bytes = Buffer.from('你好'); stream.write(bytes.subarray(0, 2)); stream.end(bytes.subarray(2));
  expect(await result).toBe('你好');
  const oversized = new PassThrough(); const rejected = expect(readClaudeHookInput(oversized)).rejects.toThrow('oversized_hook_input');
  oversized.write(Buffer.alloc(65537)); await rejected;
  expect(oversized.destroyed).toBe(true);
});

it("reads a private binding from its verified descriptor and rejects a symlink swap", async () => {
  const { createScratchDirSync } = await import("@osstack/core");
  const fs = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { handleClaudeAttentionHook } = await import("./attention-hook.js");
  const root = createScratchDirSync("tests", "hook-binding");
  const path = join(root, "binding.json");
  try {
    await fs.writeFile(path, JSON.stringify(binding), { mode: 0o600 });
    const rpc = vi.fn(async () => ({ ok: true, result: { reminder: "Check inbox" } }));
    const output: string[] = [];
    const input = JSON.stringify({ hook_event_name: "Stop", session_id: "s", stop_hook_active: false });
    expect(await handleClaudeAttentionHook(["claude-hook", "--binding-file", path], rpc, s => output.push(s), input)).toBe(0);
    expect(output).toEqual(['{"systemMessage":"Check inbox"}']);
    rpc.mockClear();
    bindingRace.swap = async () => { await fs.rename(path, path + ".old"); await fs.symlink(path + ".old", path); };
    await expect(handleClaudeAttentionHook(["claude-hook", "--binding-file", path], rpc, () => {}, input)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  } finally { bindingRace.swap = undefined; await fs.rm(root, { recursive: true, force: true }); }
});
const bindingRace = vi.hoisted(() => ({ swap: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: async (...args: Parameters<typeof original.open>) => {
    const swap = bindingRace.swap; bindingRace.swap = undefined; await swap?.();
    return original.open(...args);
  } };
});
