import { expect, it, vi } from "vitest";
import { handleDecisionsCommand } from "./command.js";

it("sends only read RPC parameters and prints the JSON page", async () => {
  const result = { items: [], failures: [], next_cursor: null };
  const rpc = vi.fn().mockResolvedValue({ ok: true, result }); const stdout = vi.fn();
  expect(await handleDecisionsCommand(["list", "--scope", "a".repeat(64), "--limit", "2", "--json"], { rpc, stdout, credential: () => "c".repeat(32) })).toBe(0);
  expect(rpc).toHaveBeenCalledWith("decisions.list", { scope_id: "a".repeat(64), limit: 2, credential: "c".repeat(32) });
  expect(JSON.parse(stdout.mock.calls[0]![0])).toEqual(result);
});
it("rejects invalid flags before calling the daemon", async () => {
  const rpc = vi.fn();
  expect(await handleDecisionsCommand(["list", "--limit", "101"], { rpc, stderr: () => {} })).toBe(1);
  expect(rpc).not.toHaveBeenCalled();
});
it("can list local sources without an engineering credential", async () => {
  const rpc = vi.fn().mockResolvedValue({ ok: true, result: { items: [], failures: [{ source: "ci_repair", code: "permission_denied" }], next_cursor: null } });
  const stdout = vi.fn();
  expect(await handleDecisionsCommand(["list"], { rpc, stdout, credential: () => undefined })).toBe(0);
  expect(rpc).toHaveBeenCalledWith("decisions.list", { limit: 50 });
  expect(stdout.mock.calls.map(c => c[0]).join("\n")).toContain("permission_denied");
});
