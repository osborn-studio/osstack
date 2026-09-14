import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FifoSemaphore } from "@osstack/autonomy";
import { GovernedExecution } from "./governed-execution.js";
vi.mock("@osstack/autonomy", async importOriginal => ({
  ...await importOriginal<typeof import("@osstack/autonomy")>(),
  acquireRepoWriteLock: async () => ({ renew: async () => { throw new Error("lost lease"); }, release: async () => {} }),
}));
it("quarantines a renewal failure without disabling unrelated reads or unused write capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "lease-fault-"));
  const one = join(root, "one"); const two = join(root, "two");
  for (const path of [one, two]) execFileSync("git", ["init", path], { stdio: "ignore" });
  vi.useFakeTimers();
  try {
    const writes = new FifoSemaphore(2);
    const service = new GovernedExecution({ reads: new FifoSemaphore(1), writes, repositories: new Map(), checkHealth: async () => {} });
    const broken = await service.acquire({ kind: "write", runId: "broken", workspacePath: one });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(broken.release()).rejects.toThrow("unconfirmed");
    await expect(service.acquire({ kind: "write", runId: "same-repo", workspacePath: one })).rejects.toThrow("unconfirmed");
    const read = await service.acquire({ kind: "read", runId: "read" }); await read.release();
    const write = await service.acquire({ kind: "write", runId: "other-repo", workspacePath: two }); await write.release();
    expect(writes.in_use).toBe(1); // Unknown producer remains charged to capacity.
  } finally { vi.useRealTimers(); await rm(root, { recursive: true, force: true }); }
});
