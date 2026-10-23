import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createScratchDirSync, openDb } from "@osstack/core";
import { afterEach, expect, it, vi } from "vitest";
import { handleWorkerViewCommand } from "./worker-view-command.js";
import { WorkerViewService } from "./worker-view-service.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function io() { return { rpc: vi.fn(async (): Promise<unknown> => { throw new Error("PRIVATE_ERROR"); }), stdout: vi.fn(), stderr: vi.fn() }; }
it("shows actual usage without contacting a daemon", async () => {
  const output = io();
  expect(await handleWorkerViewCommand(["--help"], output)).toBe(0);
  expect(output.rpc).not.toHaveBeenCalled();
  expect(output.stdout.mock.calls[0]?.[0]).toContain("worker inspect VIEW_ID");
});
it.each([
  ["cancel", "s"], ["list"], ["list", "--repo", "/repo"],
  ["list", "--repo", "/repo", "--default-tenant", "--limit", "51"],
  ["list", "--repo", "/repo", "--default-tenant", "--limit", "1.5"],
  ["list", "--repo", "/repo", "--default-tenant", "--limit", "1x"],
  ["list", "--repo", "/repo", "--default-tenant", "--json", "--json"],
  ["list", "--repo", "/repo", "--default-tenant", "--db", "/secret"],
  ["inspect", "--repo", "/repo", "--default-tenant"],
  ["inspect", "view", "--repo", "/repo", "--default-tenant", "--cursor", "cursor"],
])("rejects malformed or mutating command before RPC: %j", async (...args) => {
  const output = io();
  expect(await handleWorkerViewCommand(args, output)).toBe(1);
  expect(output.rpc).not.toHaveBeenCalled();
  expect(output.stderr).toHaveBeenCalledWith("invalid_request\n");
});
it("uses the real scoped service via injected RPC for list then inspect", async () => {
  const root = realpathSync(createScratchDirSync("tests", "worker-command"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openDb({ path: join(root, "state.db") }); cleanup.push(() => db.close());
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','PRIVATE','running',1,1); INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','codex-cli','code','execute',1)");
  db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at) VALUES('s','t','r','codex-cli',?,?,'running',1,1,1)").run("a".repeat(64), root);
  const service = new WorkerViewService(db);
  const calls: string[] = [];
  const output = { stdout: vi.fn(), stderr: vi.fn(), rpc: async (method: string, params: unknown) => { calls.push(method); return service.handle(method, params); } };
  expect(await handleWorkerViewCommand(["list", "--repo", root, "--default-tenant", "--json"], output)).toBe(0);
  const page = JSON.parse(output.stdout.mock.calls[0]![0] as string);
  expect(page.total).toBe(2);
  expect(await handleWorkerViewCommand(["inspect", page.views[0].view_id, "--repo", root, "--default-tenant"], output)).toBe(0);
  expect(calls).toEqual(["worker.list", "worker.inspect"]);
  expect(output.stdout.mock.calls[1]![0]).toContain("Graph: unsupported");
  expect(JSON.stringify(output.stdout.mock.calls)).not.toContain("PRIVATE");
  const remote = io();
  const adversarial = { ...page, scope: { ...page.scope, repo_path: "/repo\u001b]52;c;YQ==\u0007\u202e\u200f\u061c\u2060\ufeff" } };
  remote.rpc.mockResolvedValueOnce(adversarial);
  expect(await handleWorkerViewCommand(["list", "--repo", root, "--default-tenant"], remote)).toBe(0);
  expect(remote.stdout.mock.calls[0]![0]).not.toMatch(/[\u001b\u0007\p{Cf}]/u);
  remote.rpc.mockResolvedValueOnce(adversarial);
  expect(await handleWorkerViewCommand(["list", "--repo", root, "--default-tenant", "--json"], remote)).toBe(0);
  const jsonOutput = remote.stdout.mock.calls[1]![0] as string;
  expect(jsonOutput).not.toMatch(/[\u001b\u0007\p{Cf}]/u);
  expect(JSON.parse(jsonOutput).scope.repo_path).toBe(adversarial.scope.repo_path);
  remote.rpc.mockResolvedValueOnce({ ...page, views: [{ ...page.views[0], view_id: "\u001b]52;bad" }] });
  expect(await handleWorkerViewCommand(["list", "--repo", root, "--default-tenant"], remote)).toBe(1);
  expect(remote.stderr).toHaveBeenLastCalledWith("invalid_worker_response\n");
});
it("forwards valid token syntax beginning with -- rather than treating it as an option", async () => {
  const output = io();
  await handleWorkerViewCommand(["inspect", "--opaque_token", "--repo", "/repo", "--default-tenant"], output);
  expect(output.rpc).toHaveBeenLastCalledWith("worker.inspect", { repo_path: "/repo", default_tenant: true, view_id: "--opaque_token" });
  await handleWorkerViewCommand(["list", "--repo", "/repo", "--default-tenant", "--cursor", "--opaque_cursor"], output);
  expect(output.rpc).toHaveBeenLastCalledWith("worker.list", { repo_path: "/repo", default_tenant: true, cursor: "--opaque_cursor" });
});
it("never dumps remote errors or invalid responses", async () => {
  const output = io();
  const args = ["list", "--repo", "/repo", "--default-tenant", "--json"];
  expect(await handleWorkerViewCommand(args, output)).toBe(1);
  expect(output.stderr).toHaveBeenLastCalledWith("worker_request_failed\n");
  output.rpc.mockResolvedValueOnce({ views: [{ text: "PRIVATE" }] });
  expect(await handleWorkerViewCommand(args, output)).toBe(1);
  expect(output.stderr).toHaveBeenLastCalledWith("invalid_worker_response\n");
  output.rpc.mockResolvedValueOnce({ payload: "PRIVATE".repeat(20000) });
  expect(await handleWorkerViewCommand(args, output)).toBe(1);
  expect(output.stderr).toHaveBeenLastCalledWith("invalid_worker_response\n");
  expect(output.stdout).not.toHaveBeenCalled();
});
